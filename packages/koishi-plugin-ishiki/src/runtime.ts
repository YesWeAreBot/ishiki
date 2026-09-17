import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import {
  Agent,
  AgentCustomEntry,
  AgentEvent,
  AgentEntry,
  AgentMessage,
  AgentPlugin,
  AgentStorage,
  createAgent,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  createUserMessage,
  jsonSchema,
  tool,
  ToolSet,
} from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, h, Logger, Session } from "koishi";

import { Focus, isChannelAllowed, Profile, resolveFocus } from "./profiles.js";
import type { IshikiEntry, IshikiEvent } from "./types.js";

/** How many facts `peek_channel` reads by default, and the most it will read in one call. */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

/** Used when the model declares no window: the workspace budget is half of it, this is the floor. */
const DEFAULT_WORKSPACE_TOKEN_LIMIT = 8192;
const IDLE_CHECK_INTERVAL_MS = 60_000;

interface SendMessageInput {
  inner_thought?: string;
  sid?: string;
  channel: string;
  messages: string[];
  mode?: "element" | "raw";
  continue?: boolean;
}

interface TargetInput {
  sid?: string;
  channel: string;
}

interface SwitchFocusInput extends TargetInput {
  reason?: string;
}

interface PeekChannelInput extends TargetInput {
  limit?: number;
}

/** Platform failures carry a name worth keeping: `BotNotFound` tells the model to fix the address, `Error` does not. */
function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function focusKey(focus: Focus): string {
  return `${focus.sid}:${focus.channelId}`;
}

function sidOf(fact: { platform: string; selfId: string }): string {
  return `${fact.platform}:${fact.selfId}`;
}

function sceneKeyOf(fact: IshikiEvent.MessageCreated): string {
  return `${sidOf(fact)}:${fact.channel.id}`;
}

/** `[21:40] Miaow(42) #m1: 内容` — the only line a fact ever renders to. */
function lineOf(fact: IshikiEvent.MessageCreated): string {
  const who = fact.user.name === undefined || fact.user.name.length === 0 ? fact.user.id : `${fact.user.name}(${fact.user.id})`;
  return `[${formatClock(fact.timestamp)}] ${who} #${fact.messageId}: ${fact.content}`;
}

function blockOf(element: "focus" | "awareness", sid: string, channel: { id: string; name?: string }, lines: string[], trigger?: string): string {
  const attributes = [`sid="${sid}"`, `channel="${channel.id}"`];
  if (channel.name !== undefined && channel.name.length > 0) attributes.push(`name="${channel.name}"`);
  if (trigger !== undefined) attributes.push(`trigger="${trigger}"`);
  return [`<${element} ${attributes.join(" ")}>`, ...lines, `</${element}>`].join("\n");
}

function mentionsSelf(content: string, selfId: string): boolean {
  if (!content.includes("<at")) return false;
  try {
    return h.parse(content).some((element) => element.type === "at" && element.attrs?.id === selfId);
  } catch {
    return false;
  }
}

/**
 * Why a fact from another scene is still worth showing. The first two entries mirror the wake rules, so the
 * fact that started a turn can never be invisible inside it.
 */
function hitReason(profile: Profile, fact: IshikiEvent.MessageCreated): "direct" | "atSelf" | "keyword" | undefined {
  if (fact.channel.direct) return "direct";
  if (mentionsSelf(fact.content, fact.selfId)) return "atSelf";
  if (profile.keywords.some((keyword) => keyword.length > 0 && fact.content.includes(keyword))) return "keyword";
  return undefined;
}

/** A focus block for a fact in the cursor's scene, or an awareness block when the fact still reaches us. */
function createdBlock(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageCreated): string | undefined {
  if (sceneKeyOf(fact) === focusKey(cursor)) return blockOf("focus", sidOf(fact), fact.channel, [lineOf(fact)]);
  const reason = hitReason(profile, fact);
  return reason === undefined ? undefined : blockOf("awareness", sidOf(fact), fact.channel, [lineOf(fact)], reason);
}

function deletedBlock(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageDeleted): string | undefined {
  const sid = sidOf(fact);
  const inFocus = `${sid}:${fact.channelId}` === focusKey(cursor);
  const ours = fact.operatorId !== undefined && profile.allowedChannels.some((declaration) => declaration.sid === sid);
  if (!inFocus && !ours) return undefined;
  const line = `[${formatClock(fact.timestamp)}] #${fact.messageId}: (已撤回)`;
  return inFocus ? blockOf("focus", sid, { id: fact.channelId }, [line]) : blockOf("awareness", sid, { id: fact.channelId }, [line]);
}

