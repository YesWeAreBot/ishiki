import { createEntry, createUserMessage, generateText, type Agent, type AgentEntry, type AgentMessage } from "@yesimagent/core";
import type { Logger } from "koishi";

import type { InstanceDomain } from "../domain.js";
import type { IshikiMessageCreated, IshikiMessageDeleted } from "../types.js";
import { ContextEngine, registerContextEngine, type ContextEngineOptions } from "./engine.js";

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

/** 两位补零。 */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** 渲染行的时间部分，格式 `MM-DD HH:mm`；与 classic 引擎一致，跨日时日期是唯一线索。 */
function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 人的显示名：有昵称就是「昵称(id)」，否则退回裸 id。 */
function displayName(user: { id: string; name?: string }): string {
  return user.name === undefined || user.name.length === 0 ? user.id : `${user.name}(${user.id})`;
}

/**
 * 拆成寻址头与正文两段。头只说坐标，正文自带作者，于是同频道的连续消息合成一段时
 * 头只出现一次，而换人说活不会断段——`group:*` 这类通配认领的频道一多，
 * 逐行重复坐标与作者只是把窗口撑大，对模型没有新信息。
 *
 * `names` 是窗口内见过的人名，撤回行靠它把 id 还原成昵称：平台的撤回事件只给 id，
 * 缺了它就只能渲染出一串数字。单条渲染（体积统计、摘要输入）没有窗口，`names` 缺省即退到 id。
 */
function addressParts(message: AgentMessage, domain?: InstanceDomain, names?: ReadonlyMap<string, string>): { head: string; body: string } | undefined {
  if (message.role !== "custom") return undefined;

  // 坐标恒为 `sid/channelId` 复合坐标：各账号下的频道号互不相干，单写 channelId 指不准。
  // core 的 `AgentCustomMessage` 留了一条 `custom: unknown` 占位成员，载荷只能按形状收窄。
  const head = (from: { platform: string; selfId: string; channelId: string }) => {
    if (domain?.form !== "cross") return "";
    return `[#${from.platform}:${from.selfId}/${from.channelId}] `;
  };

  switch (message.type) {
    case "ishiki.message.created": {
      const data: IshikiMessageCreated = message.data;
      const who = displayName(data.user);
      return { head: head(data), body: `[${formatClock(data.timestamp)}] ${who} #${data.messageId}: ${data.content}` };
    }
    case "ishiki.message.deleted": {
      const data: IshikiMessageDeleted = message.data;
      // 作者与操作者同一人时合并成一句：「X 的消息被 X 撤回」读着卡带，而自己撤回自己是群里的常态。
      // 两端任一缺失都只说发生了什么，不猜是谁。
      const by = data.userId === undefined ? undefined : (names?.get(data.userId) ?? data.userId);
      const at = data.operatorId === undefined ? undefined : (names?.get(data.operatorId) ?? data.operatorId);
      const id = `#${data.messageId}`;
      // 是不是自己撤回，按 id 判，不按显示名：同一个人两个昵称时会被误并成一句。
      const self = data.userId !== undefined && data.userId === data.operatorId;
      const fact =
        by === undefined || at === undefined ? `有一条消息 ${id} 被撤回了` : self ? `${by}撤回了自己的一条消息 ${id}` : `${by} 的消息 ${id} 被 ${at} 撤回了`;
      return { head: head(data), body: `[${formatClock(data.timestamp)}] ${fact}` };
    }
    default:
      // 无渲染规则的类型不进入上下文输入，仍保留在事件流中。
      return undefined;
  }
}

/** 将一条 ishiki 消息渲染为上下文中的一行；非本命名空间返回 undefined。`domain` 缺省即无寻址头。 */
export function renderLine(message: AgentMessage, domain?: InstanceDomain): string | undefined {
  const parts = addressParts(message, domain);
  return parts === undefined ? undefined : `${parts.head}${parts.body}`;
}

/** 消息在体积统计与摘要输入中的文本：本命名空间按渲染行计，其余按消息内容计。 */
function renderText(message: AgentMessage, domain?: InstanceDomain): string {
  const line = renderLine(message, domain);
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
export function collapse(messages: readonly AgentMessage[], domain?: InstanceDomain): AgentMessage[] {
  const collapsed: AgentMessage[] = [];
  const lines: string[] = [];
  /** 当前这一段连续消息的寻址头；换频道即另起一段，于是头只在段首出现一次。 */
  let head: string | undefined;
  /** 窗口内见过的人名，供撤回行把 id 还原成昵称。 */
  const names = new Map<string, string>();

  const flush = (): void => {
    if (lines.length === 0) return;
    collapsed.push(createUserMessage(lines.join("\n")));
    lines.length = 0;
    head = undefined;
  };

  for (const message of messages) {
    if (message.role === "custom" && message.type === "ishiki.message.created") {
      const data: IshikiMessageCreated = message.data;
      names.set(data.user.id, displayName(data.user));
    }

    const parts = addressParts(message, domain, names);
    if (parts === undefined) {
      flush();
      collapsed.push(message);
      continue;
    }
    if (parts.body.length === 0) continue;

    // 同频道的连续消息合成一段：头只在第一行前出现，后续行直接接正文。换人说活不换段。
    if (head !== parts.head) {
      flush();
      head = parts.head;
      if (head.length > 0) lines.push(head);
    }
    lines.push(parts.body);
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
function findCut(tail: readonly AgentEntry[], head: number, target: number, domain?: InstanceDomain): number {
  let suffix = 0;
  for (const entry of tail) {
    if (entry.type === "message") suffix += renderText(entry.data, domain).length;
  }

  for (let at = 0; at < tail.length; at += 1) {
    const entry = tail[at];
    if (!(entry.type === "message")) continue;
    if ((entry.data.role === "user" || entry.data.role === "custom") && head + suffix <= target) return at;
    suffix -= renderText(entry.data, domain).length;
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
  /** 本实例的可见域；缺省即单频道视窗，行不带坐标。 */
  private readonly domain?: InstanceDomain;
  private readonly ceiling: number;
  private readonly target: number;
  /** 上一次装配是否超预算：后台压缩的触发条件。 */
  private over = false;
  private compacting?: Promise<void>;
  private abort?: AbortController;

  constructor(options: ContextEngineOptions, config: Partial<StandardContextConfig> = {}) {
    const maxChars = config.maxChars ?? DEFAULT_CONTEXT_CHARS;
    const refillRatio = config.refillRatio !== undefined && config.refillRatio > 0 && config.refillRatio <= 1 ? config.refillRatio : DEFAULT_REFILL_RATIO;
    super("standard", { maxChars, refillRatio });
    this.logger = options.logger;
    this.domain = options.domain;
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

    let size = head.length;
    for (const entry of tail) {
      if (entry.type === "message") size += renderText(entry.data, this.domain).length;
    }
    if (size <= this.ceiling) {
      this.over = false;
      return this.prepend(head, [...tail]);
    }

    this.over = true;
    const cut = findCut(tail, head.length, this.target, this.domain);
    if (cut < 0) {
      this.logger?.warn("context over budget with no valid cut point, entries passed through");
      return this.prepend(head, [...tail]);
    }
    return this.prepend(head, tail.slice(cut));
  };

  transformMessages = (messages: AgentMessage[]): AgentMessage[] => collapse(messages, this.domain);

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

    const cut = findCut(tail, head.length, this.target, this.domain);
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

    const material = dropped.map((entry) => renderText(entry.data, this.domain)).join("\n");
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
