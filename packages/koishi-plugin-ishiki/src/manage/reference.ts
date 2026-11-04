import { THINK_LEVELS } from "@yesimagent/gateway";

import type { RuntimeMeta } from "./types.js";

/** 用量按模型汇总，思考等级不单独成行。 */
export function baseReference(reference: string): string {
  const levelAt = reference.lastIndexOf(":");
  if (levelAt < 0) return reference;
  if (!(THINK_LEVELS as readonly string[]).includes(reference.slice(levelAt + 1))) return reference;
  return reference.lastIndexOf(":", levelAt - 1) < 0 ? reference : reference.slice(0, levelAt);
}

/** Runtime 域在控制台里的单行展示。 */
export function domainLabel(domain: RuntimeMeta["domain"]): string {
  return domain.mode === "cross" ? "跨频道" : `${domain.platform} · ${domain.channelId}`;
}
