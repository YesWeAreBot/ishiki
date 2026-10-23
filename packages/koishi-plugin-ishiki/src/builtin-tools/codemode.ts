import type {
  CodemodeJsonSchema,
  CodemodeResult,
  CodemodeSandbox,
  CodemodeStoreWrites,
  CodemodeTool,
  RenderDeclarationsOptions,
} from "@earendil-works/pi-codemode";
import {
  asSchema,
  createCustomMessage,
  createEntry,
  jsonSchema,
  safeValidateTypes,
  experimental_toolCaller,
  type AgentEntry,
  type Tool,
  type ToolCallers,
  type ToolExecutionOptions,
  type ToolResultOutput,
  type ToolSet,
} from "@yesimagent/core";

import type { CodemodeConfig } from "../profile/index.js";
import type { ResourceCenter } from "../resource/center.js";
import type { AttachmentItem, IshikiCodemodeStore } from "../types.js";
import { createCatalog, DESCRIBE_TOOL_GLOBAL, SEARCH_TOOLS_GLOBAL } from "./codemode/catalog.js";
import { prepareCodemodeOutput } from "./codemode/output.js";
import { FINISH_TOOL } from "./finish.js";
import { SEND_MESSAGE_TOOL } from "./send-message.js";

export const CODEMODE_TOOL = "codemode";

/** The SDK's name for a tool call that stays visible to the model next to the caller. */
const DIRECT_TOOL_CALL = "AI_SDK_DIRECT_TOOL_CALL";

export interface CodemodeInput {
  js: string;
}

/** What one codemode call leaves in the tool result before `toModelOutput` renders it. */
export interface CodemodeToolResult {
  result: CodemodeResult;
  elapsedMs: number;
  text: string;
  items: AttachmentItem[];
}

export interface CodemodeSurface {
  readonly tool: Tool<CodemodeInput, CodemodeToolResult>;
  /** Caller routing for the host tools callable from scripts; rebuilt with every tool assembly. */
  route(names: readonly string[]): ToolCallers;
  /** Rebuild `store`/`load` state from the stored session entries, before any rendering. */
  restore(entries: readonly AgentEntry[]): void;
  /** Append the state entry and attachment message of every result in this batch. */
  commit(entries: AgentEntry[]): AgentEntry[];
  /** Drop results that never reached storage, e.g. after an aborted turn. */
  reset(): void;
  dispose(): Promise<void>;
}

export interface CodemodeModule {
  CodemodeSandbox: typeof CodemodeSandbox;
  parseCodemodeSource: (input: string) => { code: string; options: { maxOutputTokens?: number; timeoutMs?: number } };
  renderDeclarations: (options: RenderDeclarationsOptions) => string;
  MAX_STORE_TOTAL_CHARS: number;
  MAX_STORE_VALUE_CHARS: number;
}

let loader: Promise<CodemodeModule> | undefined;

/**
 * Load the sandbox lazily: the package is ESM-only, so the CommonJS build of
 * this plugin can only reach it through a dynamic import.
 */
export function loadCodemode(): Promise<CodemodeModule> {
  loader ??= import("@earendil-works/pi-codemode").then((pi) => ({
    CodemodeSandbox: pi.CodemodeSandbox,
    parseCodemodeSource: pi.parseCodemodeSource,
    renderDeclarations: pi.renderDeclarations,
    MAX_STORE_TOTAL_CHARS: pi.MAX_STORE_TOTAL_CHARS,
    MAX_STORE_VALUE_CHARS: pi.MAX_STORE_VALUE_CHARS,
  }));
  return loader;
}

const DESCRIPTION = [
  "Run JavaScript in an isolated QuickJS sandbox and report what the script produced.",
  "",
  "`js` is the body of an async function: top-level `await` works, `return` fills the RESULT section, and a trailing expression is discarded. Values cross the boundary as JSON.",
  "",
  "Host tools are the members of `tools`, called by their original name:",
  '  const file = await tools.read({ url: "asset://..." });',
  `\`${SEARCH_TOOLS_GLOBAL}(query)\` returns matching tool names with one-line hints, \`${DESCRIBE_TOOL_GLOBAL}(name)\` returns one tool's TypeScript declaration, and \`ALL_TOOLS\` lists every name. A host tool result stays inside the script until the script returns it or emits it.`,
  "",
  "Output helpers, appended in call order:",
  "  text(value)      TEXT section",
  "  console.log(...) CONSOLE section",
  '  image(source)    ATTACHMENTS section; accepts a base64 data URI, { image_url }, or { type: "image", data, mimeType }. Read remote resources with a host tool first.',
  "  exit()           end the script now, with no RESULT",
  "",
  "`store(key, value)` saves JSON state for later calls, `store(key, undefined)` deletes a key, and `load(key)` reads one. Keep it small: images and large data belong in variables or in a host tool's own storage.",
  "",
  'Put `// @options: {"timeout_ms": 60000, "max_output_tokens": 2000}` on the first line to override the timeout and the display budget of this call.',
  "",
  "A host tool that throws becomes a catchable script error. An uncaught error fails the call and keeps the output produced so far.",
].join("\n");

