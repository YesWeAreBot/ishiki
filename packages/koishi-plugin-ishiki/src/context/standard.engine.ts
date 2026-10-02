import { createEntry, createUserMessage, generateText, type Agent, type AgentEntry, type AgentMessage } from "@yesimagent/core";
import type { Context, Logger } from "koishi";

import type { InstanceDomain } from "../domain.js";
import type { IshikiMessageCreated, IshikiMessageDeleted } from "../types.js";
import { ContextEngine, type ContextEngineInstance, type ContextEngineOptions } from "./engine.js";

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
const DEFAULT_CONTEXT_CHARS = 32_000;

export interface StandardContextConfig {
  model?: string;
  /** 单轮模型输入的文本上限（字符数）；超出时最旧的几轮退出模型视野，交给后台并入摘要。 */
  maxChars: number;
  /** 首选水位比例。0.8 表示尽量压到 `maxChars * 0.8`；裁剪粒度是一整轮，跨过水位的那一轮仍会留下。 */
  refillRatio?: number;
}

/** 摘要行的固定首行标记。 */
const MEMORY_HEAD = "（以下是此前的对话记录，已压缩为摘要）";
const DEFAULT_REFILL_RATIO = 0.8;

/** 两位补零。 */
const pad = (value: number): string => value.toString().padStart(2, "0");

/** 渲染行的时间部分，格式 `MM-DD HH:mm`；与 v3 引擎一致，跨日时日期是唯一线索。 */
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

/** 流里的轮边界下标：core 在每轮开始写一条 `turn.start` 事件条目。 */
function turnStarts(tail: readonly AgentEntry[]): number[] {
  const starts: number[] = [];
  for (let at = 0; at < tail.length; at += 1) {
    const entry = tail[at];
    if (entry.type === "event" && entry.data.type === "turn.start") starts.push(at);
  }
  return starts;
}

/**
 * 切点：以轮为单位，从最新一轮往前整轮纳入，返回保留段在 `tail` 里的下标。
 *
 * 按轮而不是按行。一轮被切掉半截，模型会看见自己没做完的动作和没有出处的工具结果；而按行的
 * 「能容纳的最大后缀」规则下，单条大消息就能把窗口顶到只剩最新一行——上一整轮就此消失，
 * 摘要却还停在上上次压缩的水位。轮边界天然不含半个 tool 配对，于是也不必再避开工具轨迹。
 *
 * 预算分两档：`target` 是首选水位，`ceiling` 是硬上限。粒度是一整轮，所以允许跨过水位的那一轮
 * 整轮留下（不越过 `ceiling`），再往前的轮次一律不纳入；最新一轮无论多大都留下，预算在这里是软的。
 * 流里没有轮边界时返回 0（整段放行）：没有边界就没有安全的切点。
 */
function findCut(tail: readonly AgentEntry[], head: number, target: number, ceiling: number, domain?: InstanceDomain): number {
  const starts = turnStarts(tail);
  if (starts.length === 0) return 0;

  // 每一段的可见字符数：段 = 一个轮边界到下一个轮边界，最后一段到流尾。
  const segments: number[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const to = index + 1 < starts.length ? starts[index + 1] : tail.length;
    let size = 0;
    for (let at = starts[index]; at < to; at += 1) {
      const entry = tail[at];
      if (entry.type === "message") size += renderText(entry.data, domain).length;
    }
    segments.push(size);
  }

  let picked = segments.length - 1;
  let size = head + segments[picked];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    size += segments[index];
    if (size > ceiling) break;
    picked = index;
    if (size > target) break;
  }
  return starts[picked];
}

/**
 * 线性增长 + 空闲压缩，两条轨道各自独立：
 *
 * - 前台 `prepareEntries` 只做同步裁剪：预算内原样交给模型，超预算就把最旧的几轮切出模型视野，
 *   并把切到哪一条记在 `hidden` 上。这一步不调模型，任何一轮的附加延迟都是零。
 * - 后台 `finishTurn` 在一轮结束之后，把 `hidden` 记下的那段并进摘要，水位以 `ishiki.compact`
 *   条目追加到流中。压缩成功前聊天照常进行；压缩失败不影响本轮，下一轮结束再试。
 *
 * 切点只在前台算一次。后台读到的流比前台长（本轮自己的产出已经落盘），同一个预算重算只会得出更晚
 * 或根本不存在的切点，前台已经藏起来的那段就永远进不了摘要——这里以「前台决定、后台照搬」换掉那种重算。
 *
 * 除压缩成功时追加的那一条 compact 外，本引擎只读不写。
 */
export class StandardContextInstance implements ContextEngineInstance {
  public readonly config: StandardContextConfig;

  private agent?: Agent;
  private readonly logger?: Logger;
  /** 本实例的可见域；缺省即单频道视窗，行不带坐标。 */
  private readonly domain?: InstanceDomain;
  private readonly ceiling: number;
  private readonly target: number;
  /** 上一次装配是否超预算：后台压缩的触发条件。 */
  private over = false;
  /** 上一次装配切到哪一条（被切掉的最后一条条目）：后台照此折叠，不重算切点。 */
  private hidden?: string;
  private compacting?: Promise<void>;
  private abort?: AbortController;

  constructor(config: Partial<StandardContextConfig>, options: ContextEngineOptions) {
    const maxChars = config.maxChars ?? DEFAULT_CONTEXT_CHARS;
    const refillRatio = config.refillRatio !== undefined && config.refillRatio > 0 && config.refillRatio <= 1 ? config.refillRatio : DEFAULT_REFILL_RATIO;
    this.config = { maxChars, refillRatio };
    this.logger = options.logger;
    this.domain = options.domain;
    this.ceiling = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0;
    this.target = this.ceiling * refillRatio;
    if (this.ceiling === 0) this.logger?.warn("context budget disabled: maxChars is non-positive, compaction off");
  }

