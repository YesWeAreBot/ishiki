import type { Agent, AgentEntry, AgentEvent, AgentMessage } from "@yesimagent/core";
import type { Logger } from "koishi";

import type { IshikiEvent, IshikiMessageCreated } from "../types.js";
import { WakeupEngine, atSelf, registerWakeupEngine, type WakeupDecision, type WakeupEngineDeps } from "./engine.js";
import { StandardWakeupEngine, type StandardWakeupConfig } from "./standard.engine.js";

/**
 * jev 唤醒引擎：模型判定为主，规则只兜底。
 *
 * 默认每条消息都交给 Jev 判：state 是近期对话窗口加当前这条，问一个 noul「此刻该不该开口」，
 * 概率过阈值、且距自己上次开口过了冷却期，才 trigger。内嵌的 standard 规则只兜住失约代价最高
 * 的两种场景——私聊与 @（默认值）：判定服务抖动时它们照旧唤醒，平时省掉一次请求。
 *
 * 窗口与「自己说过的话」都由引擎自己从 agent 上取（见 `WakeupEngine.attach`），运行时不转述：
 * - 活的事实流来自 `agent.channel` 的 `message.appended`：每条投递都会发一次，trigger 与否都一样；
 * - 进程启动前的历史来自 `agent.storage`，挂载时补一次，重启后不至于空窗；
 * - 自己说过的话 = assistant 消息里 `send_message` 的工具调用参数。助手正文里那部分是内心话，
 *   没发出去，不算；发送失败时场景自己的记忆里也留着这句话，所以这里照样记。冷却的起点由它推出。
 *
 * 判定下限由内置判据承载（{@link CRITERIA}）：私聊默认该回、群聊默认别插话，问句与 criteria 按场景分档给出，
 * 不依赖模型自己从 state 里读出场景重量。用户的 `instruction` 是**补充**：身份、语气、什么时候该闭嘴都能写，
 * 原文进问句的 instructions 与内置判据并列，问句里写明是在 criteria 之上加约束、不替换它们；
 * 它是「怎么判」，不是「发生了什么」，所以不进 state。换言之，instruction 写得好是加分，写漏了也不塌下限。
 *
 * 三处刻意的取舍：
 * - 失败一律降级为 `wait` 并记日志，绝不抛：`decide` 的调用点在 `deliver` 的 try/catch 里，
 *   抛出去等于把这条消息整条丢掉，比漏一次唤醒更糟。
 * - instructions / criteria 用英文，state 保留原文：Jev 的主训练语言是英文，CJK 精度更低，
 *   判定靠 instructions 承载，不靠 state 的语言。
 * - 窗口里只放「说得出口的话」：别人投递进来的消息，和自己 send_message 的内容。别人的内心戏
 *   与本场景的工具往来都不进。
 */

/** 缺省值。写在 YAML 里的字段会覆盖它，越界值在 {@link normalize} 里挡掉。 */
const DEFAULT_JEV_WAKEUP: Omit<JevWakeupConfig, "apiKey"> = {
  model: "jev-latest",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  threshold: 0.5,
  cooldownMs: 30_000,
  timeoutMs: 1_500,
  historyMessages: 8,
  instruction: "",
  rules: { direct: true, atSelf: true, quoteSelf: false, keywords: [] },
};

/** 问句的 id。不进模型，只用来取回这条答案。 */
const QUESTION_ID = "should_reply";

/** 自己的话从哪个工具出去。助手消息里只有它算「说过」。 */
const SEND_MESSAGE_TOOL = "send_message";

/** 窗口里代表自己的作者名，判定请求里也这么写，问句里点明。 */
const SELF_AUTHOR = "self";

/**
 * 内置判据，按场景分两档。这是判定的下限：私聊里消息只可能是说给这个 bot 听的，默认该回；
 * 群聊里默认别插话，除非有人找它。用户的 `instruction` 只在它之上做补充，不替换它。
 */
const CRITERIA = {
  direct: {
    question: "The bot is chatting one-on-one in a direct chat. Should it answer `pending_message` now?",
    true: "In a direct chat `pending_message` is addressed to this bot: it expects an answer, or answering keeps the exchange going. Answering is the normal thing to do here.",
    false:
      "`pending_message` plainly does not expect an answer (a forwarded notice, a bare fragment with nothing to respond to), or `recent_messages` shows this bot already answered this very message.",
  },
  group: {
    question: "The bot is in a group chat with several people. Should it speak now, responding to `pending_message`?",
    true: "`pending_message` invites an answer: it mentions, quotes or names this bot, or continues a thread this bot is already in; or it asks a question that anyone in the chat could reasonably answer, this bot included. A reply that moves the conversation forward without interrupting others counts as well.",
    false: "`pending_message` is aimed at other people, is background chatter between others, or this bot speaking now would only add noise.",
  },
} as const;

