import type { ChannelClaim } from "./profile.js";

/**
 * 本实例覆盖哪些频道。与它怎么被选中无关——scene 的名单是选择器，不是可见域。
 *
 * 两种形态的标识来自两处不同的源头，内核只搬运、不反解：单频道形态的 platform 与 selfId 取自
 * 路由时的事件寻址，聚合形态的 sid 就是配置面 `claims` 的键本身。从 sid 反推 platform 与
 * selfId 是 00 号文第 6 条禁止的那件事，所以两种形态各给自己手上那份。
 */
export type InstanceDomain = { form: "channel"; platform: string; selfId: string; channelId: string } | { form: "cross"; accounts: readonly ClaimedAccount[] };

/** 一个账号在本实例里的认领。 */
export interface ClaimedAccount {
  /** 配置面 `claims` 的键；不透明字符串，只做相等比较。要用 Bot 就 `ctx.bots[sid]`。 */
  sid: string;
  /** 该账号认领的频道模式：白名单命中且未被黑名单排除。具体频道集展开不了。 */
  claim: ChannelClaim;
}
