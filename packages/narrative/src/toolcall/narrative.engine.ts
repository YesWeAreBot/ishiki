import { Service, type Context, type Logger } from "koishi";
import type {
  EngineConfig,
  FailoverConfig,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4ToolCall,
  LanguageModelV4ToolChoice,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning,
  ToolcallEngines,
} from "koishi-plugin-ishiki";
import { FailoverModel, FINISH_TOOL, SEND_MESSAGE_TOOL, ToolcallEngine, ToolcallEngineInstance } from "koishi-plugin-ishiki";

import { narrativeOptions, parseNarrativeNext, readNarrativeMarker, type NarrativeInput } from "../narrative.js";
import {
  decoderSystemPrompt,
  describeToolPolicy,
  narratorSystemPrompt,
  renderTranscript,
  replyerSystemPrompt,
  summarizerSystemPrompt,
  type NarrativeCapabilities,
  type NarrativeRoleInstructions,
} from "./narrative-prompts.js";

/**
 * Narrative toolcall engine options.
 *
 * The profile model (`settings.model`) is always the narrator. The decoder and
 * reply stage reuse it unless their own model name is configured; a configured
 * gateway group is resolved through the existing FailoverModel so a stage never
 * calls the composite profile model recursively.
 */
export interface NarrativeToolcallConfig {
  /** Language model name for the action decoder stage. Defaults to the profile model. */
  decoderModel?: string;
  /** Language model name for the reply stage. Defaults to the profile model. */
  replyModel?: string;
  narratorInstructions?: string;
  decoderInstructions?: string;
  replyerInstructions?: string;
}

declare module "koishi-plugin-ishiki" {
  interface ToolcallEngines {
    narrative: NarrativeToolcallConfig;
  }
}

export interface NarrativeModelOptions {
  /** Raw model whose capabilities/context the profile selected; also runs narration and compaction. */
  narrator: LanguageModelV4;
  /** Action decoder; defaults to `narrator`. */
  decoder?: LanguageModelV4;
  /** Final-line writer; defaults to `narrator`. */
  reply?: LanguageModelV4;
  instructions?: NarrativeRoleInstructions;
}

export type NarrativeToolcallInstanceOptions = Omit<NarrativeModelOptions, "narrator">;

interface NarrativeStageCall {
  toolCallId: string;
  toolName: string;
  input: string;
}

interface NarrativeReasoningBlock {
  id: string;
  text: string;
  providerMetadata: SharedV4ProviderMetadata;
}

interface NarrativeOutcome {
  reasoning: NarrativeReasoningBlock[];
  calls: NarrativeStageCall[];
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  warnings: SharedV4Warning[];
}

interface NarrativePromptScan {
  system: string;
  messages: LanguageModelV4Message[];
  inputIndex: number;
  input: NarrativeInput;
  summaries: Set<string>;
}

type Gateway = Pick<Context, "ishiki">["ishiki"]["gateway"];

/** Schema defaults from profile/config.ts; group candidates already carry their own breaker state. */
const DEFAULT_FAILOVER: FailoverConfig = { backoffMs: 500, failoverOn: "unavailable" };

/**
 * LanguageModelV4 wrapper that runs the stateless narrative stage pipeline for a
 * single step. All state lives in the prompt: the ContextEngine projects history
 * and the input cursor, and this wrapper turns one model call from the host into
 * narrate → (decode | reply | stop) stage calls.
 *
 * `request`/`response` are deliberately left off the results: one host call runs
 * several upstream requests (compaction, narration, decode/reply), so no single
 * upstream body or header set can honestly represent it.
 */
