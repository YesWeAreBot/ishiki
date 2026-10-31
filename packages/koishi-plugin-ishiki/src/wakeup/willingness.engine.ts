import type { Agent, AgentEvent } from "@yesimagent/core";
import { h, Service, type Context } from "koishi";
import Schema from "schemastery";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import type { IshikiMessageCreated } from "../types/messages.js";
import { WakeupEngine, type WakeupEngineInstance, type WakeupEngines } from "./engine.js";

const SEND_MESSAGE_TOOL = "send_message";
const CODEMODE_TOOL = "codemode";
const MAX_STATES = 512;
const MAX_TURNS = 512;
const MAX_ATTACHMENTS = 1024;

export interface WillingnessAddress {
  platform: string;
  selfId: string;
  channelId: string;
}

export interface WillingnessWakeupConfig {
  base: number;
  atMention: number;
  isQuote: number;
  isDirectMessage: number;
  imageGain: number;
  keywords: string[];
  keywordMultiplier: number;
  defaultMultiplier: number;
  maxWillingness: number;
  initialWillingness: number;
  decayHalfLifeSeconds: number;
  hotWindowSeconds: number;
  warmWindowSeconds: number;
  hotDecayWeight: number;
  warmDecayWeight: number;
  probabilityThreshold: number;
  probabilityAmplifier: number;
  replyCost: number;
  atMentionForce: boolean;
  quoteForce: boolean;
  directForce: boolean;
  participationWindowSeconds: number;
  participationInfluence: number;
}

export const WillingnessWakeupConfig = Schema.object({
  base: Schema.number().min(0).default(12).description("每条消息的基础意愿值"),
  atMention: Schema.number().min(0).default(100).description("提及机器人时增加的意愿值"),
  isQuote: Schema.number().min(0).default(15).description("引用机器人消息时增加的意愿值"),
  isDirectMessage: Schema.number().min(0).default(40).description("私聊消息增加的意愿值"),
  imageGain: Schema.number().min(0).default(8).description("消息包含图片时增加的意愿值"),
  keywords: Schema.array(Schema.string()).default([]).description("提高意愿值的关注词"),
  keywordMultiplier: Schema.number().min(0).default(1.2).description("关注词带来的意愿增益倍率"),
  defaultMultiplier: Schema.number().min(0).default(1).description("没有关注词时的意愿增益倍率"),
  maxWillingness: Schema.number().min(1).default(100).description("意愿值上限"),
  initialWillingness: Schema.number().min(0).default(0).description("频道首次出现时的意愿值"),
  decayHalfLifeSeconds: Schema.number().min(1).default(600).description("意愿值衰减到一半所需的加权秒数"),
  hotWindowSeconds: Schema.number().min(0).max(86_400).default(15).description("热对话窗口的秒数"),
  warmWindowSeconds: Schema.number().min(0).max(86_400).default(60).description("温对话窗口的秒数"),
  hotDecayWeight: Schema.number().min(0).max(1).default(0.3).description("热对话窗口的衰减权重"),
  warmDecayWeight: Schema.number().min(0).max(1).default(0.7).description("温对话窗口的衰减权重"),
  probabilityThreshold: Schema.number().min(0).default(55).description("开始产生回复概率的意愿阈值"),
  probabilityAmplifier: Schema.number().min(0).default(0.04).description("超过阈值后每个意愿点增加的概率"),
  replyCost: Schema.number().min(0).default(35).description("成功发送消息后扣除的意愿值"),
  atMentionForce: Schema.boolean().default(false).description("提及机器人时直接唤醒"),
  quoteForce: Schema.boolean().default(false).description("引用机器人消息时直接唤醒"),
  directForce: Schema.boolean().default(false).description("收到私聊消息时直接唤醒"),
  participationWindowSeconds: Schema.number().min(0).max(86_400).default(60).description("成功回复后保留参与加成的秒数"),
  participationInfluence: Schema.number().min(0).max(1).default(0.5).description("参与窗口内最高的额外增益比例"),
});

