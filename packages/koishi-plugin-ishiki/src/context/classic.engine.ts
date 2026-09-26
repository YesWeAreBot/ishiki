import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import { type AgentEntry, type AgentMessage, createUserMessage } from "@yesimagent/core";
import type { Logger } from "koishi";
import { parse } from "yaml";

import { actionBlock, observationBlock } from "../toolcall/classic.engine.js";
import type { IshikiInnerStimulus, IshikiMessageCreated, IshikiMessageDeleted } from "../types.js";
import { ContextEngine, registerContextEngine, type ContextEngineOptions } from "./engine.js";

/**
 * classic 上下文引擎：YesImBot v3 的 WorldState 投影。
 *
 * 每轮把窗口内的事件流渲染成一条 `<world_state>` user 消息：频道、成员、以及切成
 * `processed_events` / `new_events` 的工作记忆。切点是**最后一条 assistant 条目**
 * （v3 的「最后一次 agent_thought / agent_action」）：它之后的观察与新消息都算「新到」，
 * 于是模型每一步都能在 `new_events` 里先看到上一步的工具结果。
 *
 * 与 v3 的差异（都是刻意的）：
 * - 没有 L2 向量检索与 L3 日记，`<retrieved_memories>` / `<diary_entries>` 两节随之去掉。
 * - 没有 `<trigger_context>`：v3 那节用 `{{#triggerContext.length}}` 判断普通对象，取不到
 *   `length`，实际上从不渲染。
 * - 不调平台接口取频道名与成员资料，只用事件流里带的信息。
 *
 * 本引擎只读事件流：不写存储、不起后台任务、不持有跨轮状态（模板的编译结果除外）。
 */

/** 未配置时的窗口上限：单轮最多送进多少条消息。 */
const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_KEEP_FULL_TURNS = 2;

export interface ClassicContextConfig {
  /** 单轮窗口内的消息条数上限，至少 1；更旧的整条退出模型视野。 */
  maxMessages: number;
  /** 保留最近多少轮的完整思考/行动/观察；更早的轨迹只留消息。0 表示不降级。 */
  keepFullTurnCount: number;
  /** 是否把 `<profileDir>/memory/*.md` 当作核心记忆块注入 system。 */
  memoryBlocks: boolean;
}

/** 一个核心记忆块；`label` 同时是可编辑文件里的 frontmatter 键与渲染出的标签名。 */
interface MemoryBlock {
  label: string;
  title: string;
  description: string;
  content: string;
}

/** 频道视图：v3 的 `channel`，字段只来自事件流。 */
interface ChannelView {
  id: string;
  type: string;
  platform: string;
}

/** 用 type 而不是 interface：匿名对象类型才带隐式索引签名，能直接交给 `Template.render`。 */
type WorldStateView = {
  channel: ChannelView;
  users: Array<{ id: string; name: string }>;
  processed_events: string[];
  new_events: string[];
};

/** 两位补零。 */
function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 时间戳的 `MM-DD HH:mm`，与 v3 的 `_formatDate` 一致。 */
function formatStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 配置是手写 YAML：越界或非数就回落到默认值。 */
function atLeast(value: number | undefined, floor: number, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= floor ? value : fallback;
}

/** 落到文本：非字符串一律 JSON，免得渲染出 `[object Object]`。 */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

/** 一条系统侧记录；v3 的 `system_event` 行。 */
function systemLine(timestamp: number, message: string): string {
  return `<system_event>[${formatStamp(timestamp)}|System] ${message}</system_event>`;
}

/** 把一条消息渲染成上下文中的一行；返回 undefined 表示它不进上下文。 */
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
        case "ishiki.inner_stimulus": {
          const data: IshikiInnerStimulus = message.data;
          return systemLine(data.timestamp, `${data.reason}：${data.content}`);
        }
        default:
          return undefined;
      }

    default:
      return undefined;
  }
}

/** 记忆块标签要当 XML 标签名用，收窄到安全字符集；不合规的文件直接跳过。 */
function safeLabel(label: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(label) ? label : undefined;
}

/** 解析一个记忆块文件：`---` 围出的 frontmatter 给 label（必填）/ title / description，其余是正文。 */
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

