import { createEntry, createUserMessage, generateText, type Agent, type AgentEntry, type AgentMessage } from "@yesimagent/core";
import type { Logger } from "koishi";

import type { IshikiInnerStimulus, IshikiMessageCreated, IshikiMessageDeleted } from "../types.js";
import { ContextEngine, registerContextEngine, type ContextEngineOptions, type CrossContext, type FootprintHint } from "./engine.js";

declare module "@yesimagent/core" {
  interface AgentCustomEntry {
    "ishiki.compact": IshikiCompact;
  }
}

export interface IshikiCompact {
  summary: string;
  lastEntryId: string;
}

/** 未配置时的字符预算上限；显式写 0 表示只线性增长、不压缩。 */
const DEFAULT_CONTEXT_CHARS = 24_000;

export interface StandardContextConfig {
  model?: string;
  /** 单轮模型输入的文本上限（字符数）；超出时最旧的一段退出模型视野，交给后台并入摘要。 */
  maxChars: number;
  /** 装配留下的水位比例。0.8 表示压到 `maxChars * 0.8`，为后续轮次留出余量。 */
  refillRatio?: number;
}

/** 摘要行的固定首行标记。 */
const MEMORY_HEAD = "（以下是此前的对话记录，已压缩为摘要）";
const DEFAULT_REFILL_RATIO = 0.8;

/** 渲染行的时间部分，格式 `HH:mm`。 */
function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/** 将一条 ishiki 消息渲染为上下文中的一行；非本命名空间返回 undefined。 */
export function renderLine(message: AgentMessage, hint?: FootprintHint): string | undefined {
  if (message.role !== "custom") return undefined;

  switch (message.type) {
    case "ishiki.message.created": {
      const data: IshikiMessageCreated = message.data;
      const who = data.user.name === undefined || data.user.name.length === 0 ? data.user.id : `${data.user.name}(${data.user.id})`;
      const extra = hint?.(data.user.id, data.channelId);
      return `[${formatClock(data.timestamp)}] ${who} #${data.messageId}: ${data.content}${extra === undefined ? "" : ` <!-- ${extra} -->`}`;
    }
    case "ishiki.message.deleted": {
      const data: IshikiMessageDeleted = message.data;
      return `[${formatClock(data.timestamp)}] #${data.messageId}: (已删除)`;
    }
    case "ishiki.inner_stimulus": {
      const data: IshikiInnerStimulus = message.data;
      const from = data.source === undefined ? "external" : `${data.source.platform}:${data.source.selfId}/${data.source.channelId}`;
      const reason = data.reason.replaceAll('"', "'").replaceAll("\n", " ").trim();
      return `[${formatClock(data.timestamp)}] <stimulus from="${from}" reason="${reason}">${data.content}</stimulus>`;
    }
    default:
      // 无渲染规则的类型不进入上下文输入，仍保留在事件流中。
      return undefined;
  }
}

/** 消息在体积统计与摘要输入中的文本：本命名空间按渲染行计，其余按消息内容计。 */
function textOf(message: AgentMessage): string {
  const line = renderLine(message);
  if (line !== undefined) return line;

  switch (message.role) {
    case "user":
    case "system":
      return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    case "assistant":
    case "tool":
      return JSON.stringify(message.content);
    default:
      return JSON.stringify(message.data);
  }
}

/** 连续的 ishiki 消息合并为单条 user 消息；其余消息原样透传，并中断行序列。 */
export function collapse(messages: readonly AgentMessage[], hint?: FootprintHint): AgentMessage[] {
  const collapsed: AgentMessage[] = [];
  const lines: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    collapsed.push(createUserMessage(lines.join("\n")));
    lines.length = 0;
  };

  for (const message of messages) {
    const line = renderLine(message, hint);
    if (line === undefined) {
      flush();
      collapsed.push(message);
      continue;
    }
    if (line.length > 0) lines.push(line);
  }
  flush();

  return collapsed;
}

/** 流中最后一条 compact 条目即当前生效的摘要。 */
function lastCompact(entries: readonly AgentEntry[]): AgentEntry<"ishiki.compact"> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "ishiki.compact") return entry;
  }
  return undefined;
}