  /**
   * 压缩要读流、写摘要、调模型，都得从这里拿。引擎不预先持有 storage 与 model：
   * 两者都是 agent 自己的东西，早于 agent 造实例等于抄一份可能过期的引用。
   * 顺带的收益是压缩读到的流与 core 读的是同一个 storage，不会读到副本。
   *
   * 压缩挂在轮次结束事件上，而不是 core 的轮次钩子：钩子的返回值会被 core  awaited，
   * 压缩一旦慢了或失败，轮次收尾就跟着拖。事件通道对 listener 是 `Promise.all` 加 try/catch，
   * 压不坏也等不起的东西本就不该进那条关键路径。
   */
  attach(agent: Agent): () => void {
    this.agent = agent;
    const unsubscribe = agent.channel.subscribe("agent", (event) => {
      if (event.type === "turn.done") this.finishTurn();
    });
    return () => {
      this.abort?.abort();
      this.agent = undefined;
      unsubscribe();
    };
  }

  /**
   * 摘要与水位之后的尾部。水位按 `lastEntryId` 找条目，不按 `ishiki.compact` 的物理落点：
   * 压缩条目永远追加在流尾，而它记的那一段在流的中段。
   */
  private window(entries: readonly AgentEntry[]): { summary?: string; tail: readonly AgentEntry[]; head: string } {
    const compact = lastCompact(entries);
    const anchor = compact === undefined ? -1 : entries.findIndex((entry) => entry.id === compact.data.lastEntryId);
    if (compact !== undefined && anchor < 0) this.logger?.warn(`memory anchor ${compact.data.lastEntryId} not found in stream, memory ignored`);
    if (compact === undefined || anchor < 0) return { tail: entries, head: "" };
    return { summary: compact.data.summary, tail: entries.slice(anchor + 1), head: `${MEMORY_HEAD}\n${compact.data.summary}` };
  }

  /** 前台：只裁窗口，不调模型。 */
  prepareEntries(entries: readonly AgentEntry[]) {
    if (this.ceiling === 0) return entries;

    const { tail, head } = this.window(entries);

    let size = head.length;
    for (const entry of tail) {
      if (entry.type === "message") size += renderText(entry.data, this.domain).length;
    }
    if (size <= this.ceiling) {
      this.over = false;
      return this.prepend(head, [...tail]);
    }

    this.over = true;
    const cut = findCut(tail, head.length, this.target, this.ceiling, this.domain);
    if (cut === 0) {
      this.logger?.warn("context over budget with no turn boundary, entries passed through");
      return this.prepend(head, [...tail]);
    }
    // 记在被切掉的最后一条上：下一次装配从它之后取窗口，后台也折叠到它。
    this.hidden = tail[cut - 1].id;
    return this.prepend(head, tail.slice(cut));
  }

  renderMessages(messages: readonly AgentMessage[]) {
    return collapse(messages, this.domain);
  }

  /** 一轮结束后，若刚才是超预算装配的，把切掉的那段并进摘要。不阻塞任何东西。 */
  private finishTurn(): void {
    if (!this.over || this.compacting !== undefined) return;
    this.compacting = this.compact().finally(() => {
      this.compacting = undefined;
    });
  }

  /** 等在做的那次压缩收尾。 */
  async settle(): Promise<void> {
    await this.compacting;
  }

  /** 把前台切掉的那一段并入摘要，水位以 compact 条目追加到流中。全程在后台，失败只记一条日志。 */
  private async compact(): Promise<void> {
    const agent = this.agent;
    if (agent === undefined) return;

    const through = this.hidden;
    if (through === undefined) {
      // 前台这一轮没切任何东西：没有要并入摘要的段落。
      this.over = false;
      return;
    }

    const { summary: previous, tail } = this.window(await agent.storage.read());
    const end = tail.findIndex((entry) => entry.id === through);
    if (end < 0) {
      this.logger?.warn(`hidden range ${through} left the stream, compaction skipped`);
      this.over = false;
      this.hidden = undefined;
      return;
    }
    const dropped = tail.slice(0, end + 1).filter((entry): entry is AgentEntry<"message"> => entry.type === "message");
    if (dropped.length === 0) {
      // 切出去的全是事件条目：摘要没有可记的东西，只把水位推过去。
      await agent.storage.append(createEntry("ishiki.compact", { summary: previous ?? "", lastEntryId: through }));
      this.over = false;
      this.hidden = undefined;
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    try {
      const summary = await this.summarize(previous, dropped, abort.signal);
      // 失败就留着 `over` 与 `hidden`，下一轮结束再试；本轮与后续轮次照常跑。
      // 停止之后才回来的摘要一律丢掉：这条流已经不属于任何活着的实例了。
      if (summary === undefined || abort.signal.aborted) return;
      // 直接写入存储：该条目是关于流的元数据，不经过 onAppend 的条目处理。
      await agent.storage.append(createEntry("ishiki.compact", { summary, lastEntryId: through }));
      // 这一轮又切了更远的一段（压缩在跑时流里已出现新内容）：留着它，下一轮结束接着折。
      if (this.hidden === through) {
        this.hidden = undefined;
        this.over = false;
      }
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

/** standard 的 provider：没有插件级配置，只把 profile/scene 合出来的参数交给运行体。 */
export class StandardContextEngine extends ContextEngine<"standard"> {
  constructor(ctx: Context) {
    super(ctx, "standard");
  }

  create(config: Partial<StandardContextConfig>, options: ContextEngineOptions): ContextEngineInstance {
    return new StandardContextInstance(config, options);
  }
}
