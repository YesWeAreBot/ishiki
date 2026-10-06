import type { Agent, AgentMessage } from "@yesimagent/core";
import { Service, type Context } from "koishi";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import { type IshikiEvent, type IshikiMessageCreated } from "../types.js";
import { atSelf, WakeupEngine, type WakeupDecision, type WakeupEngineInstance, type WakeupEngines } from "./engine.js";

const DEFAULT_V3_WAKEUP: V3WakeupConfig = {
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

export interface V3WakeupConfig {
  base: number;
  atMention: number;
  isQuote: number;
  isDirectMessage: number;
  keywords: string[];
  keywordMultiplier: number;
  defaultMultiplier: number;
  maxWillingness: number;
  decayHalfLifeSeconds: number;
  probabilityThreshold: number;
  probabilityAmplifier: number;
  replyCost: number;
}

function atLeast(value: number, floor: number, fallback: number): number {
  return Number.isFinite(value) && value >= floor ? value : fallback;
}

function normalize(config: V3WakeupConfig): V3WakeupConfig {
  return {
    ...config,
    maxWillingness: atLeast(config.maxWillingness, 1, DEFAULT_V3_WAKEUP.maxWillingness),
    decayHalfLifeSeconds: atLeast(config.decayHalfLifeSeconds, 1, DEFAULT_V3_WAKEUP.decayHalfLifeSeconds),
    probabilityThreshold: atLeast(config.probabilityThreshold, 0, DEFAULT_V3_WAKEUP.probabilityThreshold),
    probabilityAmplifier: atLeast(config.probabilityAmplifier, 0, DEFAULT_V3_WAKEUP.probabilityAmplifier),
    replyCost: atLeast(config.replyCost, 0, DEFAULT_V3_WAKEUP.replyCost),
  };
}

function decay(score: number, elapsedMs: number, config: V3WakeupConfig): number {
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

function dynamicGainMultiplier(score: number, max: number): number {
  const ratio = score / max;

  if (ratio < 0.2) return 1;
  if (ratio < 0.8) return Math.max(1, -(((ratio - 0.5) * 2) ** 2) + 2);
  return 1 - (ratio - 0.8) / 0.2;
}

function readChannelId(message: AgentMessage): string | undefined {
  if (message.role !== "custom") return undefined;
  switch (message.type) {
    case "ishiki.message.created":
    case "ishiki.message.deleted":
      return message.data.channelId;
    default:
      return undefined;
  }
}

interface ChannelWillingness {
  score: number;
  updatedAt: number;
}

export class V3WakeupInstance implements WakeupEngineInstance {
  public readonly config: V3WakeupConfig;

  private readonly channels = new Map<string, ChannelWillingness>();

  constructor(config: Partial<V3WakeupConfig> = {}) {
    this.config = normalize({ ...DEFAULT_V3_WAKEUP, ...config });
  }

  attach(agent: Agent): () => void {
    const seen = new Set<string>();
    const unsubscribe = agent.channel.subscribe("agent", (event) => {
      if (event.type === "message.appended") {
        const channelId = readChannelId(event.message);
        if (channelId !== undefined) seen.add(channelId);
        return;
      }
      if (event.type === "turn.done") {
        for (const channelId of seen) this.observe(channelId);
      }
    });

    return () => {
      unsubscribe();
      for (const channelId of seen) this.channels.delete(channelId);
    };
  }

  decide(event: IshikiEvent): WakeupDecision {
    if (event.type !== "ishiki.message.created") return "wait";

    const now = Date.now();
    const score = this.accumulate(event.data, now);
    return Math.random() < this.probability(score) ? "trigger" : "wait";
  }

  observe(channelId: string): void {
    const now = Date.now();
    const state = this.channels.get(channelId);
    if (state === undefined) return;
    const score = Math.max(0, decay(state.score, now - state.updatedAt, this.config) - this.config.replyCost);
    this.channels.set(channelId, { score, updatedAt: now });
  }

  score(channelId: string): number {
    const state = this.channels.get(channelId);
    return state === undefined ? 0 : decay(state.score, Date.now() - state.updatedAt, this.config);
  }

  private accumulate(message: IshikiMessageCreated, now: number): number {
    const state = this.channels.get(message.channelId);
    const decayed = state === undefined ? 0 : decay(state.score, now - state.updatedAt, this.config);

    const gain = this.gain(message, decayed) * dynamicGainMultiplier(decayed, this.config.maxWillingness);
    const next = Math.min(decayed + gain, this.config.maxWillingness);
    this.channels.set(message.channelId, { score: next, updatedAt: now });
    return next;
  }

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

  private probability(score: number): number {
    const { probabilityThreshold, probabilityAmplifier } = this.config;
    if (score <= probabilityThreshold) return 0;
    return Math.max(0, Math.min(1, (score - probabilityThreshold) * probabilityAmplifier));
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    v3: V3WakeupConfig;
  }
}

export class V3WakeupEngine extends WakeupEngine<"v3"> {
  constructor(ctx: Context) {
    super(ctx, "v3");
  }

  public [Service.invoke](config: EngineConfig<Pick<WakeupEngines, "v3">>, _context: ExtensionContext): WakeupEngineInstance {
    return new V3WakeupInstance(config.v3 ?? {});
  }
}