/**
 * 切点：让「摘要头 + 切点之后的可见行」落进 `target` 以内的最小位置，返回它在 `tail` 里的下标。
 * 切点必须落在 user / custom 行上：截断 tool call / tool result 配对会被提供商拒绝，所以工具轨迹整段留在切点之后。
 * 没有这样的点返回 -1。
 */
function cutOf(tail: readonly AgentEntry[], head: number, target: number): number {
  let suffix = 0;
  for (const entry of tail) {
    if (entry.type === "message") suffix += textOf(entry.data).length;
  }

  for (let at = 0; at < tail.length; at += 1) {
    const entry = tail[at];
    if (!(entry.type === "message")) continue;
    if ((entry.data.role === "user" || entry.data.role === "custom") && head + suffix <= target) return at;
    suffix -= textOf(entry.data).length;
  }

  return -1;
}

/**
 * 线性增长 + 空闲压缩，两条轨道各自独立：
 *
 * - 前台 `transformEntries` 只做同步裁剪：预算内原样交给模型，超预算就把最旧的可见行切出模型视野。
 *   这一步不调模型，任何一轮的附加延迟都是零。
 * - 后台 `onTurnFinish` 在一轮结束之后，把上次切掉的那段并进摘要，水位以 `ishiki.compact`
 *   条目追加到流中。压缩成功前聊天照常进行；压缩失败不影响本轮，下一轮结束再试。
 *
 * 除压缩成功时追加的那一条 compact 外，本引擎只读不写。
 */
export class StandardContextEngine extends ContextEngine<"standard"> {
  private agent?: Agent;
  private readonly logger?: Logger;
  private readonly ceiling: number;
  private readonly target: number;
  /** 拉取待挂载的跨场景前情；取到即清空来源，保证只挂载一次。 */
  private readonly pullCrossContext?: () => CrossContext | undefined;
  /** 足迹线索：渲染消息行时附加发言人的跨频道活跃提示。 */
  private readonly hint?: FootprintHint;
  /** 上一次装配是否超预算：后台压缩的触发条件。 */
  private over = false;
  private compacting?: Promise<void>;
  private abort?: AbortController;

  constructor(options: ContextEngineOptions, config: Partial<StandardContextConfig> = {}) {
    const maxChars = config.maxChars ?? DEFAULT_CONTEXT_CHARS;
    const refillRatio = config.refillRatio !== undefined && config.refillRatio > 0 && config.refillRatio <= 1 ? config.refillRatio : DEFAULT_REFILL_RATIO;
    super("standard", { maxChars, refillRatio });
    this.logger = options.logger;
    this.pullCrossContext = options.pullCrossContext;
    this.hint = options.hint;
    this.ceiling = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0;
    this.target = this.ceiling * refillRatio;
    if (this.ceiling === 0) this.logger?.warn("context budget disabled: maxChars is non-positive, compaction off");
  }

  /** core 会摘取这些 hook 单独调用，因此必须绑定在实例上（箭头属性）。 */
  init = (agent: Agent): void => {
    this.agent = agent;
  };

  /** agent 停止时收尾：压缩中的请求一并中止。 */
  stop = (): void => {
    this.abort?.abort();
  };

  /** 前台：只裁窗口，不调模型。 */
  transformEntries = async (entries: readonly AgentEntry[]): Promise<readonly AgentEntry[]> => {
    if (this.ceiling === 0) return entries;

    const compact = lastCompact(entries);
    const anchor = compact === undefined ? -1 : entries.findIndex((entry) => entry.id === compact.data.lastEntryId);
    if (compact !== undefined && anchor < 0) this.logger?.warn(`memory anchor ${compact.data.lastEntryId} not found in stream, memory ignored`);

    const memory = anchor < 0 ? undefined : compact;
    const tail = memory === undefined ? entries : entries.slice(anchor + 1);
    const head = memory === undefined ? "" : `${MEMORY_HEAD}\n${memory.data.summary}`;

    // 易失跨场景前情：挂到可见区末尾，不参与预算裁剪（单次 ≤10 行，量级可控），
    // 也不写入存储。取到即清空，保证只对本轮可见。
    const cross = this.pullCrossContext?.();
    const crossEntries =
      cross === undefined
        ? []
        : [
            createEntry(
              "message",
              createUserMessage(
                `<cross_scene_context channel="${cross.channelId}" elapsed="${Math.round(cross.elapsedMs / 60_000)}m">\n${cross.lines.join("\n")}\n</cross_scene_context>`,
              ),
            ),
          ];

    let size = head.length;
    for (const entry of tail) {
      if (entry.type === "message") size += textOf(entry.data).length;
    }
    if (size <= this.ceiling) {
      this.over = false;
      return this.prepend(head, [...tail, ...crossEntries]);
    }

    this.over = true;
    const cut = cutOf(tail, head.length, this.target);
    if (cut < 0) {
      this.logger?.warn("context over budget with no valid cut point, entries passed through");
      return this.prepend(head, [...tail, ...crossEntries]);
    }
    return this.prepend(head, [...tail.slice(cut), ...crossEntries]);
  };

