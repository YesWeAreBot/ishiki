import { readdir } from "node:fs/promises";
import path from "node:path";

import type Ishiki from "../index.js";
import { matchesChannel, overlaps, readProfileRaw, resolveProfile, type ChannelFilter } from "../profile/index.js";
import { ChangeQueue } from "./atomic.js";
import { ManagementError } from "./errors.js";
import type { ProfilesManager } from "./profiles.js";
import type { RuntimesManager } from "./runtimes.js";
import type { ChannelAddress, ChannelClaimView, RuntimeView } from "./types.js";

function addressOf(address: ChannelAddress): string {
  return `${address.platform}:${address.selfId}/${address.channelId}`;
}

function sidOf(address: ChannelAddress): string {
  return `${address.platform}:${address.selfId}`;
}

/** 频道归属：查询走激活路由与磁盘认领表，变更在互斥校验后落盘并立即重应用受影响的激活 Profile。 */
export class ChannelsManager {
  private readonly changes = new ChangeQueue();

  constructor(
    private readonly host: Ishiki,
    private readonly profiles: ProfilesManager,
    private readonly runtimes: RuntimesManager,
  ) {}

  async lookup(address: ChannelAddress): Promise<ChannelClaimView> {
    const claim = this.host.findClaim(address);
    const runtime = this.host.findRuntimeByAddress(address);
    return {
      address: addressOf(address),
      profileId: claim?.profile.id,
      matchedPattern: claim?.matchedPattern,
      savedClaimants: await this.savedClaimants(address),
      runtime: runtime === undefined ? undefined : this.runtimes.read(runtime.id),
    };
  }

  /** RuntimeMeta 反查：频道 → Runtime → Profile → 状态，含离线记录。 */
  async list(filter: { profileId?: string } = {}): Promise<ChannelClaimView[]> {
    const views = this.runtimes.list().filter((view) => view.mode === "channel");
    const scoped = filter.profileId === undefined ? views : views.filter((view) => view.profileId === filter.profileId);
    const grouped = new Map<string, { address: ChannelAddress; latest?: RuntimeView }>();
    for (const view of scoped) {
      if (view.platform === undefined || view.selfId === undefined || view.channelId === undefined) continue;
      const address = { platform: view.platform, selfId: view.selfId, channelId: view.channelId };
      const current = grouped.get(addressOf(address));
      if (current === undefined || (current.latest?.createdAt ?? 0) < view.createdAt) grouped.set(addressOf(address), { address, latest: view });
    }
    const result: ChannelClaimView[] = [];
    for (const { address, latest } of grouped.values()) {
      const claim = this.host.findClaim(address);
      result.push({
        address: addressOf(address),
        profileId: claim?.profile.id ?? latest?.profileId,
        matchedPattern: claim?.matchedPattern,
        savedClaimants: await this.savedClaimants(address),
        runtime: latest,
      });
    }
    return result.sort((left, right) => left.address.localeCompare(right.address));
  }

  async claim(profileId: string, address: ChannelAddress, operator: string): Promise<ChannelClaimView> {
    return this.changes.run(async () => {
      const sid = sidOf(address);
      await this.profiles.status(profileId);
      const candidate = await this.candidateFilter(profileId, sid, address.channelId, true);
      this.assertMutex(sid, candidate, new Set([profileId]));
      await this.profiles.addChannels(profileId, sid, [address.channelId], operator);
      await this.reapplyOrStop(profileId, operator);
      return this.lookup(address);
    });
  }

  async release(address: ChannelAddress, operator: string): Promise<ChannelClaimView> {
    return this.changes.run(async () => {
      const sid = sidOf(address);
      const claim = this.host.findClaim(address);
      if (claim === undefined) throw new ManagementError("not-found", `没有激活的 Profile 认领 ${addressOf(address)}`);
      if (claim.matchedPattern !== address.channelId) {
        throw new ManagementError("rejected", `该频道由模式 ${claim.matchedPattern} 通配认领，请使用 ishiki.profile.channel.remove 调整模式`);
      }
      const owner = claim.profile.id;
      await this.profiles.removeChannels(owner, sid, [address.channelId], operator);
      await this.reapplyOrStop(owner, operator);
      return this.lookup(address);
    });
  }