export class NarrativeModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "ishiki.narrative";
  readonly modelId: string;
  readonly supportedUrls: LanguageModelV4["supportedUrls"];

  private readonly narrator: LanguageModelV4;
  private readonly decoder: LanguageModelV4;
  private readonly reply: LanguageModelV4;
  private readonly instructions: NarrativeRoleInstructions;

  constructor(options: NarrativeModelOptions) {
    this.narrator = options.narrator;
    this.decoder = options.decoder ?? options.narrator;
    this.reply = options.reply ?? options.narrator;
    this.instructions = options.instructions ?? {};
    this.modelId = options.narrator.modelId;
    this.supportedUrls = options.narrator.supportedUrls;
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const outcome = await this.run(options);
    return { content: contentOf(outcome), finishReason: outcome.finishReason, usage: outcome.usage, warnings: outcome.warnings };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const outcome = await this.run(options);
    return { stream: streamOf(outcome) };
  }

  private async run(options: LanguageModelV4CallOptions): Promise<NarrativeOutcome> {
    throwIfAborted(options.abortSignal);

    const scan = scanPrompt(options.prompt);
    const tools = (options.tools ?? []).filter((tool): tool is LanguageModelV4FunctionTool => tool.type === "function");
    const surface = capabilitySurface(tools, options.toolChoice);
    if (surface.reply === undefined && surface.actions.length === 0 && surface.stop === "blocked") {
      throw new Error("narrative step has no executable intent under this step's tools/toolChoice");
    }

    const results: LanguageModelV4GenerateResult[] = [];
    const current = scan.messages.slice(scan.inputIndex);
    let summary: string | undefined;

    if (scan.input.compact !== undefined && !scan.summaries.has(scan.input.compact.throughOriginMessageId)) {
      const history = renderTranscript(scan.messages.slice(0, scan.inputIndex));
      if (history.trim().length > 0) {
        throwIfAborted(options.abortSignal);
        const target = Math.max(1, Math.floor(scan.input.compact.targetChars));
        const result = await this.narrator.doGenerate(
          stageOptions(options, [
            { role: "system", content: summarizerSystemPrompt(target) },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `# History transcript\n\n${history}\n\n# Task\nCondense this history into the compact record described in your instructions (at most ${target} characters).`,
                },
              ],
            },
          ]),
        );
        results.push(result);
        const parsed = parseStageJson(generatedText(result), "narrator compaction");
        summary = requireText(parsed.summary, "narrator compaction summary");
      }
    }

    const visible = summary === undefined ? scan.messages : current;
    const transcript = renderTranscript(visible);
    const evidence = summary === undefined ? transcript : `# Story so far (compact record)\n\n${summary}\n\n# Transcript after that record\n\n${transcript}`;

    throwIfAborted(options.abortSignal);
    const narratorResult = await this.narrator.doGenerate(
      stageOptions(options, [
        {
          role: "system",
          content: narratorSystemPrompt({
            host: scan.system,
            capabilities: surface,
            policy: describeToolPolicy(options.toolChoice),
            ...(summary === undefined ? {} : { summary }),
            ...(this.instructions.narrator === undefined ? {} : { extra: this.instructions.narrator }),
          }),
        },
        ...visible,
      ]),
    );
    results.push(narratorResult);

    const narrative = parseStageJson(generatedText(narratorResult), "narrator");
    const script = requireText(narrative.script, "narrator script");
    const next = parseNarrativeNext(narrative.next);
    const calls: NarrativeStageCall[] = [];

    if (next.kind === "reply") {
      const replyTool = surface.reply;
      if (replyTool === undefined) {
        throw new Error(`narrative chose a reply but "${SEND_MESSAGE_TOOL}" is not available under this step's tools/toolChoice`);
      }

      throwIfAborted(options.abortSignal);
      const replyResult = await this.reply.doGenerate(
        stageOptions(options, [
          {
            role: "system",
            content: replyerSystemPrompt(scan.system, this.instructions.replyer),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `# Intent\nreply — the protagonist speaks to the user now.\n\n# Passage\n${script}\n\n# Evidence\n${evidence}\n\n# Task\nWrite the exact chat lines she sends now.`,
              },
            ],
          },
        ]),
      );
      results.push(replyResult);

      const parsed = parseStageJson(generatedText(replyResult), "replyer");
      const lines = parsed.messages;
      if (!Array.isArray(lines) || lines.length === 0) throw new Error("replyer must return a non-empty messages array");
      if (!lines.every((line: unknown) => typeof line === "string" && line.trim().length > 0)) {
        throw new Error("replyer messages must be non-empty strings");
      }

      const input: Record<string, unknown> = { messages: lines };
      if (next.target !== undefined) input.target = next.target;
      if (next.mode !== undefined) input.mode = next.mode;
      if (next.continue !== undefined) input.continue = next.continue;
      assertToolInput(replyTool, input, "reply");

      calls.push({ toolCallId: narrativeToolCallId(), toolName: SEND_MESSAGE_TOOL, input: JSON.stringify(input) });
    } else if (next.kind === "action") {
      const decoderTools = surface.actions;
      if (decoderTools.length === 0) {
        throw new Error("narrative chose an action but no host function tool is executable under this step's tools/toolChoice");
      }

      throwIfAborted(options.abortSignal);
      const decoderResult = await this.decoder.doGenerate(
        stageOptions(
          options,
          [
            {
              role: "system",
              content: `${decoderSystemPrompt(this.instructions.decoder)}\n\n# Host authority\nThe following host instructions constrain the protagonist's actions. Preserve their permissions, restrictions, and factual scope; do not impersonate the protagonist or adopt another output protocol.\n\n${scan.system}`,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `# Intent\naction\n\n# Passage\n${script}\n\n# Evidence\n${evidence}\n\n# Task\nCompile this intent into host tool calls now.`,
                },
              ],
            },
          ],
          decoderTools,
          options.toolChoice,
        ),
      );
      results.push(decoderResult);

      const decoded = decoderResult.content.filter((part): part is LanguageModelV4ToolCall => part.type === "tool-call");
      if (decoded.length === 0) throw new Error("decoder produced no tool call for an action intent");
      for (const call of decoded) {
        if (call.providerExecuted === true) throw new Error(`decoder returned provider-executed tool "${call.toolName}"; the host cannot run it`);
        const tool = decoderTools.find((candidate) => candidate.name === call.toolName);
        if (tool === undefined) throw new Error(`decoder chose tool "${call.toolName}" outside this step's executable tools`);
        const input = parseToolInput(call);
        assertToolInput(tool, input, "decoder");
        calls.push({ toolCallId: narrativeToolCallId(), toolName: call.toolName, input: call.input });
      }
    } else {
      if (surface.stop === "blocked") {
        throw new Error("narrative chose stop but this step requires a tool call that stop cannot satisfy");
      }
      const finish = tools.find((tool) => tool.name === FINISH_TOOL);
      if (surface.stop === "finish" && finish !== undefined) {
        calls.push({ toolCallId: narrativeToolCallId(), toolName: FINISH_TOOL, input: "{}" });
      }
    }

    throwIfAborted(options.abortSignal);

    const reasoning: NarrativeReasoningBlock[] = [];
    if (summary !== undefined && scan.input.compact !== undefined) {
      reasoning.push({
        id: `narrative-summary-${crypto.randomUUID()}`,
        text: summary,
        providerMetadata: narrativeOptions({ kind: "summary", throughOriginMessageId: scan.input.compact.throughOriginMessageId }),
      });
    }
    reasoning.push({
      id: `narrative-script-${crypto.randomUUID()}`,
      text: script,
      providerMetadata: narrativeOptions({ kind: "delta", inputEntryIds: scan.input.inputEntryIds, next }),
    });

    return {
      reasoning,
      calls,
      finishReason: { unified: calls.length > 0 ? "tool-calls" : "stop", raw: undefined },
      usage: aggregateUsage(results),
      warnings: results.flatMap((result) => result.warnings),
    };
  }
}

