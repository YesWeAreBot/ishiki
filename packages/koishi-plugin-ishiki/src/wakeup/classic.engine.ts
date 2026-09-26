import type { IshikiEvent, IshikiMessageCreated } from "../types.js";
import { WakeupEngine, atSelf, registerWakeupEngine, type WakeupDecision } from "./engine.js";

/**
 * classic 唤醒引擎：YesImBot v3 的响应意愿（Willingness）。
 *
 * 每个频道攒一个意愿值：来一条消息就按「基础分 + 属性加成 × 兴趣系数 × 边际递减」加分，
 * 闲下来按半衰期衰减，分数越过阈值后以线性概率掷骰决定要不要说话，说过一轮就扣掉成本。
 *
 * 与 v3 的两处机制差异（都是刻意为之，不是遗漏）：
 * - v3 用 1 秒定时器逐秒衰减，这里改成**惰性**：在 `decide` / `observe` 时把距上次写入的
 *   时间一次折算完。数学等价，但没有常驻循环（引擎也拿不到宿主定时器）。
 * - v3 的「对话热度」两档依赖一个从未被写入的时间戳 Map，恒不命中；`boostSkippedTopic`
 *   也没有调用方。两者都不搬。
 */

/** v3 `agent/config.ts:87-130` 的默认值。 */
const DEFAULT_CLASSIC_WAKEUP: ClassicWakeupConfig = {
  base: 12,
  atMention: 100,
  isQuote: 15,
  isDirectMessage: 40,
  keywords: [],
  keywordMultiplier: 1.2,
  defaultMultiplier: 1,
  maxWillingness: 100,
  decayHalfLifeSeconds: 600,
  probabilityThreshold: 55,
  probabilityAmplifier: 0.04,
  replyCost: 35,
};

export interface ClassicWakeupConfig {
  /** 一条消息的基础分。 */
  base: number;
  /** 被 @ 时的加成；与引用、私聊可叠加。 */
  atMention: number;
  /** 引用本账号消息时的加成。 */
  isQuote: number;
  /** 私聊消息的加成。 */
  isDirectMessage: number;
  /** 命中任一关键词即改用 `keywordMultiplier`。 */
  keywords: string[];
  keywordMultiplier: number;
  defaultMultiplier: number;
  /** 意愿值上限。 */
  maxWillingness: number;
  /** 衰减半衰期，秒。 */
  decayHalfLifeSeconds: number;
  /** 概率从 0 起跳的意愿阈值。 */
  probabilityThreshold: number;
  /** 阈值之上的每点意愿对应的概率增量。 */
  probabilityAmplifier: number;
  /** 一轮结束后扣掉的意愿。 */
  replyCost: number;
}

/** 越界或非数就回落到默认值。 */
function atLeast(value: number, floor: number, fallback: number): number {
  return Number.isFinite(value) && value >= floor ? value : fallback;
}

/** 逐项收敛到 v3 Schema 的取值域：配置是手写 YAML，越界的值在这里挡掉，别让 NaN 流进概率。 */
function normalize(config: ClassicWakeupConfig): ClassicWakeupConfig {
  return {
    ...config,
    maxWillingness: atLeast(config.maxWillingness, 1, DEFAULT_CLASSIC_WAKEUP.maxWillingness),
    decayHalfLifeSeconds: atLeast(config.decayHalfLifeSeconds, 1, DEFAULT_CLASSIC_WAKEUP.decayHalfLifeSeconds),
    probabilityThreshold: atLeast(config.probabilityThreshold, 0, DEFAULT_CLASSIC_WAKEUP.probabilityThreshold),
    probabilityAmplifier: atLeast(config.probabilityAmplifier, 0, DEFAULT_CLASSIC_WAKEUP.probabilityAmplifier),
    replyCost: atLeast(config.replyCost, 0, DEFAULT_CLASSIC_WAKEUP.replyCost),
  };
}

/**
 * 把「距上次写入过了多久」折算成衰减，等价于 v3 每秒乘一次因子。
 *
 * 高于阈值时衰减强度减半，所以分两段：先按减半的强度逐秒走到阈值（这段最多几百次），
 * 剩下的用闭式幂一次算完。`score < 0.01` 归零，与 v3 一致。
 */