  transformMessages = (messages: AgentMessage[]): AgentMessage[] => collapse(messages, this.hint);

  /** 后台：一轮结束后，若刚才是超预算装配的，把切掉的那段并进摘要。不阻塞轮次结束。 */
  onTurnFinish = (): void => {
    if (!this.over || this.compacting !== undefined) return;
    this.compacting = this.compact().finally(() => {
      this.compacting = undefined;
    });
  };

  /** 等在做的那次压缩收尾。 */
  async settle(): Promise<void> {
    await this.compacting;
  }

  /** 把切掉的一段并入摘要，水位以 compact 条目追加到流中。全程在后台，失败只记一条日志。 */
  private async compact(): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) return;

    const entries = await agent.storage.read();
    const compact = lastCompact(entries);
    const anchor = compact === undefined ? -1 : entries.findIndex((entry) => entry.id === compact.data.lastEntryId);

    const memory = anchor < 0 ? undefined : compact;
    const tail = memory === undefined ? entries : entries.slice(anchor + 1);
    const head = memory === undefined ? "" : `${MEMORY_HEAD}\n${memory.data.summary}`;

    const cut = cutOf(tail, head.length, this.target);
    const dropped = cut > 0 ? tail.slice(0, cut).filter((e) => e.type === "message") : [];
    if (dropped.length === 0) {
      // 没有可切的点，或切出来没有可见行：等下一次装配重新判定。
      this.over = false;
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    try {
      const summary = await this.summarize(memory?.data.summary, dropped, abort.signal);
      // 失败就留着 `over`，下一轮结束再试；本轮与后续轮次照常跑。
      // 停止之后才回来的摘要一律丢掉：这条流已经不属于任何活着的实例了。
      if (summary === undefined || abort.signal.aborted) return;
      // 直接写入存储：该条目是关于流的元数据，不经过 onAppend 的条目处理。
      await agent.storage.append(createEntry("ishiki.compact", { summary, lastEntryId: dropped[dropped.length - 1].id }));
      this.over = false;
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  /** 让模型把新记录并进既有摘要。失败返回 undefined。 */
  private async summarize(previous: string | undefined, dropped: ReadonlyArray<AgentEntry<"message">>, signal: AbortSignal): Promise<string | undefined> {
    const agent = this.agent;
    if (agent === undefined) return undefined;

    const material = dropped.map((entry) => textOf(entry.data)).join("\n");
    const prompt = [
      "将新增记录并入既有摘要，输出更新后的摘要。",
      "保留后续仍需的信息：事实、约定、关系与称谓的变化、未完成事项、对方偏好。",
      "舍弃：寒暄、重复内容、已了结且无后续影响的过程细节。",
      "以第一人称输出摘要正文，不要标题、前言或说明。",
      "",
      "既有摘要：",
      previous ?? "（空）",
      "",
      "新增记录：",
      material,
    ].join("\n");

    try {
      const generated = await generateText({ model: agent.getModel(), prompt, abortSignal: signal });
      const summary = generated.text.trim();
      return summary.length === 0 ? undefined : summary;
    } catch (error) {
      this.logger?.warn(`compaction failed, oldest segment dropped: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 把摘要作为首条 user 消息插入可见条目之前。 */
  private prepend(lead: string, tail: readonly AgentEntry[]): readonly AgentEntry[] {
    if (lead.length === 0) return tail;
    return [createEntry("message", createUserMessage(lead)), ...tail];
  }
}

declare module "./engine.js" {
  interface ContextEngines {
    standard: StandardContextConfig;
  }
}

registerContextEngine("standard", (config, options) => new StandardContextEngine(options, config));