/** Profile-level shared, session-free wrapper factory held by the toolcall service. */
export class NarrativeToolcallInstance extends ToolcallEngineInstance {
  constructor(private readonly options: NarrativeToolcallInstanceOptions = {}) {
    super();
  }

  protected middleware = (): undefined => undefined;

  override wrap(model: LanguageModelV4): LanguageModelV4 {
    return new NarrativeModel({ narrator: model, ...this.options });
  }
}

export class NarrativeToolcallEngine extends ToolcallEngine<"narrative"> {
  constructor(ctx: Context) {
    super(ctx, "narrative");
  }

  public [Service.invoke](config: EngineConfig<Pick<ToolcallEngines, "narrative">>): ToolcallEngineInstance {
    const options: Partial<NarrativeToolcallConfig> = config.narrative ?? {};
    const gateway = this.ctx.ishiki.gateway;
    const logger = this.ctx.ishiki.logger;
    const instructions: NarrativeRoleInstructions = {
      ...(options.narratorInstructions === undefined ? {} : { narrator: options.narratorInstructions }),
      ...(options.decoderInstructions === undefined ? {} : { decoder: options.decoderInstructions }),
      ...(options.replyerInstructions === undefined ? {} : { replyer: options.replyerInstructions }),
    };
    const instance: NarrativeToolcallInstanceOptions = { instructions };
    if (options.decoderModel !== undefined) instance.decoder = resolveStageModel(options.decoderModel, gateway, logger);
    if (options.replyModel !== undefined) instance.reply = resolveStageModel(options.replyModel, gateway, logger);
    return new NarrativeToolcallInstance(instance);
  }
}

/** Configured stage models go through the gateway; groups use the existing failover path with schema defaults. */
function resolveStageModel(name: string, gateway: Gateway, logger: Logger): LanguageModelV4 {
  return gateway.groups().includes(name) ? new FailoverModel(gateway, name, DEFAULT_FAILOVER, logger) : gateway.languageModel(name);
}