/** 单条消息喂进去的字符上限，两条路径共用：state 有 32k 预算，窗口乘上单条长度要装得下。 */
const MAX_TEXT_CHARS = 400;

/** ponytail: 只防内存无界，按创建顺序淘汰，不是 LRU；真被淘汰的频道只是丢掉这段窗口。 */
const MAX_CHANNELS = 512;

/** 窗口上限的兜底，防止一行配置把整个上下文预算吃掉。 */
const MAX_HISTORY = 50;

export interface JevWakeupConfig {
  /** TypeSafe API key；缺省读 `TYPESAFE_API_KEY` 环境变量。 */
  apiKey: string;
  /** 模型别名或版本 ID。 */
  model: string;
  /** 判定端点，默认官方 v1/systemone。 */
  endpoint: string;
  /** 概率阈值：`p >= threshold` 才算「该开口」。 */
  threshold: number;
  /** 距自己上次开口多久内不再问模型；兜底规则不受它约束。 */
  cooldownMs: number;
  /** 单次判定等待上限（毫秒）。 */
  timeoutMs: number;
  /** 窗口里最多留几行对话（别人的与自己的一起算）。 */
  historyMessages: number;
  /**
   * 判定判据：这个 bot 是谁、什么语气、什么时候该闭嘴，都可以写在这里。
   * 原文进问句的 instructions（不是 state），与内置判据并存；留空则只按内置判据判。
   */
  instruction: string;
  /**
   * 兜底规则，语义与 standard 引擎完全一致（私聊 / @ / 引用自己 / 关键词）。
   * 命中即 trigger 且不发请求；默认只开私聊与 @，把引用与关键词留给模型。
   */
  rules: Partial<StandardWakeupConfig>;
}

/** 越界或非数就回落到默认值。 */
function atLeast(value: number | undefined, floor: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= floor ? value : fallback;
}

