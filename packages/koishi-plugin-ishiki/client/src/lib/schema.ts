import type { SchemaNode } from "../../../src/management/schema";

export type { SchemaNode } from "../../../src/management/schema";

/** 递归计算表单默认值；显式默认值覆盖结构默认值。 */
export function schemaDefaults(node: SchemaNode | undefined): unknown {
  if (node === undefined) return undefined;
  const structural = structuralDefaults(node);
  const explicit = node.meta.default;
  if (explicit === undefined) return structural;
  if (isRecord(structural) && isRecord(explicit)) return mergeDefaults(structural, explicit);
  return cloneValue(explicit);
}

/** 默认值可能来自 Vue 响应式代理，structuredClone 会拒绝；逐层复制普通数据。 */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function structuralDefaults(node: SchemaNode): unknown {
  switch (node.type) {
    case "object":
    case "intersect": {
      const value: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(collectDict(node))) {
        const fallback = schemaDefaults(child);
        if (fallback !== undefined) value[key] = fallback;
      }
      return value;
    }
    case "array":
      return [];
    case "dict":
      return {};
    case "boolean":
      return false;
    case "string":
      return "";
    case "const":
      return node.value;
    case "union": {
      const list = node.list ?? [];
      return list.length > 0 && list.every((branch) => branch.type === "const") ? list[0].value : undefined;
    }
    default:
      return undefined;
  }
}

function mergeDefaults(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeDefaults(current, value) : cloneValue(value);
  }
  return result;
}

function collectDict(node: SchemaNode): Record<string, SchemaNode> {
  if (node.type === "object") return node.dict ?? {};
  if (node.type === "intersect") {
    return Object.assign({}, ...(node.list ?? []).map(collectDict));
  }
  return node.dict ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