function changeLine(change: IshikiEntry.FocusChanged): string {
  const reason = change.reason === undefined || change.reason.length === 0 ? "" : `（${change.reason}）`;
  return `[focus change] ${focusKey(change.previous)} → ${focusKey(change.next)}${reason}`;
}

/** Keeps both ends of an oversized tool result; the middle is where the redundancy lives. */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.max(1, Math.floor(max / 2));
  return `${text.slice(0, half)}\n…[已截断 ${text.length - half * 2} 字符]…\n${text.slice(-half)}`;
}

function partsOf(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content as Array<Record<string, unknown>>;
}

function toolOutputText(content: unknown): string {
  if (typeof content === "string") return content;
  const pieces: string[] = [];
  for (const part of partsOf(content)) {
    const output = part.output as { type?: string; value?: unknown } | undefined;
    if (output === undefined) continue;
    pieces.push(typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? null));
  }
  return pieces.join("\n");
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  const pieces: string[] = [];
  for (const part of partsOf(content)) {
    if (part.type === "text") pieces.push(String(part.text ?? ""));
    else pieces.push("[附件]");
  }
  return pieces.filter((piece) => piece.length > 0).join("\n");
}

/** The generic loses the narrowing a literal type would give, so the helper owns the one cast. */
function lastEntryOfType<T extends keyof AgentCustomEntry>(entries: readonly AgentEntry[], type: T): AgentEntry<T> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === type) return entry as AgentEntry<T>;
  }
  return undefined;
}

function workspaceOf(entries: readonly AgentEntry[]): readonly AgentEntry[] {
  const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
  return checkpoint === undefined ? entries : entries.slice(entries.indexOf(checkpoint) + 1);
}

function messageEntriesOf(entries: readonly AgentEntry[]): readonly AgentEntry[] {
  return entries.filter((entry) => entry.type === "message");
}

/**
 * Pulls the assistant calls for the tool results in a selection back in, so the frame never records a result
 * whose call is missing. A tail selection can grow past its limit; that is the point.
 */
function completeToolCalls(selection: readonly AgentEntry[], workspace: readonly AgentEntry[]): readonly AgentEntry[] {
  const wanted = new Set<string>();
  for (const entry of selection) {
    if (entry.type !== "message" || entry.data.role !== "tool") continue;
    for (const part of partsOf(entry.data.content)) {
      if (typeof part.toolCallId === "string") wanted.add(part.toolCallId);
    }
  }
  if (wanted.size === 0) return selection;

  const chosen = new Set(selection.map((entry) => entry.id));
  const calls: AgentEntry[] = [];
  for (const entry of workspace) {
    if (entry.type !== "message" || entry.data.role !== "assistant" || chosen.has(entry.id)) continue;
    const matches = partsOf(entry.data.content).some((part) => part.type === "tool-call" && typeof part.toolCallId === "string" && wanted.has(part.toolCallId));
    if (matches) calls.push(entry);
  }
  return [...calls, ...selection];
}

function belongsToFocus(entry: AgentEntry, focus: Focus): boolean {
  if (entry.type !== "message") return false;
  const message = entry.data;
  if (message.role === "custom") {
    if (message.type === "ishiki.message.created") return sceneKeyOf(message.data) === focusKey(focus);
    if (message.type === "ishiki.message.deleted") return `${sidOf(message.data)}:${message.data.channelId}` === focusKey(focus);
    return false;
  }
  // The mind's own actions always happened where it was: they belong to whatever focus was live then.
  return message.role === "assistant" || message.role === "tool";
}

/**
 * The frame carries behavior and its results, never the mind's own wording: what it said is not a memory it
 * should read back and imitate.
 */