function scanPrompt(prompt: LanguageModelV4Prompt): NarrativePromptScan {
  const systems: string[] = [];
  const summaries = new Set<string>();
  let markerMessage = -1;
  let input: NarrativeInput | undefined;

  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex += 1) {
    const message = prompt[messageIndex];
    if (message.role === "system") {
      systems.push(message.content);
      continue;
    }
    for (const part of message.content) {
      const marker = readNarrativeMarker(part.providerOptions);
      if (marker === undefined) continue;
      if (marker.kind === "input") {
        if (message.role === "user" && input === undefined) {
          input = marker;
          markerMessage = messageIndex;
        }
        continue;
      }
      if (marker.kind === "summary") summaries.add(marker.throughOriginMessageId);
    }
  }

  if (input === undefined) {
    throw new Error(
      "narrative toolcall engine requires a NarrativeInput marker on a user message; select the matching narrative context engine or remove its input marker",
    );
  }

  // Split exactly at the marker message: everything before it is the stable
  // history, everything from it on is the new input and its evidence. The
  // marker part's text stays because it is the host's current-event content.
  const messages: LanguageModelV4Message[] = [];
  let inputIndex = -1;
  for (let messageIndex = 0; messageIndex < prompt.length; messageIndex += 1) {
    const message = prompt[messageIndex];
    if (message.role === "system") continue;
    if (messageIndex === markerMessage) inputIndex = messages.length;
    const stripped = stripMessage(message);
    if (stripped.role === "system" || stripped.content.length === 0) continue;
    messages.push(stripped);
  }

  return { system: systems.join("\n\n"), messages, inputIndex, input, summaries };
}

function stripProviderOptions(options: SharedV4ProviderOptions | undefined): SharedV4ProviderOptions | undefined {
  if (options === undefined || !Object.hasOwn(options, "ishiki")) return options;
  const rest: SharedV4ProviderOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== "ishiki") rest[key] = value;
  }
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function replaceProviderOptions<M extends { providerOptions?: SharedV4ProviderOptions }>(value: M, providerOptions: SharedV4ProviderOptions | undefined): M {
  return { ...value, providerOptions };
}

function stripPart<T extends { providerOptions?: SharedV4ProviderOptions }>(part: T): T {
  const providerOptions = stripProviderOptions(part.providerOptions);
  return providerOptions === part.providerOptions ? part : replaceProviderOptions(part, providerOptions);
}

/** Persisted narrative metadata is engine input, never provider input. */
function stripMessage(message: LanguageModelV4Message): LanguageModelV4Message {
  const providerOptions = stripProviderOptions(message.providerOptions);
  if (message.role === "system") return replaceProviderOptions(message, providerOptions);
  switch (message.role) {
    case "user":
      return replaceProviderOptions({ ...message, content: message.content.map(stripPart) }, providerOptions);
    case "assistant":
      return replaceProviderOptions({ ...message, content: message.content.map(stripPart) }, providerOptions);
    case "tool":
      return replaceProviderOptions({ ...message, content: message.content.map(stripPart) }, providerOptions);
    default:
      throw new Error("unsupported message role in narrative pipeline");
  }
}

function permitsTool(choice: LanguageModelV4ToolChoice | undefined, name: string): boolean {
  if (choice === undefined) return true;
  if (choice.type === "none") return false;
  if (choice.type === "tool") return choice.toolName === name;
  return true;
}

function capabilitySurface(tools: readonly LanguageModelV4FunctionTool[], choice: LanguageModelV4ToolChoice | undefined): NarrativeCapabilities {
  const type = choice?.type ?? "auto";
  const replyTool = tools.find((tool) => tool.name === SEND_MESSAGE_TOOL);
  const finishTool = tools.find((tool) => tool.name === FINISH_TOOL);
  const actions = tools.filter((tool) => tool.name !== SEND_MESSAGE_TOOL && tool.name !== FINISH_TOOL && permitsTool(choice, tool.name));

  let stop: NarrativeCapabilities["stop"] = "blocked";
  if (type === "none" || type === "auto") {
    stop = finishTool !== undefined && permitsTool(choice, FINISH_TOOL) ? "finish" : "silent";
  } else if (type === "required") {
    stop = finishTool === undefined ? "blocked" : "finish";
  } else if (type === "tool" && choice?.type === "tool" && choice.toolName === FINISH_TOOL) {
    stop = finishTool === undefined ? "blocked" : "finish";
  }

  return {
    ...(replyTool !== undefined && permitsTool(choice, SEND_MESSAGE_TOOL) ? { reply: replyTool } : {}),
    actions,
    stop,
  };
}

