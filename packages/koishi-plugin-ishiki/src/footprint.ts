/**
 * 用户活跃足迹：跨场景的瞬时工作记忆，纯内存，不落盘。
 * 只服务短期热迁移与寻址线索；长期历史归各场景自己的 `events.jsonl`。
 */
export interface UserFootprint {
  /** 最近活跃的场景地址。 */
  sid: string;
  channelId: string;
  /** 最近一次活跃时间。 */
  timestamp: number;
  /** 最近一次活跃是否触发了与 Bot 的互动（唤醒或自发投递）。 */
  interacted: boolean;
}

/** 足迹线索窗口：超过这个时间差的足迹不再提供线索。 */
export const FOOTPRINT_WINDOW_MS = 15 * 60_000;
/** 热迁移窗口：群聊 → 私聊的强连续判定窗口，比足迹窗口更紧。 */
export const HOT_TRANSFER_WINDOW_MS = 10 * 60_000;
/** 热迁移挂载的最大行数。 */
export const HOT_TRANSFER_LINES = 10;

// ponytail: 无淘汰的单键覆盖 Map。每人只记“最近场景”，量级不会爆；
// 需要按场景分别记忆时再升级为 Map<userId, Map<sceneKey, ...>>。
const MAX_ENTRIES = 1000;

export class FootprintIndex {
  private readonly footprints = new Map<string, UserFootprint>();

  /** 记录一次活跃：同 key 覆盖（先 delete 保序到末尾）。 */
  record(userId: string, footprint: Omit<UserFootprint, "interacted">, interacted: boolean): void {
    this.footprints.delete(userId);
    this.footprints.set(userId, { ...footprint, interacted });
    if (this.footprints.size > MAX_ENTRIES) {
      const oldest = this.footprints.keys().next().value;
      if (oldest !== undefined) this.footprints.delete(oldest);
    }
  }

  /** 查足迹：窗口内才返回，过期顺手清掉。 */
  lookup(userId: string, withinMs: number = FOOTPRINT_WINDOW_MS, now = Date.now()): UserFootprint | undefined {
    const hit = this.footprints.get(userId);
    if (hit === undefined) return undefined;
    if (now - hit.timestamp > withinMs) {
      this.footprints.delete(userId);
      return undefined;
    }
    return hit;
  }

  /** 热迁移判定：群聊 → 私聊的强连续场景。 */
  hotTransfer(userId: string, now = Date.now()): UserFootprint | undefined {
    const hit = this.lookup(userId, HOT_TRANSFER_WINDOW_MS, now);
    if (hit === undefined || !hit.interacted) return undefined;
    // 只在私聊方向触发：从私聊到群聊的方向由调用方用目标 isDirect 排除。
    return hit.channelId.startsWith("private:") ? undefined : hit;
  }
}