/** 非空字符串才算写了，空白与空串都按没写处理。 */
function orDefault(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/** 逐项收敛：配置是手写 YAML，越界值在这里挡掉，别让 NaN 或负数流进概率与窗口。 */
function normalize(config: Partial<JevWakeupConfig>): JevWakeupConfig {
  const merged = { ...DEFAULT_JEV_WAKEUP, ...config };

  const apiKey = orDefault(merged.apiKey, process.env.TYPESAFE_API_KEY ?? "");
  if (apiKey.length === 0) {
    throw new Error('wakeup engine "jev" needs an apiKey, or TYPESAFE_API_KEY in the environment');
  }

  return {
    apiKey,
    model: orDefault(merged.model, DEFAULT_JEV_WAKEUP.model),
    endpoint: orDefault(merged.endpoint, DEFAULT_JEV_WAKEUP.endpoint),
    threshold: Math.min(1, atLeast(merged.threshold, 0, DEFAULT_JEV_WAKEUP.threshold)),
    cooldownMs: atLeast(merged.cooldownMs, 0, DEFAULT_JEV_WAKEUP.cooldownMs),
    timeoutMs: atLeast(merged.timeoutMs, 100, DEFAULT_JEV_WAKEUP.timeoutMs),
    historyMessages: Math.min(MAX_HISTORY, Math.floor(atLeast(merged.historyMessages, 1, DEFAULT_JEV_WAKEUP.historyMessages))),
    instruction: merged.instruction ?? DEFAULT_JEV_WAKEUP.instruction,
    // 用户只写其中几项时，缺的那几项按本引擎的默认值补，而不是回到 standard 的全开默认。
    rules: { ...DEFAULT_JEV_WAKEUP.rules, ...merged.rules },
  };
}

/** 判定窗口里的一行。`self` 是自己发出去的话，作者名用 {@link SELF_AUTHOR}。 */
interface WindowLine {
  author: string;
  text: string;
  /** 这条消息自己的时刻，用于合并历史与排序。 */
  at: number;
  self: boolean;
}

/** 一个频道的本地状态：对话窗口，加上最后一次开口的时刻。 */
interface ChannelState {
  lines: WindowLine[];
  /** 自己最后开口的时刻；不从窗口推，免得被裁掉之后冷却跟着失效。 */
  lastSpokeAt?: number;
}

/**
 * 一条消息在窗口里算哪几行：别人的话是一行，自己的话藏在 `send_message` 的工具调用里。
 * 其余角色（system / user / tool）与其余事件类型都不进窗口。
 */
function linesOf(message: AgentMessage): WindowLine[] {
  if (message.role === "custom") {
    if (message.type !== "ishiki.message.created") return [];
    const data = message.data;
    return [{ author: data.user.name ?? data.user.id, text: data.content, at: message.timestamp, self: false }];
  }

  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

  const lines: WindowLine[] = [];
  for (const part of message.content) {
    if (part.type !== "tool-call" || part.toolName !== SEND_MESSAGE_TOOL) continue;
    const sent = (part.input as { messages?: unknown } | undefined)?.messages;
    if (!Array.isArray(sent)) continue;
    for (const text of sent) {
      if (typeof text === "string" && text.length > 0) lines.push({ author: SELF_AUTHOR, text, at: message.timestamp, self: true });
    }
  }
  return lines;
}

/** 超长就截断：state 装得下整段窗口，比塞进一条贴文更重要。 */
function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

export class JevWakeupEngine extends WakeupEngine<"jev"> {
  private readonly logger?: Logger;
  private readonly rules: StandardWakeupEngine;
  private readonly channels = new Map<string, ChannelState>();
  private readonly detachers = new Map<string, () => void>();
  /** 装载历史的进行中：`decide` 等它落地，免得重启后第一条判定看不见前情。 */
  private readonly seeded = new Map<string, Promise<void>>();

  constructor(config: Partial<JevWakeupConfig> = {}, deps: WakeupEngineDeps = {}) {
    super("jev", normalize(config));
    this.logger = deps.logger;
    this.rules = new StandardWakeupEngine(this.config.rules);
  }

  /** 订阅本频道的事实流，并把这之前的存储读进窗口。 */
  attach(agent: Agent, channelId: string): void {
    this.detachers.set(
      channelId,
      agent.channel.subscribe("agent", (event) => this.absorb(channelId, event)),
    );
    this.seeded.set(channelId, this.seed(agent, channelId));
    this.debug(channelId, "attached");
  }

  detach(channelId: string): void {
    this.detachers.get(channelId)?.();
    this.detachers.delete(channelId);
    this.seeded.delete(channelId);
    this.channels.delete(channelId);
    this.debug(channelId, "detached");
  }

  async decide(event: IshikiEvent): Promise<WakeupDecision> {
    if (event.type !== "ishiki.message.created") return "wait";

    const message = event.data;
    const channelId = message.channelId;
    // 判定在投递的关键路径上，所以日志里的 elapsed 记的是整条 `decide`，不是那一次请求。
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);

    await this.seeded.get(channelId);
    const channel = this.channelOf(channelId);

    // 兜底规则不问模型，也不改窗口：本条照常在投递后被追加。
    if (this.rules.decide(event) === "trigger") return this.report(channelId, "trigger", "rule", elapsed());

    // 冷却期内模型路径没有发言权，连请求都不发。
    const now = Date.now();
    if (!this.cooled(channel, now)) {
      const since = channel.lastSpokeAt === undefined ? 0 : Math.round((now - channel.lastSpokeAt) / 1000);
      return this.report(channelId, "wait", `cooldown since=${since}s`, elapsed());
    }

    const chance = await this.judge(message, channel);
    if (chance === undefined) return this.report(channelId, "wait", "model unavailable", elapsed());

    const threshold = this.config.threshold;
    const reason = `model chance=${chance.toFixed(2)} threshold=${threshold} window=${channel.lines.length}`;
    return this.report(channelId, chance >= threshold ? "trigger" : "wait", reason, elapsed());
  }

  /** 这个频道的窗口，供调用方观察（测试与排查用）。 */
  historyOf(channelId: string): ReadonlyArray<{ author: string; text: string }> {
    return this.channels.get(channelId)?.lines ?? [];
  }

  /** 取（必要时建）频道状态。 */
  private channelOf(channelId: string): ChannelState {
    const existing = this.channels.get(channelId);
    if (existing !== undefined) return existing;

    const created: ChannelState = { lines: [] };
    this.channels.set(channelId, created);
    if (this.channels.size > MAX_CHANNELS) {
      const oldest = this.channels.keys().next().value;
      if (oldest !== undefined) this.channels.delete(oldest);
    }
    return created;
  }

  /** 决策日志：每条消息一行，写明结论与依据；默认级别看不到，`logLevel: 3` 打开。 */
  private report(channelId: string, decision: WakeupDecision, reason: string, elapsedMs: number): WakeupDecision {
    this.debug(channelId, `${decision} ${reason} elapsed=${elapsedMs}ms`);
    return decision;
  }

  private debug(channelId: string, line: string): void {
    this.logger?.debug(`wakeup jev [${channelId}] ${line}`);
  }

  /** 事实流进来一条：接住消息、攒窗口；自己发出去的话再记下时刻，供冷却用。 */
  private absorb(channelId: string, event: AgentEvent): void {
    if (event.type !== "message.appended") return;

    const channel = this.channelOf(channelId);
    for (const line of linesOf(event.message)) {
      channel.lines.push(line);
      if (line.self) channel.lastSpokeAt = Math.max(channel.lastSpokeAt ?? 0, line.at);
    }
    this.trim(channel);
  }

  /** 进程启动前的事实：把存储里的窗口补进来，与已经到手的活事件按时间合起来。 */
  private async seed(agent: Agent, channelId: string): Promise<void> {
    let entries: readonly AgentEntry[];
    try {
      entries = await agent.storage.read();
    } catch (error) {
      // 存储读不动不该让这个场景从此不醒：窗口空着也照样判，只是没有前情。
      this.logger?.warn(`wakeup jev: history unavailable, judging without it: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const stored: WindowLine[] = [];
    for (const entry of entries) {
      if (entry.type === "message") stored.push(...linesOf(entry.data));
    }
    if (stored.length === 0) return;

    const channel = this.channelOf(channelId);
    channel.lines = [...stored, ...channel.lines].sort((left, right) => left.at - right.at);
    for (const line of channel.lines) {
      if (line.self) channel.lastSpokeAt = Math.max(channel.lastSpokeAt ?? 0, line.at);
    }
    this.trim(channel);
    this.debug(channelId, `history ${stored.length} line(s) folded in`);
  }

  /** 窗口只留最近 `historyMessages` 行。 */
  private trim(channel: ChannelState): void {
    const keep = this.config.historyMessages;
    if (channel.lines.length > keep) channel.lines.splice(0, channel.lines.length - keep);
  }

  /** 冷却是否已过：从没开过口就算过了。 */
  private cooled(channel: ChannelState, now: number): boolean {
    if (channel.lastSpokeAt === undefined) return true;
    return now - channel.lastSpokeAt >= this.config.cooldownMs;
  }

  /** 一次判定：拿不到概率就返回 undefined，调用方据此判 `wait`。 */
  private async judge(message: IshikiMessageCreated, channel: ChannelState): Promise<number | undefined> {
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(this.request(message, channel)),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (!response.ok) {
        this.logger?.warn(`wakeup jev: HTTP ${response.status} ${response.statusText}`);
        return undefined;
      }

      const payload = (await response.json()) as { answers?: Record<string, { noul?: unknown } | undefined> };
      const noul = payload.answers?.[QUESTION_ID]?.noul;
      if (typeof noul !== "number" || !Number.isFinite(noul)) {
        this.logger?.warn(`wakeup jev: answer "${QUESTION_ID}" is not a number`);
        return undefined;
      }
      return Math.min(1, Math.max(0, noul));
    } catch (error) {
      this.logger?.warn(`wakeup jev: judgement unavailable, waiting: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 请求体：state 是「刚才都说了什么 + 这条是什么」，问句只有一条 noul。
   * 问句与 `criteria` 由场景分档给出（{@link CRITERIA}），承载判定的下限；用户的 `instruction` 只做补充，
   * 它会随问句一起进 instructions（TypeSafe 的结构化 instructions 写法），问句里写明是在 criteria 之上加约束。
   */
  private request(message: IshikiMessageCreated, channel: ChannelState) {
    const instruction = this.config.instruction.trim();
    const tier = message.isDirect ? CRITERIA.direct : CRITERIA.group;
    const fields = `\`state.scene\`, \`recent_messages\` (author "${SELF_AUTHOR}" marks this bot's own earlier messages) and \`pending_message\``;

    return {
      model: this.config.model,
      state: {
        scene: {
          type: message.isDirect ? "direct" : "group",
          seconds_since_bot_last_spoke: channel.lastSpokeAt === undefined ? null : Math.max(0, Math.round((Date.now() - channel.lastSpokeAt) / 1000)),
        },
        recent_messages: channel.lines.map((line) => ({ author: line.author, text: clip(line.text) })),
        pending_message: {
          author: message.user.name ?? message.user.id,
          text: clip(message.content),
          mentions_bot: atSelf(message.content, message.selfId),
          replies_to_bot: message.quote?.user?.id === message.selfId,
        },
      },
      questions: {
        [QUESTION_ID]: {
          type: "noul",
          instructions:
            instruction.length > 0
              ? {
                  instruction,
                  question: `${tier.question} Judge it from ${fields}, exactly as \`criteria\` describe; then apply \`instruction\` — extra guidance from this bot's owner — on top of them, without replacing them.`,
                }
              : `${tier.question} Judge it from ${fields}, exactly as \`criteria\` describe.`,
          criteria: {
            true: tier.true,
            false: tier.false,
          },
        },
      },
    };
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    jev: JevWakeupConfig;
  }
}

registerWakeupEngine("jev", (config, deps) => new JevWakeupEngine(config, deps));
