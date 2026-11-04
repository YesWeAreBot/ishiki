import type { SchemaNode } from "../../../src/manage/schema";

export type { SchemaNode } from "../../../src/manage/schema";

/** 当前值命中的联合分支：所有 const 字段都必须相等，没有 const 字段的分支作为兜底。 */
function branchMatches(node: SchemaNode, record: Record<string, unknown> | undefined): boolean {
  if (node.type !== "object") return false;
  return Object.entries(node.dict ?? {}).every(([key, child]) => child.type !== "const" || record?.[key] === child.value);
}

/** 展开对象字段；intersect 合并所有分支，union 只取当前值命中的分支。 */
export function schemaFields(node: SchemaNode | undefined, value: unknown): Array<[string, SchemaNode]> {
  if (node === undefined) return [];
  if (node.type === "object") return Object.entries(node.dict ?? {});
  if (node.type === "intersect") {
    const merged = new Map<string, SchemaNode>();
    for (const branch of node.list ?? []) {
      for (const [key, child] of schemaFields(branch, value)) {
        // 分支里的 const 只用于选择分支，不覆盖顶层的真实控件。
        if (child.type !== "const") merged.set(key, child);
      }
    }
    return [...merged.entries()];
  }
  if (node.type !== "union") return [];
  const record = isRecord(value) ? value : undefined;
  const selected = (node.list ?? []).find((branch) => branchMatches(branch, record));
  return selected === undefined ? [] : Object.entries(selected.dict ?? {});
}

/** 递归计算表单默认值；显式默认值覆盖结构默认值。 */
export function schemaDefaults(node: SchemaNode | undefined): unknown {
  if (node === undefined) return undefined;
  const structural = structuralDefaults(node);
  const explicit = node.meta.default;
  if (explicit === undefined) return structural;
  // 字符串与数字的显式默认值只用 placeholder 提示，不预填；
  // 用户未填写时提交由服务端 Schema 补默认值，已保存的实际值仍显示在输入框里。
  if (node.type === "string" || node.type === "number") return undefined;
  if (isRecord(structural) && isRecord(explicit)) return mergeDefaults(structural, explicit);
  return cloneValue(explicit);
}

/** 适合作为 placeholder 展示的默认值；布尔、对象与空值不适用。 */
export function schemaPlaceholder(node: SchemaNode | undefined): string | undefined {
  const value = node?.meta.default;
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "object") return undefined;
  const text = String(value);
  return text.length === 0 ? undefined : text;
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
      for (const [key, child] of schemaFields(node, undefined)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