function decay(score: number, elapsedMs: number, config: ClassicWakeupConfig): number {
  if (score === 0) return 0;

  let seconds = Math.floor(elapsedMs / 1000);
  const baseFactor = 0.5 ** (1 / config.decayHalfLifeSeconds);
  const slowFactor = 1 - (1 - baseFactor) * 0.5;

  while (seconds > 0 && score > config.probabilityThreshold) {
    score *= slowFactor;
    seconds -= 1;
  }
  if (seconds > 0) score *= baseFactor ** seconds;

  return score < 0.01 ? 0 : score;
}

/** v3 的 S 型曲线：0.2 以下不放大，0.2–0.8 放大到峰值 2 倍，0.8 以上线性回落到 0。 */
function dynamicGainMultiplier(score: number, max: number): number {
  const ratio = score / max;

  if (ratio < 0.2) return 1;
  if (ratio < 0.8) return Math.max(1, -(((ratio - 0.5) * 2) ** 2) + 2);
  return 1 - (ratio - 0.8) / 0.2;
}

/** 一个频道的意愿值，以及它最后一次被写入的时刻（惰性衰减的起点）。 */
interface ChannelWillingness {
  score: number;
  updatedAt: number;
}

export class ClassicWakeupEngine extends WakeupEngine<"classic"> {
  private readonly channels = new Map<string, ChannelWillingness>();

  constructor(config: Partial<ClassicWakeupConfig> = {}) {
    super("classic", normalize({ ...DEFAULT_CLASSIC_WAKEUP, ...config }));
  }

  decide(event: IshikiEvent): WakeupDecision {
    if (event.type !== "ishiki.message.created") return "wait";

    const now = Date.now();
    const score = this.accumulate(event.data, now);
    return Math.random() < this.probability(score) ? "trigger" : "wait";
  }

  /** 一轮结束：补掉这期间的自然衰减，再扣掉回复成本。 */
  observe(channelId: string): void {
    const state = this.channels.get(channelId);
    if (state === undefined) return;

    const now = Date.now();
    const score = Math.max(0, decay(state.score, now - state.updatedAt, this.config) - this.config.replyCost);
    this.channels.set(channelId, { score, updatedAt: now });
  }

  /** 当前意愿值，供调用方观察（测试与排查用）。 */
  scoreOf(channelId: string): number {
    const state = this.channels.get(channelId);
    return state === undefined ? 0 : decay(state.score, Date.now() - state.updatedAt, this.config);
  }

  /** 先补衰减再加本条消息的增益（增益要过一遍 S 型曲线），写回并返回。 */
  private accumulate(message: IshikiMessageCreated, now: number): number {
    const state = this.channels.get(message.channelId);
    const decayed = state === undefined ? 0 : decay(state.score, now - state.updatedAt, this.config);

    const gain = this.gain(message, decayed) * dynamicGainMultiplier(decayed, this.config.maxWillingness);
    const next = Math.min(decayed + gain, this.config.maxWillingness);
    this.channels.set(message.channelId, { score: next, updatedAt: now });
    return next;
  }

  /** v3 的增益：基础分 + 属性加成（可叠加），乘兴趣系数，再乘边际递减。 */
  private gain(message: IshikiMessageCreated, score: number): number {
    const config = this.config;

    let base = config.base;
    if (atSelf(message.content, message.selfId)) base += config.atMention;
    if (message.quote?.user?.id === message.selfId) base += config.isQuote;
    if (message.isDirect) base += config.isDirectMessage;

    const hasKeyword = config.keywords.some((keyword) => message.content.includes(keyword));
    const raw = base * (hasKeyword ? config.keywordMultiplier : config.defaultMultiplier);
    return raw * Math.max(0, 1 - (score / config.maxWillingness) ** 2);
  }

  /** v3 的概率换算：阈值及以下恒 0，之上线性放大，最后夹到 [0, 1]。 */
  private probability(score: number): number {
    const { probabilityThreshold, probabilityAmplifier } = this.config;
    if (score <= probabilityThreshold) return 0;
    return Math.max(0, Math.min(1, (score - probabilityThreshold) * probabilityAmplifier));
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    classic: ClassicWakeupConfig;
  }
}

registerWakeupEngine("classic", (config) => new ClassicWakeupEngine(config));