function renderEntries(entries: readonly AgentEntry[], cursor: Focus, profile: Profile, toolResultChars: number): string[] {
  const lines: string[] = [];
  const callNames = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "ishiki.checkpoint") continue;
    if (entry.type === "ishiki.focus.changed") {
      lines.push(changeLine(entry.data));
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.data;
    if (message.role === "custom") {
      const block =
        message.type === "ishiki.message.created"
          ? createdBlock(profile, cursor, message.data)
          : message.type === "ishiki.message.deleted"
            ? deletedBlock(profile, cursor, message.data)
            : undefined;
      if (block !== undefined) lines.push(block);
      continue;
    }
    if (message.role === "assistant") {
      for (const part of partsOf(message.content)) {
        if (part.type === "tool-call" && typeof part.toolCallId === "string") callNames.set(part.toolCallId, String(part.toolName ?? "tool"));
      }
      continue;
    }
    if (message.role === "tool") {
      for (const part of partsOf(message.content)) {
        const name = callNames.get(String(part.toolCallId)) ?? String(part.toolName ?? "tool");
        lines.push(`[工具结果] ${name}: ${truncateMiddle(toolOutputText([part]), toolResultChars)}`);
      }
      continue;
    }
    if (message.role === "user") {
      const text = userMessageText(message.content);
      if (text.length > 0) lines.push(truncateMiddle(text, toolResultChars));
    }
  }
  return lines;
}
export class ProfileRuntime {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly profile: Profile;
  private readonly gateway: Gateway;
  private readonly profileDataPath: string;

  private agent: Agent;
  private storage: AgentStorage;

  /**
   * The scene this mind sits in. `switch_focus` replaces it immediately (so the rest of the step addresses
   * the new scene), while its record waits for the step boundary.
   */
  private currentFocus: Focus;
  private pendingFocus: { previous: Focus; next: Focus; reason?: string } | null = null;
  private switchedThisTurn = false;
  /**
   * Raised by `finish` and by a `send_message` that does not ask to continue. `onStepFinish` runs exactly
   * once per step, so it consumes the flag and never lets it leak into the next step.
   */
  private stopRequestedThisStep = false;

  /**
   * Prompt parts, frozen until `start()` reloads them. Assembly runs every turn, so without the freeze a
   * source that re-reads or rebuilds would rewrite the model-visible prefix every turn.
   */
  private cachedInstructions: string | undefined;
  private cachedTools: ToolSet | undefined;

  /** Set by any appended entry; cleared by a successful rebuild and used to skip idle checks on a quiet mind. */
  private generationDirty = false;
  /** A trigger fired while a turn was running: run it at the turn boundary instead. */
  private rebuildPending = false;
  private rebuildChain: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  /** Workspace budget in tokens: the profile's own value, else half the window the model declares. */
  private workspaceTokenLimit = DEFAULT_WORKSPACE_TOKEN_LIMIT;

  constructor(ctx: Context, options: { profile: Profile; gateway: Gateway; profilesPath: string }) {
    this.ctx = ctx;
    this.profile = options.profile;
    this.gateway = options.gateway;
    this.logger = ctx.logger("ishiki-profile-runtime");
    this.profileDataPath = path.resolve(this.ctx.baseDir, path.dirname(options.profilesPath), this.profile.dataPath);
    if (!existsSync(this.profileDataPath)) {
      mkdirSync(this.profileDataPath, { recursive: true });
    }
    this.currentFocus = { ...this.profile.initialFocus };
    this.storage = createJsonlStorage(path.resolve(this.profileDataPath, "messages.jsonl"));

    this.agent = createAgent({
      id: this.profile.id,
      model: this.gateway.languageModel(this.profile.model),
      storage: this.storage,
      plugins: [
        {
          name: "ishiki-prompt-cache",
          extendInstructions: async () => {
            await this.loadPromptParts();
            return this.cachedInstructions;
          },
          extendTools: async () => {
            await this.loadPromptParts();
            return this.cachedTools;
          },
        } satisfies AgentPlugin,
        {
          name: "ishiki-agent-plugin",
          onAppend: (entries) => {
            this.generationDirty = true;
            return entries;
          },
          /**
           * The whole projection, in the one hook that sees entries. Everything before the last checkpoint
           * already lives inside the frame text, so this walks the current generation only and its cost
           * tracks the generation, not the history. Output is native messages: no render types, no second
           * hook to carry a cursor across.
           */
          transformEntries: (entries) => {
            const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
            const out: AgentEntry[] = [];
            if (checkpoint !== undefined) {
              out.push(createEntry("message", createUserMessage(checkpoint.data.text), { id: checkpoint.id, timestamp: checkpoint.timestamp }));
            }

            // The cursor starts where the generation started and only recorded switches move it: the live
            // focus would reinterpret messages that were already rendered.
            let cursor = checkpoint === undefined ? this.profile.initialFocus : checkpoint.data.frameFocus;
            for (const entry of workspaceOf(entries)) {
              if (entry.type === "ishiki.focus.changed") {
                cursor = { ...entry.data.next };
                out.push(createEntry("message", createUserMessage(changeLine(entry.data)), { id: entry.id, timestamp: entry.timestamp }));
                continue;
              }
              if (entry.type !== "message") continue;

              const message = entry.data;
              if (message.role !== "custom") {
                out.push(entry);
                continue;
              }
              const block =
                message.type === "ishiki.message.created"
                  ? createdBlock(this.profile, cursor, message.data)
                  : message.type === "ishiki.message.deleted"
                    ? deletedBlock(this.profile, cursor, message.data)
                    : undefined;
              if (block !== undefined) out.push(createEntry("message", createUserMessage(block), { id: message.id, timestamp: message.timestamp }));
            }
            return out;
          },
          onStepFinish: async (info) => {
            // A step boundary is the earliest moment the switch record can land: the step's assistant and
            // tool entries are already written, so the record never splits a tool call from its result.
            if (this.pendingFocus) {
              try {
                await this.agent.storage.append(createEntry("ishiki.focus.changed", this.pendingFocus, { turnId: info.turnId }));
                this.pendingFocus = null;
              } catch (error) {
                this.logger.warn(`focus change 写入失败，保留待下一次 step 边界重试：${String(error)}`);
              }
            }

            // Consume the flag: this hook runs exactly once per step, so it never leaks into the next one.
            const stop = this.stopRequestedThisStep;
            this.stopRequestedThisStep = false;
            return stop ? { continue: false } : undefined;
          },
          onTurnFinish: () => {
            this.switchedThisTurn = false;
            this.stopRequestedThisStep = false;
            if (this.generationDirty || this.rebuildPending) this.scheduleRebuild("turn-finish");
          },
        } satisfies AgentPlugin,
      ],
    });
  }