const INPUT_SCHEMA = jsonSchema<CodemodeInput>({
  type: "object",
  properties: {
    js: { type: "string", description: "body of an async function; runs in the sandbox with host tools available as `tools`" },
  },
  required: ["js"],
  additionalProperties: false,
});

const toModelOutput = (options: { output: CodemodeToolResult }): ToolResultOutput => ({ type: "text", value: options.output.text });

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** Host tools may stream partial values; the session keeps the final one. */
async function settled(value: unknown): Promise<unknown> {
  if (!isAsyncIterable(value)) return value;
  let last: unknown;
  for await (const item of value) last = item;
  return last;
}

/** PI declares schemas structurally; the AI SDK hands over plain JSON Schema documents. */
function codemodeSchema(schema: unknown): CodemodeJsonSchema | undefined {
  return schema === undefined ? undefined : (schema as CodemodeJsonSchema);
}

function applyWrites(store: Record<string, unknown>, writes: CodemodeStoreWrites): void {
  for (const key of writes.delete) delete store[key];
  for (const [key, value] of Object.entries(writes.set)) store[key] = value;
}

function hasWrites(writes: CodemodeStoreWrites): boolean {
  return writes.delete.length > 0 || Object.keys(writes.set).length > 0;
}

function assertStore(store: Record<string, unknown>, pi: CodemodeModule): void {
  let total = 0;
  for (const [key, value] of Object.entries(store)) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`codemode store key ${JSON.stringify(key)} is not JSON-serializable`);
    if (json.length > pi.MAX_STORE_VALUE_CHARS) {
      throw new Error(
        `codemode store key ${JSON.stringify(key)} holds ${json.length} characters of JSON, over the ${pi.MAX_STORE_VALUE_CHARS} limit; delete it with store(key, undefined)`,
      );
    }
    total += key.length + json.length;
  }
  if (total > pi.MAX_STORE_TOTAL_CHARS) {
    throw new Error(
      `codemode store would hold ${total} characters of JSON, over the ${pi.MAX_STORE_TOTAL_CHARS} limit; delete keys with store(key, undefined)`,
    );
  }
}

interface HostEntry {
  name: string;
  description?: string;
  inputSchema?: CodemodeJsonSchema;
  outputSchema?: CodemodeJsonSchema;
}

interface Binding {
  tools: ToolSet;
  entries: Promise<HostEntry[]>;
}

interface PendingResult {
  toolCallId: string;
  writes?: CodemodeStoreWrites;
  items: AttachmentItem[];
}

export interface CodemodeOptions {
  config: CodemodeConfig;
  resources: ResourceCenter;
  imageInput: boolean;
  /** Per-tool context handed to description functions by the current step. */
  contextOf(name: string): unknown;
}