const DEFAULT_WILLINGNESS: WillingnessWakeupConfig = {
  base: 12,
  atMention: 100,
  isQuote: 15,
  isDirectMessage: 40,
  imageGain: 8,
  keywords: [],
  keywordMultiplier: 1.2,
  defaultMultiplier: 1,
  maxWillingness: 100,
  initialWillingness: 0,
  decayHalfLifeSeconds: 600,
  hotWindowSeconds: 15,
  warmWindowSeconds: 60,
  hotDecayWeight: 0.3,
  warmDecayWeight: 0.7,
  probabilityThreshold: 55,
  probabilityAmplifier: 0.04,
  replyCost: 35,
  atMentionForce: false,
  quoteForce: false,
  directForce: false,
  participationWindowSeconds: 60,
  participationInfluence: 0.5,
};

interface ParticipationState {
  participantId: string;
  lastReplyAt: number;
  expiresAt: number;
}

interface ChannelState {
  score: number;
  lastMessageAt: number;
  lastDecayAt: number;
  lastUserId: string;
  participation?: ParticipationState;
}

interface TurnState {
  source?: string;
  sends: Set<string>;
  pending: Map<string, string | undefined>;
}

interface MessageTraits {
  mentionsSelf: boolean;
  mentionsOther: boolean;
  quotesSelf: boolean;
  quotesOther: boolean;
  hasImage: boolean;
}

function addressKey(address: WillingnessAddress): string {
  return JSON.stringify([address.platform, address.selfId, address.channelId]);
}

function messageKey(address: WillingnessAddress, messageId: string): string {
  return JSON.stringify([address.platform, address.selfId, address.channelId, messageId]);
}

function addressOf(message: IshikiMessageCreated): WillingnessAddress {
  return { platform: message.platform, selfId: message.selfId, channelId: message.channelId };
}