/** 读 `<profileDir>/memory` 下的全部记忆块；标签重复时保留先读到的那个。 */
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

export class ClassicContextEngine extends ContextEngine<"classic"> {
  private readonly logger: Logger;
  private readonly directory: string;
  private readonly resources: string;
  /** 模板在包内只读，编译一次就够；记忆块是用户文件，每轮重读。 */
  private worldTemplate?: Template;
  private instructionTemplate?: Template;

  constructor(options: ContextEngineOptions, config: Partial<ClassicContextConfig> = {}) {
    super("classic", {
      maxMessages: atLeast(config.maxMessages, 1, DEFAULT_MAX_MESSAGES),
      keepFullTurnCount: atLeast(config.keepFullTurnCount, 0, DEFAULT_KEEP_FULL_TURNS),
      memoryBlocks: config.memoryBlocks ?? true,
    });

    const { directory, resources } = options;
    if (directory === undefined || resources === undefined) {
      throw new Error('context engine "classic" needs ContextEngineOptions.directory and .resources');
    }
    this.logger = options.logger;
    this.directory = directory;
    this.resources = resources;
  }

  /** v3 系统提示词里 ishiki 基础提示词没覆盖的部分：核心记忆块的用法与 `<working_memory>` 的读法。 */
  extendInstructions = (): string => {
    const blocks = this.config.memoryBlocks ? readMemoryBlocks(this.directory) : [];
    return this.instructions().render({ blocks }).trim();
  };

  /**
   * 前台窗口：按条数截尾，再对更早的轮次做优雅降级——v3 只保留最近几轮的完整
   * 思考/行动/观察，更早的只留消息，免得旧轨迹把上下文撑满。
   */
  transformEntries = (entries: readonly AgentEntry[]): readonly AgentEntry[] => {
    const messages = entries.filter((entry) => entry.type === "message");
    const windowed = new Set(messages.slice(-this.config.maxMessages));
    const kept = entries.filter((entry) => entry.type !== "message" || windowed.has(entry));

    const turns = this.recentTurns(kept);
    if (turns === undefined) return kept;
    return kept.filter((entry) => !this.isStaleTrace(entry, turns));
  };

  /** 把窗口渲染成单条 `<world_state>` user 消息：v3 每步都重建整份世界状态。 */
  transformMessages = (messages: AgentMessage[]): AgentMessage[] => {
    const lines = messages.map((message) => renderLine(message));

    // 切点：最后一条 assistant。它之后的观察与新消息都算「新到」。
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

    return [createUserMessage(this.world().render(this.viewOf(messages, processed, fresh)))];
  };

  /** 最近 `keepFullTurnCount` 轮的轮次号；0 表示不降级，返回 undefined。 */
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

  /** 更早轮次的 agent 轨迹：消息一律保留，思考与工具轨迹整段剔除。 */
  private isStaleTrace(entry: AgentEntry, turns: ReadonlySet<string>): boolean {
    if (entry.type !== "message" || entry.turnId === undefined) return false;
    const role = entry.data.role;
    if (role !== "assistant" && role !== "tool") return false;
    return !turns.has(entry.turnId);
  }

  /** 事件流里能读到的频道与成员信息：取最后一条带地址的事件。 */
  private viewOf(messages: readonly AgentMessage[], processed: string[], fresh: string[]): WorldStateView {
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
      if (message.type === "ishiki.inner_stimulus") {
        const data: IshikiInnerStimulus = message.data;
        channel.id = data.channelId;
        channel.platform = data.platform;
      }
    }

    return { channel, users, processed_events: processed, new_events: fresh };
  }

  private world(): Template {
    this.worldTemplate ??= this.load("world_state.jinja");
    return this.worldTemplate;
  }

  private instructions(): Template {
    this.instructionTemplate ??= this.load("instructions.jinja");
    return this.instructionTemplate;
  }

  private load(name: string): Template {
    const file = path.join(this.resources, "templates", "classic", name);
    try {
      return new Template(readFileSync(file, "utf8"));
    } catch (error) {
      this.logger.error(`classic template "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

declare module "./engine.js" {
  interface ContextEngines {
    classic: ClassicContextConfig;
  }
}

registerContextEngine("classic", (config, options) => new ClassicContextEngine(options, config));
