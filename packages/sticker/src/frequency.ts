import type { AgentRuntime, IshikiMessageCreated } from "koishi-plugin-ishiki";

import type { ResolvedPolicy } from "./types.js";

const STICKER_REPLY_RE = /<img\b|<mface\b|表情|斗图|贴纸|发张图|来张图|sticker|meme/i;
const EXPLICIT_SAVE_RE = /存一下|存下来|存图|存表情|收藏|偷走|偷一下|收下|入库|保存|抱走|给你了|拿去用|\bmark\b|\bsave\b/i;
const ASSET_URL_RE = /\basset:\/\/[a-zA-Z0-9_-]+/;

export interface SendGateStatus {
  allowed: boolean;
  reason: "disabled" | "cooldown" | "chance_skip" | "allowed";
  exempt: boolean;
  remainingTurnBudget: number;
}

export interface SaveGateCheck {
  allowed: boolean;
  autonomous: boolean;
  reason?: string;
}

interface ChannelCounters {
  day: string;
  reviewCount: number;
  autonomousCount: number;
  lastAutonomousAt: number;
  lastSentAt: number;
}

const MAX_RECENT_INBOUNDS = 6;

export class RuntimePacer {
  private runtime: AgentRuntime | undefined;
  private latestInbound: IshikiMessageCreated | undefined;
  private readonly recentInbounds: IshikiMessageCreated[] = [];
  private readonly turnSendDecisions = new Map<string, boolean>();
  private readonly turnSendCounts = new Map<string, number>();
  private readonly turnSentChannels = new Set<string>();
  private storageSynced = false;

  public constructor(private readonly shared: PacerSharedState) {}

  public attach(runtime: AgentRuntime): () => void {
    this.runtime = runtime;
    const unsubscribe = runtime.agent.channel.subscribe("agent", (event) => {
      if (event.type === "message.appended" && event.message.role === "custom" && event.message.type === "ishiki.message.created") {
        this.pushInbound(event.message.data);
      }
    });
    return () => {
      unsubscribe();
      this.runtime = undefined;
    };
  }

  public async syncFromStorage(): Promise<void> {
    if (!this.runtime || this.storageSynced) return;
    this.storageSynced = true;
    if (this.recentInbounds.length >= MAX_RECENT_INBOUNDS) return;
    try {
      const entries = await this.runtime.storage.read();
      const collected: IshikiMessageCreated[] = [];
      for (let i = entries.length - 1; i >= 0 && collected.length < MAX_RECENT_INBOUNDS; i--) {
        const entry = entries[i];
        if (entry?.type === "message" && entry.data.role === "custom" && entry.data.type === "ishiki.message.created") {
          collected.push(entry.data.data);
        }
      }
      collected.reverse();
      for (const item of collected) this.pushInbound(item);
    } catch {
      // Ignore storage read failures during startup or teardown.
    }
  }

  private pushInbound(data: IshikiMessageCreated): void {
    this.latestInbound = data;
    if (this.recentInbounds.some((item) => item.messageId === data.messageId && item.timestamp === data.timestamp)) return;
    this.recentInbounds.push(data);
    while (this.recentInbounds.length > MAX_RECENT_INBOUNDS) {
      this.recentInbounds.shift();
    }
  }

  public currentTurnKey(): string {
    const activeTurn = this.runtime?.agent.getActiveTurnId();
    if (activeTurn) return activeTurn;
    if (this.latestInbound) return `msg:${this.latestInbound.messageId}`;
    return "idle";
  }

  public currentChannelKey(fallback: string): string {
    if (this.latestInbound) return `${this.latestInbound.platform}:${this.latestInbound.selfId}:${this.latestInbound.channelId}`;
    return fallback;
  }

  public getLatestInbound(): IshikiMessageCreated | undefined {
    return this.latestInbound;
  }

  public hasRecentAsset(): boolean {
    return this.recentInbounds.some((item) => ASSET_URL_RE.test(item.content) || (item.quote?.content !== undefined && ASSET_URL_RE.test(item.quote.content)));
  }

  public findInboundByAsset(assetUrl: string): IshikiMessageCreated | undefined {
    for (let i = this.recentInbounds.length - 1; i >= 0; i--) {
      const item = this.recentInbounds[i]!;
      if (item.content.includes(assetUrl) || item.quote?.content?.includes(assetUrl)) {
        return item;
      }
    }
    return undefined;
  }

  public evaluateSendGate(policy: ResolvedPolicy, channelKey: string, random = Math.random): SendGateStatus {
    if (!policy.allowSend) {
      return { allowed: false, reason: "disabled", exempt: false, remainingTurnBudget: 0 };
    }

    const turnKey = this.currentTurnKey();
    const sentInTurn = this.turnSendCounts.get(turnKey) ?? 0;
    const remaining = Math.max(0, policy.maxSendPerTurn - sentInTurn);

    const exempt = policy.exemptStickerReply && isStickerInbound(this.latestInbound);
    const counters = this.shared.getCounters(channelKey);
    const now = Date.now();
    if (policy.sendCooldownSeconds > 0 && counters.lastSentAt > 0 && now - counters.lastSentAt < policy.sendCooldownSeconds * 1000) {
      // If already opened earlier in this exact turn, keep it available until turn ends.
      if (this.turnSendDecisions.get(turnKey) !== true) {
        return { allowed: false, reason: "cooldown", exempt, remainingTurnBudget: remaining };
      }
    }

    let decision = this.turnSendDecisions.get(turnKey);
    if (decision === undefined) {
      decision = exempt ? true : policy.sendChance >= 1 ? true : policy.sendChance <= 0 ? false : random() < policy.sendChance;
      this.rememberTurnDecision(turnKey, decision);
    }

    if (!decision) {
      return { allowed: false, reason: "chance_skip", exempt, remainingTurnBudget: remaining };
    }
    return { allowed: true, reason: "allowed", exempt, remainingTurnBudget: remaining };
  }

