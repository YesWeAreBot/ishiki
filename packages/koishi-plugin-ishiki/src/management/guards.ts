/** 值是否为普通对象；字段仍需按实际类型收窄。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
