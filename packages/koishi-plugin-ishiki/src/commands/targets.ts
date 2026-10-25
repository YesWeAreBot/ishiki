import type { Session } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import type { ChannelAddress, RuntimeView } from "../management/types.js";
import type { AgentRuntime } from "../runtime.js";

export interface RuntimeTarget {
  view: RuntimeView;
  instance?: AgentRuntime;
}

export function sessionAddress(session: Session | undefined): { platform: string; selfId: string; channelId: string } | undefined {
  if (session === undefined || session.platform === undefined || session.selfId === undefined || session.channelId === undefined) return undefined;
  return { platform: session.platform, selfId: session.selfId, channelId: session.channelId };
}

/** 解析 `platform:selfId/channelId` 坐标。 */
export function parseChannelAddress(text: string): ChannelAddress {
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new ManagementError("invalid", `频道坐标无效: ${text}，应为 platform:selfId/channelId`);
  }
  const account = text.slice(0, slash);
  const channelId = text.slice(slash + 1);
  const colon = account.indexOf(":");
  if (colon <= 0 || colon === account.length - 1) {
    throw new ManagementError("invalid", `频道坐标无效: ${text}，应为 platform:selfId/channelId`);
  }
  return { platform: account.slice(0, colon), selfId: account.slice(colon + 1), channelId };
}

/** 频道目标：显式坐标 → 当前会话频道。 */
export function resolveChannelAddress(explicit: string | undefined, session: Session | undefined): ChannelAddress {
  if (explicit !== undefined && explicit.length > 0) return parseChannelAddress(explicit);
  const address = sessionAddress(session);
  if (address === undefined) {
    throw new ManagementError("invalid", "请提供频道坐标 platform:selfId/channelId，或在频道会话内执行");
  }
  return address;
}

/** Profile 目标：位置参数 → --profile → 当前会话频道的激活认领（只读）。 */
export async function resolveProfileId(
  host: Ishiki,
  explicit: string | undefined,
  options: { profile?: string },
  session: Session | undefined,
): Promise<string> {
  const id = explicit !== undefined && explicit.length > 0 ? explicit : options.profile;
  if (id !== undefined && id.length > 0) {
    await host.management.profiles.status(id);
    return id;
  }
  const address = sessionAddress(session);
  const claim = address === undefined ? undefined : host.findClaim(address);
  if (claim === undefined) throw new ManagementError("not-found", "无法从当前会话确定 Profile，请指定目标");
  return claim.profile.id;
}

/** Runtime 目标：位置参数 → --runtime → --profile（唯一时）→ 当前频道已派生的 Runtime（只读查找，绝不 spawn）。 */
export async function resolveRuntime(
  host: Ishiki,
  explicit: string | undefined,
  options: { runtime?: string; profile?: string },
  session: Session | undefined,
): Promise<RuntimeTarget> {
  const runtimes = host.management.runtimes;
  if (explicit !== undefined && explicit.length > 0) {
    const view = runtimes.read(explicit);
    return { view, instance: host.findRuntime(view.id) };
  }
  const optionId = options.runtime;
  if (optionId !== undefined && optionId.length > 0) {
    const view = runtimes.read(optionId);
    return { view, instance: host.findRuntime(view.id) };
  }
  const profileId = options.profile;
  if (profileId !== undefined && profileId.length > 0) {
    await host.management.profiles.status(profileId);
    const views = runtimes.list().filter((view) => view.profileId === profileId);
    if (views.length === 0) throw new ManagementError("not-found", `Profile ${profileId} 还没有任何 Runtime 记录`);
    if (views.length > 1) {
      throw new ManagementError(
        "ambiguous",
        `Profile ${profileId} 匹配到 ${views.length} 个 Runtime，请指定完整 id：\n${views.map((view) => view.id).join("\n")}`,
      );
    }
    return { view: views[0], instance: host.findRuntime(views[0].id) };
  }
  const address = sessionAddress(session);
  if (address === undefined) throw new ManagementError("invalid", "请指定 --runtime 或 --profile，或在频道会话内执行");
  const runtime = host.findRuntimeByAddress(address);
  if (runtime === undefined) {
    const claim = host.findClaim(address);
    const hint =
      claim === undefined ? "当前频道没有归属的 Profile，也没有已创建的 Runtime" : `当前频道归属 Profile ${claim.profile.id}，但还没有已创建的 Runtime`;
    throw new ManagementError("not-found", hint);
  }
  return { view: runtimes.read(runtime.id), instance: runtime };
}