function channelDomainAddress(context: ExtensionContext): WillingnessAddress | undefined {
  if (context.domain.mode !== "channel") return undefined;
  return { platform: context.domain.platform, selfId: context.domain.selfId, channelId: context.domain.channelId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function numberWithin(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function numberAtLeast(value: unknown, minimum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return fallback;
  return value;
}

function normalize(config: Partial<WillingnessWakeupConfig>): WillingnessWakeupConfig {
  const merged = { ...DEFAULT_WILLINGNESS, ...config };
  const maxWillingness = numberAtLeast(merged.maxWillingness, 1, DEFAULT_WILLINGNESS.maxWillingness);
  const hotWindowSeconds = numberWithin(merged.hotWindowSeconds, 0, 86_400, DEFAULT_WILLINGNESS.hotWindowSeconds);
  const warmWindowSeconds = Math.max(hotWindowSeconds, numberWithin(merged.warmWindowSeconds, 0, 86_400, DEFAULT_WILLINGNESS.warmWindowSeconds));

  return {
    base: numberAtLeast(merged.base, 0, DEFAULT_WILLINGNESS.base),
    atMention: numberAtLeast(merged.atMention, 0, DEFAULT_WILLINGNESS.atMention),
    isQuote: numberAtLeast(merged.isQuote, 0, DEFAULT_WILLINGNESS.isQuote),
    isDirectMessage: numberAtLeast(merged.isDirectMessage, 0, DEFAULT_WILLINGNESS.isDirectMessage),
    imageGain: numberAtLeast(merged.imageGain, 0, DEFAULT_WILLINGNESS.imageGain),
    keywords: (Array.isArray(merged.keywords) ? merged.keywords : [])
      .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
      .filter((keyword) => keyword.length > 0),
    keywordMultiplier: numberAtLeast(merged.keywordMultiplier, 0, DEFAULT_WILLINGNESS.keywordMultiplier),
    defaultMultiplier: numberAtLeast(merged.defaultMultiplier, 0, DEFAULT_WILLINGNESS.defaultMultiplier),
    maxWillingness,
    initialWillingness: numberWithin(merged.initialWillingness, 0, maxWillingness, DEFAULT_WILLINGNESS.initialWillingness),
    decayHalfLifeSeconds: numberAtLeast(merged.decayHalfLifeSeconds, 1, DEFAULT_WILLINGNESS.decayHalfLifeSeconds),
    hotWindowSeconds,
    warmWindowSeconds,
    hotDecayWeight: numberWithin(merged.hotDecayWeight, 0, 1, DEFAULT_WILLINGNESS.hotDecayWeight),
    warmDecayWeight: numberWithin(merged.warmDecayWeight, 0, 1, DEFAULT_WILLINGNESS.warmDecayWeight),
    probabilityThreshold: numberWithin(merged.probabilityThreshold, 0, maxWillingness, Math.min(maxWillingness, DEFAULT_WILLINGNESS.probabilityThreshold)),
    probabilityAmplifier: numberAtLeast(merged.probabilityAmplifier, 0, DEFAULT_WILLINGNESS.probabilityAmplifier),
    replyCost: numberAtLeast(merged.replyCost, 0, DEFAULT_WILLINGNESS.replyCost),
    atMentionForce: merged.atMentionForce === true,
    quoteForce: merged.quoteForce === true,
    directForce: merged.directForce === true,
    participationWindowSeconds: numberWithin(merged.participationWindowSeconds, 0, 86_400, DEFAULT_WILLINGNESS.participationWindowSeconds),
    participationInfluence: numberWithin(merged.participationInfluence, 0, 1, DEFAULT_WILLINGNESS.participationInfluence),
  };
}

function weightedSilenceSeconds(lastDecayAt: number, lastMessageAt: number, now: number, config: WillingnessWakeupConfig): number {
  const hotEnd = lastMessageAt + config.hotWindowSeconds * 1_000;
  const warmEnd = lastMessageAt + config.warmWindowSeconds * 1_000;
  const overlap = (start: number, end: number): number => Math.max(0, Math.min(now, end) - Math.max(lastDecayAt, start)) / 1_000;
  return (
    overlap(lastMessageAt, hotEnd) * config.hotDecayWeight +
    overlap(hotEnd, warmEnd) * config.warmDecayWeight +
    Math.max(0, now - Math.max(lastDecayAt, warmEnd)) / 1_000
  );
}

function decayHighScore(score: number, weightedSeconds: number, threshold: number, halfLife: number): number {
  const weightedSecondsToThreshold = 2 * halfLife * Math.log2(score / threshold);
  if (weightedSeconds <= weightedSecondsToThreshold) {
    return score * 0.5 ** ((0.5 * weightedSeconds) / halfLife);
  }
  return threshold * 0.5 ** ((weightedSeconds - weightedSecondsToThreshold) / halfLife);
}

function decayedScore(score: number, state: ChannelState, now: number, config: WillingnessWakeupConfig): number {
  if (now <= state.lastDecayAt) return score;
  const weightedSeconds = weightedSilenceSeconds(state.lastDecayAt, state.lastMessageAt, now, config);
  const decayed =
    score > config.probabilityThreshold && config.probabilityThreshold > 0
      ? decayHighScore(score, weightedSeconds, config.probabilityThreshold, config.decayHalfLifeSeconds)
      : score * 0.5 ** (weightedSeconds / config.decayHalfLifeSeconds);
  return decayed < 0.01 ? 0 : Math.max(0, decayed);
}

function dynamicGainMultiplier(ratio: number): number {
  if (ratio < 0.2) return 1;
  if (ratio < 0.8) return Math.max(1, -(((ratio - 0.5) * 2) ** 2) + 2);
  return 1 - (ratio - 0.8) / 0.2;
}

function probabilityOf(score: number, config: WillingnessWakeupConfig): number {
  if (score <= config.probabilityThreshold) return 0;
  return Math.min(1, Math.max(0, (score - config.probabilityThreshold) * config.probabilityAmplifier));
}

function inspectContent(content: string, selfId: string): { mentionsSelf: boolean; mentionsOther: boolean } {
  if (!content.includes("<at")) return { mentionsSelf: false, mentionsOther: false };
  let mentionsSelf = false;
  let mentionsOther = false;
  for (const element of h.parse(content)) {
    if (element.type !== "at") continue;
    const id = element.attrs?.id;
    if (typeof id !== "string") continue;
    if (id === selfId) mentionsSelf = true;
    else mentionsOther = true;
  }
  return { mentionsSelf, mentionsOther };
}

function sendTarget(args: unknown, context: ExtensionContext): string | undefined {
  if (isRecord(args) && isRecord(args.target)) {
    const sid = args.target.sid;
    const channelId = args.target.channelId;
    if (typeof sid === "string" && typeof channelId === "string") {
      const separator = sid.indexOf(":");
      if (separator > 0 && separator < sid.length - 1) {
        return addressKey({ platform: sid.slice(0, separator), selfId: sid.slice(separator + 1), channelId });
      }
    }
  }
  const domain = channelDomainAddress(context);
  return domain === undefined ? undefined : addressKey(domain);
}

function sendSucceeded(result: unknown): boolean {
  return isRecord(result) && hasOwn(result, "ok") && result.ok === true;
}

function codemodeSentMessage(result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.result)) return false;
  const calls = result.result.calls;
  if (!Array.isArray(calls)) return false;
  return calls.some((call) => isRecord(call) && call.name === SEND_MESSAGE_TOOL && call.status === "ok");
}

function pendingKey(toolCallId: string | undefined): string {
  return toolCallId ?? SEND_MESSAGE_TOOL;
}

export class WillingnessWakeupInstance implements WakeupEngineInstance {
  public readonly config: WillingnessWakeupConfig;

  private readonly context: ExtensionContext;
  private readonly states = new Map<string, ChannelState>();
  private readonly turns = new Map<string, TurnState>();
  private readonly attachments = new Set<string>();

  constructor(config: Partial<WillingnessWakeupConfig> = {}, context: ExtensionContext) {
    this.config = normalize(config);
    this.context = context;
  }

  attach(agent: Agent): () => void {
    let disposed = false;
    const unsubscribe = agent.channel.subscribe("agent", (event) => {
      if (!disposed) this.handle(agent, event);
    });

    return () => {
      disposed = true;
      unsubscribe();
      this.states.clear();
      this.turns.clear();
      this.attachments.clear();
    };
  }

  getCurrentWillingness(address: WillingnessAddress, now = Date.now()): number {
    const state = this.states.get(addressKey(address));
    return state === undefined ? this.config.initialWillingness : decayedScore(state.score, state, now, this.config);
  }

  private handle(agent: Agent, event: AgentEvent): void {
    switch (event.type) {
      case "message.appended":
        this.observeMessage(agent, event);
        return;
      case "tool.start":
        this.observeToolStart(event);
        return;
      case "tool.done":
        this.observeToolDone(event);
        return;
      case "tool.failed":
      case "tool.blocked":
        if (event.toolName === SEND_MESSAGE_TOOL) this.ensureTurn(event.turnId).pending.delete(pendingKey(event.toolCallId));
        return;
      case "turn.done":
      case "turn.failed":
      case "turn.aborted":
        this.settleTurn(event.turnId);
        return;
      default:
        return;
    }
  }

  private observeMessage(agent: Agent, event: Extract<AgentEvent, { type: "message.appended" }>): void {
    const message = event.message;
    if (message.role !== "custom") return;
    if (message.type === "ishiki.attachment") {
      if (message.data.source !== "platform" || message.data.items.length === 0) return;
      const key = messageKey(message.data, message.data.messageId);
      this.addAttachment(key);
      return;
    }
    if (message.type !== "ishiki.message.created") return;

    const data = message.data;
    const address = addressOf(data);
    const key = addressKey(address);
    const now = Date.now();
    const state = this.ensureState(key, now);
    const content = inspectContent(data.content, data.selfId);
    const traits: MessageTraits = {
      mentionsSelf: content.mentionsSelf,
      mentionsOther: content.mentionsOther,
      quotesSelf: data.quote?.user?.id === data.selfId,
      quotesOther: data.quote?.user !== undefined && data.quote.user.id !== data.selfId,
      hasImage: this.attachments.delete(messageKey(address, data.messageId)),
    };

    state.score = decayedScore(state.score, state, now, this.config);
    const participation = this.participationMultiplier(state, data, traits, now);
    const attributes =
      (traits.mentionsSelf ? this.config.atMention : 0) +
      (traits.quotesSelf ? this.config.isQuote : 0) +
      (traits.hasImage ? this.config.imageGain : 0) +
      (data.isDirect ? this.config.isDirectMessage : 0);
    const multiplier = this.keywordMultiplier(data.content);
    const ratio = state.score / this.config.maxWillingness;
    const marginalGain = Math.max(0, 1 - ratio ** 2);
    const gain = (this.config.base + attributes) * multiplier * participation * marginalGain * dynamicGainMultiplier(ratio);
    state.score = Math.min(this.config.maxWillingness, Math.max(0, state.score + gain));
    state.lastMessageAt = now;
    state.lastDecayAt = now;
    state.lastUserId = data.user.id;

    const activeTurn = agent.getActiveTurnId();
    if (activeTurn !== null) {
      const turn = this.ensureTurn(activeTurn);
      turn.source ??= key;
    }

    const probability = probabilityOf(state.score, this.config);
    const forced =
      (this.config.directForce && data.isDirect) || (this.config.atMentionForce && traits.mentionsSelf) || (this.config.quoteForce && traits.quotesSelf);
    if (!agent.isIdle() || (!forced && Math.random() >= probability)) return;

    const turnId = agent.continue();
    if (turnId !== undefined) this.ensureTurn(turnId).source = key;
  }

  private observeToolStart(event: Extract<AgentEvent, { type: "tool.start" }>): void {
    if (event.toolName !== SEND_MESSAGE_TOOL) return;
    const turn = this.ensureTurn(event.turnId);
    turn.pending.set(pendingKey(event.toolCallId), sendTarget(event.args, this.context));
  }

  private observeToolDone(event: Extract<AgentEvent, { type: "tool.done" }>): void {
    if (event.toolName === SEND_MESSAGE_TOOL) {
      const turn = this.ensureTurn(event.turnId);
      const key = pendingKey(event.toolCallId);
      const target = turn.pending.get(key);
      turn.pending.delete(key);
      if (target !== undefined && sendSucceeded(event.result)) turn.sends.add(target);
      return;
    }

    if (event.toolName === CODEMODE_TOOL && codemodeSentMessage(event.result)) {
      const turn = this.ensureTurn(event.turnId);
      const domain = channelDomainAddress(this.context);
      const target = turn.source ?? (domain === undefined ? undefined : addressKey(domain));
      if (target !== undefined) turn.sends.add(target);
    }
  }

  private settleTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn === undefined) return;
    this.turns.delete(turnId);
    const now = Date.now();
    for (const key of turn.sends) this.charge(key, now);
  }

  private charge(key: string, now: number): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    state.score = Math.max(0, decayedScore(state.score, state, now, this.config) - this.config.replyCost);
    state.lastDecayAt = now;
    if (this.config.participationWindowSeconds > 0 && state.lastUserId.length > 0) {
      state.participation = {
        participantId: state.lastUserId,
        lastReplyAt: now,
        expiresAt: now + this.config.participationWindowSeconds * 1_000,
      };
    }
  }

  private ensureState(key: string, now: number): ChannelState {
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    this.bound(this.states, MAX_STATES);
    const created: ChannelState = {
      score: this.config.initialWillingness,
      lastMessageAt: now,
      lastDecayAt: now,
      lastUserId: "",
    };
    this.states.set(key, created);
    return created;
  }

  private ensureTurn(turnId: string): TurnState {
    const existing = this.turns.get(turnId);
    if (existing !== undefined) return existing;
    this.bound(this.turns, MAX_TURNS);
    const created: TurnState = { sends: new Set(), pending: new Map() };
    this.turns.set(turnId, created);
    return created;
  }

  private addAttachment(key: string): void {
    this.attachments.delete(key);
    this.bound(this.attachments, MAX_ATTACHMENTS);
    this.attachments.add(key);
  }

  private bound<K, V>(map: Map<K, V> | Set<K>, maximum: number): void {
    if (map.size < maximum) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }

  private keywordMultiplier(content: string): number {
    return this.config.keywords.some((keyword) => content.includes(keyword)) ? this.config.keywordMultiplier : this.config.defaultMultiplier;
  }

  private participationMultiplier(state: ChannelState, message: IshikiMessageCreated, traits: MessageTraits, now: number): number {
    const participation = state.participation;
    if (participation === undefined || now < participation.lastReplyAt || now >= participation.expiresAt || this.config.participationInfluence === 0) {
      return 1;
    }

    const invited = traits.mentionsSelf || traits.quotesSelf;
    if (!invited && (traits.mentionsOther || traits.quotesOther)) return 1;
    const sameParticipant = participation.participantId === message.user.id;
    if (!invited && !message.isDirect && !sameParticipant) return 1;

    const duration = participation.expiresAt - participation.lastReplyAt;
    const remaining = Math.max(0, Math.min(1, (participation.expiresAt - now) / duration));
    return 1 + this.config.participationInfluence * remaining;
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    willingness: WillingnessWakeupConfig;
  }
}

export class WillingnessWakeupEngine extends WakeupEngine<"willingness"> {
  public readonly Schema = WillingnessWakeupConfig;

  constructor(ctx: Context) {
    super(ctx, "willingness");
  }

  public [Service.invoke](config: EngineConfig<Pick<WakeupEngines, "willingness">>, context: ExtensionContext): WakeupEngineInstance {
    return new WillingnessWakeupInstance(config.willingness ?? {}, context);
  }
}