  async move(toProfileId: string, address: ChannelAddress, operator: string): Promise<ChannelClaimView> {
    return this.changes.run(async () => {
      const sid = sidOf(address);
      const claim = this.host.findClaim(address);
      if (claim === undefined) throw new ManagementError("not-found", `没有激活的 Profile 认领 ${addressOf(address)}`);
      const fromId = claim.profile.id;
      if (toProfileId === fromId) throw new ManagementError("invalid", `频道已属于 Profile ${fromId}`);
      if (claim.matchedPattern !== address.channelId) {
        throw new ManagementError("rejected", `该频道由模式 ${claim.matchedPattern} 通配认领，请改用 ishiki.profile.channel.* 调整两个 Profile 的模式`);
      }
      await this.profiles.status(toProfileId);
      const candidate = await this.candidateFilter(toProfileId, sid, address.channelId, true);
      this.assertMutex(sid, candidate, new Set([toProfileId, fromId]));
      await this.profiles.addChannels(toProfileId, sid, [address.channelId], operator);
      await this.profiles.removeChannels(fromId, sid, [address.channelId], operator);
      // 先停来源再重应用，目标应用时来源的旧认领表已不在激活集合里；
      // 来源的认领表被清空时保持停用（空表无法激活）。
      const fromWasActive = this.host.profiles.has(fromId);
      if (fromWasActive) await this.host.deactivate(fromId);
      await this.reapplyOrStop(toProfileId, operator);
      if (fromWasActive && (await this.hasClaims(fromId))) await this.profiles.apply(fromId, operator);
      return this.lookup(address);
    });
  }

  /** 候选认领表与激活集合（排除 exclude）的重叠检查。 */
  private assertMutex(sid: string, candidate: ChannelFilter, exclude: ReadonlySet<string>): void {
    for (const [activeId, record] of this.host.profiles) {
      if (exclude.has(activeId)) continue;
      const other = record.profile.channels.get(sid);
      if (other !== undefined && overlaps(candidate, other)) {
        throw new ManagementError("conflict", `Profile ${activeId} 已认领 ${sid} 的重叠频道`);
      }
    }
  }

  private async candidateFilter(profileId: string, sid: string, channelId: string, add: boolean): Promise<ChannelFilter> {
    const root = path.join(this.host.dataPath, "profiles");
    const raw = await readProfileRaw(root, profileId);
    if (raw === undefined) throw new ManagementError("not-found", `Profile ${profileId} 不存在`);
    const channels = (raw.channels as Record<string, string[]> | undefined) ?? {};
    const patterns = channels[sid] ?? [];
    const next = add
      ? [...patterns, channelId].filter((pattern, index, all) => all.indexOf(pattern) === index)
      : patterns.filter((pattern) => pattern !== channelId);
    return {
      include: next.filter((pattern) => !pattern.startsWith("!")),
      exclude: next.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1)),
    };
  }

  /** 重应用受影响的激活 Profile；认领表被清空时无法再激活，停用并把 Profile 留在磁盘草稿态。 */
  private async reapplyOrStop(profileId: string, operator: string): Promise<"applied" | "stopped" | "untouched"> {
    if (!this.host.profiles.has(profileId)) return "untouched";
    if (!(await this.hasClaims(profileId))) {
      await this.host.deactivate(profileId);
      return "stopped";
    }
    await this.profiles.apply(profileId, operator);
    return "applied";
  }

  private async hasClaims(profileId: string): Promise<boolean> {
    const raw = await readProfileRaw(path.join(this.host.dataPath, "profiles"), profileId);
    return Object.keys((raw?.channels as Record<string, string[]> | undefined) ?? {}).length > 0;
  }

  /** 磁盘上会认领该频道的全部 Profile（含未激活）；无法解析的草稿跳过。 */
  private async savedClaimants(address: ChannelAddress): Promise<string[]> {
    const sid = sidOf(address);
    const root = path.join(this.host.dataPath, "profiles");
    const claimants: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const raw = await readProfileRaw(root, entry.name);
      if (raw === undefined) continue;
      let filter: ChannelFilter | undefined;
      try {
        filter = resolveProfile(raw, entry.name, path.join(root, entry.name)).channels.get(sid);
      } catch {
        continue;
      }
      if (filter !== undefined && matchesChannel(filter, address.channelId)) claimants.push(entry.name);
    }
    return claimants.sort();
  }
}
