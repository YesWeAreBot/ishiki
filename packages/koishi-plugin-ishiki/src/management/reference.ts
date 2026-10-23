import { THINK_LEVELS } from "@yesimagent/gateway";

/** 用量按模型汇总，思考等级不单独成行。 */
export function baseReference(reference: string): string {
  const levelAt = reference.lastIndexOf(":");
  if (levelAt < 0) return reference;
  if (!(THINK_LEVELS as readonly string[]).includes(reference.slice(levelAt + 1))) return reference;
  return reference.lastIndexOf(":", levelAt - 1) < 0 ? reference : reference.slice(0, levelAt);
}
