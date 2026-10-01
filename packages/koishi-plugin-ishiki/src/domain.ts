import { claimsChannel, type ChannelClaim } from "./profile.js";

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

/**
 * 认领范围的可读写法：逐行 `sid/模式`，白名单是可达的，黑名单是被排除的。
 * 工具的报错文本与系统提示里的地址簿都取这一份——两处各算一次，模型会看到互相矛盾的说法。
 */
export function claimLines(accounts: readonly ClaimedAccount[]): { reachable: string[]; excluded: string[] } {
  return {
    reachable: accounts.flatMap((account) => (account.claim.whitelist ?? []).map((pattern) => `${account.sid}/${pattern}`)),
    excluded: accounts.flatMap((account) => (account.claim.blacklist ?? []).map((pattern) => `${account.sid}/${pattern}`)),
  };
}

/**
 * 把模型给的坐标解析成一个频道：带 sid 的复合坐标直接取，无 sid 的裸 channelId 只在
 * 恰好被一个账号认领时才算数。解析不出返回 undefined，调用方报 `InvalidTarget`。
 * 认领判定只有 `claimsChannel` 一处，白名单与黑名单都算进去：被排除的频道不该
 * 因为「只有它认领这个名字」而可达。
 */
export function resolveClaimedChannel(accounts: readonly ClaimedAccount[], target: string): { sid: string; channelId: string } | undefined {
  const slash = target.indexOf("/");
  if (slash > 0) {
    const sid = target.slice(0, slash);
    const channelId = target.slice(slash + 1);
    const claim = accounts.find((account) => account.sid === sid)?.claim ?? {};
    return claimsChannel(claim, channelId) ? { sid, channelId } : undefined;
  }
  const owners = accounts.filter((account) => claimsChannel(account.claim, target));
  return owners.length === 1 ? { sid: owners[0]!.sid, channelId: target } : undefined;
}