export async function createCodemode(options: CodemodeOptions): Promise<CodemodeSurface> {
  const pi = await loadCodemode();
  const catalog = createCatalog(pi.renderDeclarations);
  const sandbox = new pi.CodemodeSandbox({
    globals: [...catalog.globals],
    timeoutMs: options.config.timeoutMs,
    memoryLimitBytes: options.config.memoryLimitBytes,
  });

  const pending = new Map<string, PendingResult>();
  const installed = new Set<string>();
  let committed: Record<string, unknown> = {};
  let binding: Binding | undefined;

  const readHosts = async (tools: ToolSet): Promise<HostEntry[]> => {
    const entries: HostEntry[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      const description = tool.description === undefined ? undefined : resolveDescription(tool.description, options.contextOf(name));
      const inputSchema = await asSchema(tool.inputSchema).jsonSchema;
      const outputSchema = tool.outputSchema === undefined ? undefined : await asSchema(tool.outputSchema).jsonSchema;
      entries.push({ name, description, inputSchema: codemodeSchema(inputSchema), outputSchema: codemodeSchema(outputSchema) });
    }
    return entries;
  };

  /** Install this call's host table; the sandbox snapshots it synchronously in `execute`. */
  const install = (entries: readonly HostEntry[], tools: ToolSet, toolCallId: string): void => {
    for (const name of installed) sandbox.unregisterTool(name);
    installed.clear();
    for (const entry of entries) {
      const tool = tools[entry.name];
      if (tool === undefined) continue;
      let index = 0;
      const node: CodemodeTool = {
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
        execute: async (args, context) => {
          const parsed = await safeValidateTypes({ value: args, schema: tool.inputSchema });
          if (!parsed.success) throw parsed.error;
          if (tool.execute === undefined) throw new Error(`tool "${entry.name}" has no local implementation`);
          const execution: ToolExecutionOptions<unknown> = {
            toolCallId: `${toolCallId}:tool-${index++}`,
            messages: [],
            abortSignal: context.signal,
            context: undefined,
          };
          return settled(await tool.execute(parsed.value, execution));
        },
      };
      sandbox.registerTool(node);
      installed.add(entry.name);
    }
    catalog.update(entries);
  };

  const call = async (input: CodemodeInput, execution: ToolExecutionOptions<unknown>): Promise<CodemodeToolResult> => {
    if (binding === undefined) throw new Error("codemode has no host tools bound for this step");
    if (typeof input.js !== "string") throw new TypeError("codemode expects js to be a string");
    const entries = await binding.entries;
    const source = pi.parseCodemodeSource(input.js);
    const started = performance.now();
    install(entries, binding.tools, execution.toolCallId);
    const result = await sandbox.execute(source.code, {
      signal: execution.abortSignal,
      timeoutMs: source.options.timeoutMs,
      store: { ...committed },
    });
    if (!result.ok && result.error.kind === "aborted") execution.abortSignal?.throwIfAborted();
    const elapsedMs = performance.now() - started;
    const rendered = await prepareCodemodeOutput({
      center: options.resources,
      toolName: CODEMODE_TOOL,
      result,
      elapsedMs,
      maxOutputTokens: source.options.maxOutputTokens ?? options.config.maxOutputTokens,
      imageInput: options.imageInput,
    });
    const writes = result.ok && hasWrites(result.storeWrites) ? result.storeWrites : undefined;
    if (writes !== undefined || rendered.items.length > 0) {
      pending.set(execution.toolCallId, { toolCallId: execution.toolCallId, writes, items: rendered.items });
    }
    return { result, elapsedMs, text: rendered.text, items: rendered.items };
  };

  const tool: Tool<CodemodeInput, CodemodeToolResult> = experimental_toolCaller(
    { description: DESCRIPTION, inputSchema: INPUT_SCHEMA, execute: call, toModelOutput },
    {
      type: "local",
      bind: (tools) => {
        const bound = { description: DESCRIPTION, inputSchema: INPUT_SCHEMA, execute: call, toModelOutput };
        binding = { tools, entries: readHosts(tools) };
        return bound;
      },
    },
  );

  return {
    tool,
    route: (names) => {
      const callers: ToolCallers = {};
      for (const name of names) {
        // finish ends the turn, so the model keeps it and scripts never see it.
        if (name === FINISH_TOOL) {
          callers[name] = [DIRECT_TOOL_CALL];
          continue;
        }
        callers[name] = name === SEND_MESSAGE_TOOL || options.config.direct.includes(name) ? [CODEMODE_TOOL, DIRECT_TOOL_CALL] : [CODEMODE_TOOL];
      }
      return callers;
    },
    restore: (entries) => {
      const store: Record<string, unknown> = {};
      for (const entry of entries) {
        if (entry.type !== "ishiki.codemode.store") continue;
        applyWrites(store, entry.data as IshikiCodemodeStore);
      }
      committed = store;
    },
    commit: (entries) => {
      if (pending.size === 0) return entries;
      const matched: PendingResult[] = [];
      for (const entry of entries) {
        if (entry.type !== "message") continue;
        const message = entry.data;
        if (message.role !== "tool" || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== "tool-result" || part.toolName !== CODEMODE_TOOL) continue;
          const record = pending.get(part.toolCallId);
          if (record === undefined) continue;
          pending.delete(part.toolCallId);
          const kind = part.output.type;
          if (kind === "error-text" || kind === "error-json" || kind === "execution-denied") continue;
          matched.push(record);
        }
      }
      if (matched.length === 0) return entries;

      const merged = { ...committed };
      for (const record of matched) if (record.writes !== undefined) applyWrites(merged, record.writes);
      assertStore(merged, pi);

      const turnId = entries.find((entry) => entry.turnId !== undefined)?.turnId;
      const appended: AgentEntry[] = [];
      for (const record of matched) {
        if (record.writes !== undefined) {
          appended.push(createEntry("ishiki.codemode.store", { ...record.writes, toolCallId: record.toolCallId }, { turnId }));
        }
        if (record.items.length > 0) {
          appended.push(
            createEntry(
              "message",
              createCustomMessage("ishiki.attachment", {
                source: "tool",
                toolName: CODEMODE_TOOL,
                toolCallId: record.toolCallId,
                items: record.items,
              }),
              { turnId },
            ),
          );
        }
      }
      return [...entries, ...appended];
    },
    reset: () => pending.clear(),
    dispose: () => sandbox.close(),
  };
}

/** A tool description is a fixed string or a function of the step's per-tool context. */
function resolveDescription(description: string | ((options: { context: unknown }) => string), context: unknown): string {
  return typeof description === "string" ? description : description({ context });
}