/**
 * Stage calls share the host call's output cap, sampling controls and abort signal.
 * Stop sequences, response formats, provider options and
 * headers stay engine-owned: each stage has its own JSON/tool protocol and a
 * different provider namespace.
 */
function stageOptions(
  source: LanguageModelV4CallOptions,
  prompt: LanguageModelV4Prompt,
  tools?: readonly LanguageModelV4FunctionTool[],
  toolChoice?: LanguageModelV4ToolChoice,
): LanguageModelV4CallOptions {
  return {
    prompt,
    responseFormat: tools === undefined ? { type: "json" } : undefined,
    ...(source.maxOutputTokens === undefined ? {} : { maxOutputTokens: source.maxOutputTokens }),
    ...(tools === undefined ? {} : { tools: [...tools] }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(source.temperature === undefined ? {} : { temperature: source.temperature }),
    ...(source.topP === undefined ? {} : { topP: source.topP }),
    ...(source.topK === undefined ? {} : { topK: source.topK }),
    ...(source.presencePenalty === undefined ? {} : { presencePenalty: source.presencePenalty }),
    ...(source.frequencyPenalty === undefined ? {} : { frequencyPenalty: source.frequencyPenalty }),
    ...(source.seed === undefined ? {} : { seed: source.seed }),
    ...(source.reasoning === undefined ? {} : { reasoning: source.reasoning }),
    abortSignal: source.abortSignal,
  };
}

function generatedText(result: LanguageModelV4GenerateResult): string {
  const texts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") texts.push(part.text);
  }
  return texts.join("");
}

function parseStageJson(text: string, stage: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    throw new Error(`${stage} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${stage} must return a JSON object`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function parseToolInput(call: LanguageModelV4ToolCall): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(call.input);
  } catch {
    throw new Error(`decoder tool "${call.toolName}" returned invalid JSON arguments`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`decoder tool "${call.toolName}" arguments must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertToolInput(tool: LanguageModelV4FunctionTool, input: Record<string, unknown>, source: string): void {
  const required: unknown[] = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const missing = required.filter((key): key is string => typeof key === "string" && input[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`${source}: tool "${tool.name}" requires ${missing.map((key) => `"${key}"`).join(", ")}`);
  }
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function aggregateUsage(results: readonly LanguageModelV4GenerateResult[]): LanguageModelV4Usage {
  const total: LanguageModelV4Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  for (const { usage } of results) {
    total.inputTokens.total = sumOptional(total.inputTokens.total, usage.inputTokens.total);
    total.inputTokens.noCache = sumOptional(total.inputTokens.noCache, usage.inputTokens.noCache);
    total.inputTokens.cacheRead = sumOptional(total.inputTokens.cacheRead, usage.inputTokens.cacheRead);
    total.inputTokens.cacheWrite = sumOptional(total.inputTokens.cacheWrite, usage.inputTokens.cacheWrite);
    total.outputTokens.total = sumOptional(total.outputTokens.total, usage.outputTokens.total);
    total.outputTokens.text = sumOptional(total.outputTokens.text, usage.outputTokens.text);
    total.outputTokens.reasoning = sumOptional(total.outputTokens.reasoning, usage.outputTokens.reasoning);
  }
  return total;
}

function contentOf(outcome: NarrativeOutcome): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = outcome.reasoning.map((block): LanguageModelV4Content => ({
    type: "reasoning",
    text: block.text,
    providerMetadata: block.providerMetadata,
  }));
  for (const call of outcome.calls) {
    content.push({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
  }
  return content;
}

function streamOf(outcome: NarrativeOutcome): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: outcome.warnings });
      for (const block of outcome.reasoning) {
        controller.enqueue({ type: "reasoning-start", id: block.id, providerMetadata: block.providerMetadata });
        controller.enqueue({ type: "reasoning-delta", id: block.id, delta: block.text, providerMetadata: block.providerMetadata });
        controller.enqueue({ type: "reasoning-end", id: block.id, providerMetadata: block.providerMetadata });
      }
      for (const call of outcome.calls) {
        controller.enqueue({ type: "tool-input-start", id: call.toolCallId, toolName: call.toolName });
        controller.enqueue({ type: "tool-input-delta", id: call.toolCallId, delta: call.input });
        controller.enqueue({ type: "tool-input-end", id: call.toolCallId });
        controller.enqueue({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
      }
      controller.enqueue({ type: "finish", usage: outcome.usage, finishReason: outcome.finishReason });
      controller.close();
    },
  });
}

function narrativeToolCallId(): string {
  return `narrative-${crypto.randomUUID()}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("The operation was aborted.", "AbortError");
}