  /** Loads what the two halves of the assembly need, once per `start()`. */
  private async loadPromptParts(): Promise<void> {
    if (this.cachedInstructions === undefined) {
      const personaFile = path.resolve(this.profileDataPath, "persona.md");
      const persona = existsSync(personaFile) ? (await fs.readFile(personaFile, "utf-8")).trim() : "";
      this.cachedInstructions = [persona, this.toolGuide()].filter((part) => part.length > 0).join("\n\n");
    }
    if (this.cachedTools === undefined) this.cachedTools = this.buildTools();
  }

  /** The bodies and channels this mind can act on — the list behind every addressing parameter. */
  private toolGuide(): string {
    const bodies = this.profile.allowedChannels.map((declaration) => `  ${declaration.sid} → ${declaration.channels.join(", ")}`).join("\n");

    return [
      "工具是你在这台设备上行动的唯一途径：你的文本输出不会被任何人看到。",
      "",
      "你的身体与可发言频道（channel 的语义域是 sid）：",
      bodies,
      "",
      "send_message(channel, messages, mode?, continue?, sid?, inner_thought?)",
      "  逐条发出 messages，一条消息一句话。channel 必填；sid 省略即当前 focus 的身体。",
      '  mode="raw" 按字面发送；默认 "element"，正文中的 <at id="…"/> 等元素会被平台解析。',
      "  未把 continue 设为 true 时，本 step 结束即结束本轮。",
      "",
      "switch_focus(channel, sid?, reason?)",
      "  改变你的默认情境，不立即重建上下文；切换后本轮的后续发送默认去新场景。一轮只允许切一次。",
      "",
      "peek_channel(channel, sid?, limit?)",
      "  只读查看某频道最近消息；不改变 focus，不产生记录。",
      "",
      "finish(reason?)",
      "  结束本轮而不发言。看过消息但决定不回复时用它。",
    ].join("\n");
  }

