import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import { type AgentEntry, type AgentMessage, createUserMessage } from "@yesimagent/core";
import { Service, type Context, type Logger } from "koishi";
import { parse } from "yaml";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import { actionBlock, observationBlock } from "../toolcall/v3.engine.js";
import type { IshikiMessageCreated, IshikiMessageDeleted } from "../types.js";
import { ContextEngine, type ContextEngineInstance, type ContextEngines } from "./engine.js";

// 内联自 resource.ts：包内 resources 目录的绝对路径。
// 从当前文件向上找到包根（含 package.json 的目录），兼容源码布局与打包后的单文件布局。
let here = import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname;
if (process.platform === "win32" && here.startsWith("/")) here = here.slice(1);
while (!existsSync(path.join(here, "package.json"))) here = path.dirname(here);
const RESOURCES_DIR = path.join(here, "resources");

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_KEEP_FULL_TURNS = 2;

export interface V3ContextConfig {
  maxMessages: number;
  keepFullTurnCount: number;
  memoryBlocks: boolean;
}

interface MemoryBlock {
  label: string;
  title: string;
  description: string;
  content: string;
}

interface ChannelView {
  id: string;
  type: string;
  platform: string;
}

type WorldStateView = {
  channel: ChannelView;
  users: Array<{ id: string; name: string }>;
  processed_events: string[];
  new_events: string[];
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function atLeast(value: number | undefined, floor: number, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= floor ? value : fallback;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function systemLine(timestamp: number, message: string): string {
  return `<system_event>[${formatStamp(timestamp)}|System] ${message}</system_event>`;
}

function renderLine(message: AgentMessage): string | undefined {
  switch (message.role) {
    case "assistant": {
      const parts = Array.isArray(message.content) ? message.content : [{ type: "text" as const, text: message.content }];
      const lines: string[] = [];
      for (const part of parts) {
        if (part.type === "text") {
          if (part.text.length > 0) lines.push(part.text);
        } else if (part.type === "tool-call") {
          lines.push(actionBlock(part.toolName, part.input));
        } else if (part.type === "tool-result") {
          lines.push(observationBlock(part.toolName, part.output));
        }
      }
      return lines.length === 0 ? undefined : lines.join("\n");
    }

    case "tool": {
      const lines: string[] = [];
      for (const part of message.content) {
        if (part.type === "tool-result") lines.push(observationBlock(part.toolName, part.output));
      }
      return lines.length === 0 ? undefined : lines.join("\n");
    }

    case "user":
      return typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");

    case "system":
      return systemLine(message.timestamp, typeof message.content === "string" ? message.content : text(message.content));

    case "custom":
      switch (message.type) {
        case "ishiki.message.created": {
          const data: IshikiMessageCreated = message.data;
          const who = data.user.name === undefined || data.user.name.length === 0 ? data.user.id : `${data.user.name}(${data.user.id})`;
          return `<message>[${data.messageId}|${formatStamp(data.timestamp)}|${who}] ${data.content}</message>`;
        }
        case "ishiki.message.deleted": {
          const data: IshikiMessageDeleted = message.data;
          return systemLine(data.timestamp, `#${data.messageId} 已被删除`);
        }
        default:
          return undefined;
      }

    default:
      return undefined;
  }
}

function safeLabel(label: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(label) ? label : undefined;
}

function parseBlock(source: string): MemoryBlock | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (match === null) return undefined;

  let meta: unknown;
  try {
    meta = parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof meta !== "object" || meta === null) return undefined;

  const { label, title, description } = meta as Record<string, unknown>;
  if (typeof label !== "string") return undefined;
  const safe = safeLabel(label);
  if (safe === undefined) return undefined;

  return { label: safe, title: text(title), description: text(description), content: source.slice(match[0].length).trim() };
}

function readMemoryBlocks(directory: string): MemoryBlock[] {
  const root = path.join(directory, "memory");
  if (!existsSync(root)) return [];

  const blocks: MemoryBlock[] = [];
  const labels = new Set<string>();
  for (const file of readdirSync(root).sort()) {
    if (!file.endsWith(".md") && !file.endsWith(".txt")) continue;

    const block = parseBlock(readFileSync(path.join(root, file), "utf8"));
    if (block === undefined || labels.has(block.label)) continue;
    labels.add(block.label);
    blocks.push(block);
  }
  return blocks;
}

export class V3ContextInstance implements ContextEngineInstance {
  public readonly config: V3ContextConfig;

  private readonly logger: Logger;
  private readonly directory: string;
  private readonly resources: string;
  private worldTemplate?: Template;
  private instructionTemplate?: Template;

  constructor(config: Partial<V3ContextConfig>, context: ExtensionContext) {
    this.config = {
      maxMessages: atLeast(config.maxMessages, 1, DEFAULT_MAX_MESSAGES),
      keepFullTurnCount: atLeast(config.keepFullTurnCount, 0, DEFAULT_KEEP_FULL_TURNS),
      memoryBlocks: config.memoryBlocks ?? true,
    };

    this.logger = context.logger;
    this.directory = context.root;
    this.resources = RESOURCES_DIR;
  }

  instructions = (): string => {
    const blocks = this.config.memoryBlocks ? readMemoryBlocks(this.directory) : [];
    return this.instructionTpl().render({ blocks }).trim();
  };

  prepareEntries = (entries: readonly AgentEntry[]): readonly AgentEntry[] => {
    const messages = entries.filter((entry) => entry.type === "message");
    const windowed = new Set(messages.slice(-this.config.maxMessages));
    const kept = entries.filter((entry) => entry.type !== "message" || windowed.has(entry));

    const turns = this.recentTurns(kept);
    if (turns === undefined) return kept;
    return kept.filter((entry) => !this.isStaleTrace(entry, turns));
  };

  renderMessages = (messages: readonly AgentMessage[]): AgentMessage[] => {
    const lines = messages.map((message) => (message.role === "custom" && message.type === "ishiki.attachment" ? undefined : renderLine(message)));

    let cut = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        cut = index + 1;
        break;
      }
    }

    const processed: string[] = [];
    const fresh: string[] = [];
    lines.forEach((line, index) => {
      if (line === undefined || line.length === 0) return;
      (index < cut ? processed : fresh).push(line);
    });

    return [
      createUserMessage(this.world().render(this.buildView(messages, processed, fresh))),
      ...messages.filter((message) => message.role === "custom" && message.type === "ishiki.attachment"),
    ];
  };

  private recentTurns(entries: readonly AgentEntry[]): ReadonlySet<string> | undefined {
    const count = this.config.keepFullTurnCount;
    if (count <= 0) return undefined;

    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "message" || entry.turnId === undefined) continue;
      if (entry.data.role !== "assistant" && entry.data.role !== "tool") continue;
      seen.add(entry.turnId);
    }

    const kept = [...seen].slice(-count);
    return new Set(kept);
  }

  private isStaleTrace(entry: AgentEntry, turns: ReadonlySet<string>): boolean {
    if (entry.type !== "message" || entry.turnId === undefined) return false;
    const role = entry.data.role;
    if (role !== "assistant" && role !== "tool") return false;
    return !turns.has(entry.turnId);
  }

  private buildView(messages: readonly AgentMessage[], processed: string[], fresh: string[]): WorldStateView {
    const channel: ChannelView = { id: "", type: "", platform: "" };
    const users: Array<{ id: string; name: string }> = [];
    const known = new Set<string>();

    for (const message of messages) {
      if (message.role !== "custom") continue;
      if (message.type === "ishiki.message.created") {
        const data: IshikiMessageCreated = message.data;
        channel.id = data.channelId;
        channel.type = data.isDirect ? "private" : "guild";
        channel.platform = data.platform;
        if (!known.has(data.user.id)) {
          known.add(data.user.id);
          users.push({ id: data.user.id, name: data.user.name ?? "" });
        }
        continue;
      }
    }

    return { channel, users, processed_events: processed, new_events: fresh };
  }

  private world(): Template {
    this.worldTemplate ??= this.load("world_state.jinja");
    return this.worldTemplate;
  }

  private instructionTpl(): Template {
    this.instructionTemplate ??= this.load("instructions.jinja");
    return this.instructionTemplate;
  }

  private load(name: string): Template {
    const file = path.join(this.resources, "templates", "v3", name);
    try {
      return new Template(readFileSync(file, "utf8"));
    } catch (error) {
      this.logger.error(`v3 template "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

declare module "./engine.js" {
  interface ContextEngines {
    v3: V3ContextConfig;
  }
}

export class V3ContextEngine extends ContextEngine<"v3"> {
  constructor(ctx: Context) {
    super(ctx, "v3");
  }

  public [Service.invoke](config: EngineConfig<Pick<ContextEngines, "v3">>, context: ExtensionContext): ContextEngineInstance {
    return new V3ContextInstance(config.v3 ?? {}, context);
  }
}