  public tryConsumeSendBudget(policy: ResolvedPolicy, channelKey: string): { ok: true } | { ok: false; error: string } {
    const turnKey = this.currentTurnKey();
    const used = this.turnSendCounts.get(turnKey) ?? 0;
    if (used >= policy.maxSendPerTurn) {
      return { ok: false, error: `本轮最多发送 ${policy.maxSendPerTurn} 张表情包，已达上限` };
    }
    const counters = this.shared.getCounters(channelKey);
    const now = Date.now();
    const sentInTurnChannelKey = `${turnKey}\0${channelKey}`;
    if (
      !this.turnSentChannels.has(sentInTurnChannelKey) &&
      policy.sendCooldownSeconds > 0 &&
      counters.lastSentAt > 0 &&
      now - counters.lastSentAt < policy.sendCooldownSeconds * 1000
    ) {
      return { ok: false, error: `目标频道仍在发表情冷却期（${policy.sendCooldownSeconds} 秒）内` };
    }
    this.turnSendCounts.set(turnKey, used + 1);
    this.turnSentChannels.add(sentInTurnChannelKey);
    if (this.turnSentChannels.size > 1000) {
      const oldest = this.turnSentChannels.values().next().value;
      if (oldest !== undefined) this.turnSentChannels.delete(oldest);
    }
    counters.lastSentAt = now;
    return { ok: true };
  }

  public checkSaveGate(policy: ResolvedPolicy, channelKey: string, targetAssetUrl?: string): SaveGateCheck {
    if (!policy.allowSave) {
      return { allowed: false, autonomous: false, reason: "当前配置禁止保存表情包" };
    }

    const counters = this.shared.getCounters(channelKey);
    if (counters.reviewCount >= policy.dailyReviewLimit) {
      return { allowed: false, autonomous: false, reason: `今日单频道送审已达上限 (${policy.dailyReviewLimit})` };
    }

    const inbound = this.latestInbound;
    if (inbound && EXPLICIT_SAVE_RE.test(inbound.content)) {
      const inCurrentOrQuote = !targetAssetUrl || inbound.content.includes(targetAssetUrl) || inbound.quote?.content?.includes(targetAssetUrl);
      const targetInbound = targetAssetUrl ? this.findInboundByAsset(targetAssetUrl) : undefined;
      if (inCurrentOrQuote || targetInbound?.user.id === inbound.user.id) {
        return { allowed: true, autonomous: false };
      }
    }

    if (policy.autonomousDailyLimit <= 0) {
      return { allowed: false, autonomous: true, reason: "未开启模型自主偷图（仅支持群友明确要求收藏）" };
    }
    const now = Date.now();
    if (policy.autonomousCooldownMinutes > 0 && counters.lastAutonomousAt > 0) {
      const elapsedMs = now - counters.lastAutonomousAt;
      const cooldownMs = policy.autonomousCooldownMinutes * 60_000;
      if (elapsedMs < cooldownMs) {
        const leftMin = Math.ceil((cooldownMs - elapsedMs) / 60_000);
        return { allowed: false, autonomous: true, reason: `自主偷图冷却中，请等待约 ${leftMin} 分钟` };
      }
    }
    if (counters.autonomousCount >= policy.autonomousDailyLimit) {
      return { allowed: false, autonomous: true, reason: `今日自主偷图已达上限 (${policy.autonomousDailyLimit})` };
    }
    return { allowed: true, autonomous: true };
  }

  public recordReviewAttempt(channelKey: string): void {
    const counters = this.shared.getCounters(channelKey);
    counters.reviewCount += 1;
  }

  public recordAutonomousSave(channelKey: string): void {
    const counters = this.shared.getCounters(channelKey);
    counters.autonomousCount += 1;
    counters.lastAutonomousAt = Date.now();
  }

  private rememberTurnDecision(turnKey: string, decision: boolean): void {
    this.turnSendDecisions.set(turnKey, decision);
    if (this.turnSendDecisions.size > 128) {
      const oldest = this.turnSendDecisions.keys().next().value;
      if (oldest !== undefined) this.turnSendDecisions.delete(oldest);
    }
    if (this.turnSendCounts.size > 128) {
      const oldest = this.turnSendCounts.keys().next().value;
      if (oldest !== undefined) this.turnSendCounts.delete(oldest);
    }
  }
}

export class PacerSharedState {
  private readonly channels = new Map<string, ChannelCounters>();

  public getCounters(channelKey: string): ChannelCounters {
    const today = dayKey();
    const existing = this.channels.get(channelKey);
    if (existing && existing.day === today) return existing;
    const fresh: ChannelCounters = {
      day: today,
      reviewCount: 0,
      autonomousCount: 0,
      lastAutonomousAt: existing?.lastAutonomousAt ?? 0,
      lastSentAt: existing?.lastSentAt ?? 0,
    };
    this.channels.set(channelKey, fresh);
    if (this.channels.size > 1000) {
      const oldest = this.channels.keys().next().value;
      if (oldest !== undefined) this.channels.delete(oldest);
    }
    return fresh;
  }
}

function isStickerInbound(inbound: IshikiMessageCreated | undefined): boolean {
  if (!inbound) return false;
  if (STICKER_REPLY_RE.test(inbound.content)) return true;
  if (inbound.quote?.content && STICKER_REPLY_RE.test(inbound.quote.content)) return true;
  return false;
}

function dayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