  /**
   * The tools close over this runtime: the focus they read is the live one, so a switch made mid-step
   * already applies to the rest of that step.
   */
  private buildTools(): ToolSet {
    const requestStop = () => {
      this.stopRequestedThisStep = true;
    };

    return {
      send_message: tool({
        description: "向频道发送消息。这是消息到达平台的唯一途径——你的文本输出不会被发送，只有本工具发出的内容会被别人看到。",
        inputSchema: jsonSchema<SendMessageInput>({
          type: "object",
          properties: {
            ...(this.profile.innerThought
              ? {
                  inner_thought: {
                    type: "string",
                    description: "本次发送前的内心独白；",
                  },
                }
              : {}),
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "目标频道 ID；它的语义域由 sid 决定" },
            messages: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
              description: "要发送的消息，每一项作为一条独立消息按顺序发出",
            },
            mode: {
              type: "string",
              enum: ["element", "raw"],
              description: 'element（默认）时正文中的 <at id="…"/> 等元素会被平台解析；raw 时正文按字面发送',
            },
            continue: {
              type: "boolean",
              description: "true 时发送后继续生成；省略或 false 时发完即结束本轮",
            },
          },
          required: ["messages", "channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error, sent: [], failedAt: 0 };

          const messages = input.messages;
          if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => typeof message !== "string" || message.length === 0)) {
            return { ok: false as const, error: { name: "InvalidInput", message: "messages 必须是非空字符串数组" }, sent: [], failedAt: 0 };
          }

          const sent: string[] = [];
          const bot = this.ctx.bots[target.sid];
          if (!bot) return { ok: false as const, error: { name: "BotNotFound", message: `Bot with sid ${target.sid} not found` }, sent: [], failedAt: 0 };

          for (let index = 0; index < messages.length; index += 1) {
            try {
              const content = input.mode === "raw" ? h.escape(messages[index]) : messages[index];
              sent.push(...(await bot.sendMessage(target.channelId, content)));
            } catch (error) {
              return { ok: false as const, sent, failedAt: index, error: describeError(error) };
            }
          }

          if (input.continue !== true) requestStop();
          return { ok: true as const, target, messageIds: sent, count: sent.length };
        },
      }),
      finish: tool({
        description: "结束本轮而不发言。看过消息但决定不回复时用它。",
        inputSchema: jsonSchema<{ reason?: string }>({
          type: "object",
          properties: {
            reason: { type: "string", description: "结束原因" },
          },
          required: [],
        }),
        execute: async () => {
          requestStop();
          return { ok: true as const };
        },
      }),
      switch_focus: tool({
        description: "切换你的默认情境（focus）。切换后本轮的后续发送默认去新场景，不立即重建上下文。一轮只允许切换一次。",
        inputSchema: jsonSchema<SwitchFocusInput>({
          type: "object",
          properties: {
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "目标频道 ID" },
            reason: { type: "string", description: "切换原因" },
          },
          required: ["channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error };

          if (target.sid === this.currentFocus.sid && target.channelId === this.currentFocus.channelId) {
            return { ok: true as const, changed: false, target };
          }
          if (this.switchedThisTurn) {
            return { ok: false as const, error: { name: "FocusCooldown", message: "本轮已经切换过 focus" } };
          }

          this.pendingFocus = { previous: this.currentFocus, next: target, ...(input.reason === undefined ? {} : { reason: input.reason }) };
          this.currentFocus = target;
          this.switchedThisTurn = true;
          return { ok: true as const, changed: true, target };
        },
      }),
      peek_channel: tool({
        description: "只读查看某个频道最近的消息。不改变 focus，也不产生任何记录。",
        inputSchema: jsonSchema<PeekChannelInput>({
          type: "object",
          properties: {
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "要查看的频道 ID" },
            limit: { type: "number", description: `读取条数，默认 ${PEEK_DEFAULT_LIMIT}，上限 ${PEEK_MAX_LIMIT}` },
          },
          required: ["channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error };

          const limit = input.limit ?? PEEK_DEFAULT_LIMIT;
          if (!Number.isInteger(limit) || limit <= 0 || limit > PEEK_MAX_LIMIT) {
            return { ok: false as const, error: { name: "LimitTooLarge", message: `limit 必须是 1 到 ${PEEK_MAX_LIMIT} 之间的整数` } };
          }

          const lines: string[] = [];
          for (const entry of await this.agent.storage.read()) {
            if (entry.type !== "message") continue;
            const message = entry.data;
            if (message.role !== "custom" || message.type !== "ishiki.message.created") continue;
            const fact = message.data;
            if (sidOf(fact) !== target.sid || fact.channel.id !== target.channelId) continue;
            lines.push(lineOf(fact));
          }

          const recent = lines.slice(-limit);
          const text = [`<peek sid="${target.sid}" channel="${target.channelId}" count=${recent.length}>`, ...recent].join("\n");
          return { ok: true as const, target, count: recent.length, text };
        },
      }),
      report_tool_issue: tool({
        description: "报告工具调用问题",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            tool: { type: "string", description: "工具名称" },
            issue: { type: "string", description: "concise description of the issue" },
          },
          required: ["tool", "issue"],
        }),
        execute: async (args) => {
          await fs.appendFile(
            path.resolve(this.profileDataPath, "tool_issues.log"),
            `[${new Date().toISOString()}] Tool: ${args.tool}, Issue: ${args.issue}\n`,
          );
          return { success: true, message: "Noted, thanks" };
        },
      }),
    };
  }

  async start() {
    // Reloading eagerly surfaces a failing source here instead of inside a turn.
    this.cachedInstructions = undefined;
    this.cachedTools = undefined;
    await this.loadPromptParts();
    await this.restoreContext();
    this.resolveBudget();

    // The tools close over this runtime, so the agent has to be reachable before the first prompt assembly.
    await this.agent.init();

    this.logger.info(`Agent for profile ${this.profile.id} initialized with model ${this.profile.model}.`);

    this.agent.channel.subscribe("agent", (event: AgentEvent) => {
      this.logger.debug(`--- Agent Event ---\n${JSON.stringify(event, null, 2)}`);
    });

    this.idleTimer = setInterval(() => void this.checkIdle(), IDLE_CHECK_INTERVAL_MS);

    this.ctx.on("internal/session", async (session: Session) => {
      if (!isChannelAllowed(this.profile, session.sid, session.channelId ?? "")) return;

      this.logger.debug(`--- Session ---\n${JSON.stringify(session, null, 2)}`);

      let shouldTrigger: boolean = false;
      let message: AgentMessage | undefined;
      switch (session.type) {
        case "message-created": {
          const authorName = session.author?.name;
          const channelName = session.event?.channel?.name;
          message = createCustomMessage("ishiki.message.created", {
            content: session.content!,
            user: { id: session.userId!, ...(authorName === undefined ? {} : { name: authorName }) },
            channel: { id: session.channelId!, ...(channelName === undefined ? {} : { name: channelName }), direct: session.isDirect },
            guildId: session.guildId,
            messageId: session.messageId!,
            timestamp: session.timestamp,
            platform: session.platform,
            selfId: session.selfId,
            quote: session.quote
              ? {
                  id: session.quote.id!,
                  content: session.quote.content,
                  user: session.quote.user,
                  channel: session.quote.channel,
                  guild: session.quote.guild,
                }
              : undefined,
          });
          if (
            session.isDirect ||
            session.stripped.atSelf ||
            (session.stripped.hasAt && session.elements?.some((el) => el.type === "at" && el.attrs?.id === session.selfId)) ||
            this.profile.keywords.some((keyword) => session.content?.includes(keyword))
          ) {
            shouldTrigger = true;
          }
          break;
        }
        case "message-deleted":
          break;
        case "guild-member-added":
          break;
        default:
          break;
      }
      if (!message) return;
      const turnId = this.agent.send(message, { trigger: shouldTrigger, ifBusy: "join" });
      if (turnId) {
        this.logger.info(`Message sent to agent for profile ${this.profile.id} with turn ID ${turnId}.`);
        void (await this.agent.wait());
      }
    });
  }

  /**
   * The live focus is the switch recorded after the last checkpoint; only a profile without any checkpoint
   * falls back to the configured `initialFocus`. The frame needs no restoring — it lives in the checkpoint
   * payload and the projection reads it from the entry stream.
   */
  private async restoreContext(): Promise<void> {
    const entries = await this.storage.read();
    const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
    if (checkpoint === undefined) {
      this.generationDirty = entries.length > 0;
      return;
    }

    const after = entries.slice(entries.indexOf(checkpoint) + 1);
    const lastSwitch = lastEntryOfType(after, "ishiki.focus.changed");
    this.currentFocus = lastSwitch === undefined ? { ...checkpoint.data.frameFocus } : { ...lastSwitch.data.next };
    this.generationDirty = after.length > 0;
  }

  /** The workspace budget: an explicit token limit, else half of the window the model declares. */
  private resolveBudget(): void {
    const declared = this.profile.context.workspaceTokenLimit;
    if (declared !== undefined) {
      this.workspaceTokenLimit = declared;
      return;
    }
    const window = this.gateway.models("language").find((model) => model.id === this.profile.model)?.metadata.contextWindow;
    this.workspaceTokenLimit = window === undefined ? DEFAULT_WORKSPACE_TOKEN_LIMIT : Math.floor(window * 0.5);
  }

  private overBudget(workspace: readonly AgentEntry[]): boolean {
    let chars = 0;
    for (const entry of workspace) chars += JSON.stringify(entry).length;
    return chars / this.profile.context.charsPerToken >= this.workspaceTokenLimit;
  }

  /**
   * The text of the next frame. A generation that switched keeps the whole trace of where the mind came from
   * (pruned, but not cut to a window); one that did not carries over only its recent tail.
   */
  private frameTextFor(frameFocus: Focus, previousFrameFocus: Focus, workspace: readonly AgentEntry[]): string {
    const { historyEntries, focusHistoryEntries, toolResultChars } = this.profile.context;
    const messages = messageEntriesOf(workspace);
    const switchIndex = workspace.findIndex((entry) => entry.type === "ishiki.focus.changed");
    const parts = [`<frame at="${formatClock(Date.now())}" sid="${frameFocus.sid}" channel="${frameFocus.channelId}">`];

    if (switchIndex >= 0) {
      parts.push(`<last_focus_history sid="${previousFrameFocus.sid}" channel="${previousFrameFocus.channelId}">`);
      parts.push(...renderEntries(completeToolCalls(workspace.slice(0, switchIndex + 1), workspace), previousFrameFocus, this.profile, toolResultChars));
      parts.push("</last_focus_history>");

      // The new focus gets its own window searched over the whole generation, so lines may repeat what the
      // trajectory already shows; a repeat costs fewer tokens than a gap the mind cannot account for.
      const window = completeToolCalls(messages.filter((entry) => belongsToFocus(entry, frameFocus)).slice(-focusHistoryEntries), workspace);
      parts.push("<history>");
      parts.push(...renderEntries(window, frameFocus, this.profile, toolResultChars));
      parts.push("</history>");
    } else {
      const tail = messages.slice(-historyEntries);
      parts.push("<history>");
      if (messages.length > tail.length) parts.push(`<!-- 更早 ${messages.length - tail.length} 条已折叠 -->`);
      parts.push(...renderEntries(completeToolCalls(tail, workspace), frameFocus, this.profile, toolResultChars));
      parts.push("</history>");
    }

    parts.push("</frame>");
    return parts.join("\n");
  }

  /** The only materialized write. A failure leaves the generation untouched so the next trigger retries it. */
  private async rebuild(reason: string): Promise<void> {
    const entries = await this.storage.read();
    const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
    const workspace = workspaceOf(entries);
    if (workspace.length === 0) {
      this.generationDirty = false;
      return;
    }

    const switched = workspace.some((entry) => entry.type === "ishiki.focus.changed");
    // Idle is early compression, not a budget decision: folding a quiet generation while it is still small is
    // the point, since nobody is waiting for the answer.
    if (!switched && reason !== "idle" && !this.overBudget(workspace)) return;

    const frameFocus = { ...this.currentFocus };
    const previousFrameFocus = checkpoint === undefined ? this.profile.initialFocus : checkpoint.data.frameFocus;
    const text = this.frameTextFor(frameFocus, previousFrameFocus, workspace);
    const record: IshikiEntry.Checkpoint = {
      frameFocus,
      ...(switched ? { prevFocus: { ...previousFrameFocus } } : {}),
      text,
      createdAt: Date.now(),
    };

    try {
      await this.storage.append(createEntry("ishiki.checkpoint", record));
    } catch (error) {
      this.logger.warn(`checkpoint 写入失败（${reason}），本代保留待下次重试：${String(error)}`);
      return;
    }

    this.generationDirty = false;
    this.rebuildPending = false;
    this.logger.debug(`帧重建完成（${reason}），${text.length} 字符`);
  }

  private scheduleRebuild(reason: string): void {
    this.rebuildChain = this.rebuildChain
      .then(() => this.rebuild(reason))
      .catch((error: unknown) => this.logger.warn(`帧重建异常（${reason}）：${String(error)}`));
  }

  /** Early compression: a quiet generation is folded before the next message has to pay for it. */
  private async checkIdle(): Promise<void> {
    if (!this.generationDirty) return;
    if (!this.agent.isIdle()) {
      this.rebuildPending = true;
      return;
    }
    const entries = await this.storage.read();
    const last = entries.at(-1);
    if (last === undefined || Date.now() - last.timestamp < this.profile.context.idleMs) return;
    this.scheduleRebuild("idle");
  }

  async stop() {
    clearInterval(this.idleTimer);
    await this.agent.stop();
  }
}
