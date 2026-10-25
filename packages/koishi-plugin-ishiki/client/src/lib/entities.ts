import type { GroupView, ProviderView } from "../types";
import { parseReference } from "./models";

/**
 * 用量与缓存里的 reference 字段可能是：具体模型引用（provider:model）、
 * 模型组名（profile.model 直接写组名时的回退值）或已不在目录里的历史引用。
 * 统一在这里分类，页面按 kind 决定展示与聚合维度。
 */
export type ReferenceEntity =
  | { kind: "model"; reference: string; provider: string; modelId: string }
  | { kind: "group"; reference: string; name: string }
  | { kind: "unmapped"; reference: string };

export function classifyReference(reference: string, providers: readonly ProviderView[], groups: readonly GroupView[]): ReferenceEntity {
  if (reference.length === 0) return { kind: "unmapped", reference };
  const parsed = parseReference(reference);
  if ("group" in parsed) {
    // 不带冒号的引用只在模型组目录里找；找不到就按缺少映射原样保留。
    if (groups.some((group) => group.name === parsed.group)) return { kind: "group", reference, name: parsed.group };
    return { kind: "unmapped", reference };
  }
  const provider = providers.find((entry) => entry.id === parsed.provider);
  if (provider === undefined) return { kind: "unmapped", reference };
  const declared = provider.models.some((model) => model.id === parsed.modelId);
  if (!declared) return { kind: "unmapped", reference };
  return { kind: "model", reference: `${parsed.provider}:${parsed.modelId}`, provider: parsed.provider, modelId: parsed.modelId };
}

export type EntityBadge = { label: string; tone: "badge-success" | "badge-info" | "badge-warning" | "badge-neutral" };

export function entityBadge(entity: ReferenceEntity): EntityBadge {
  if (entity.kind === "model") return { label: "模型", tone: "badge-info" };
  if (entity.kind === "group") return { label: "模型组", tone: "badge-warning" };
  return { label: "未映射", tone: "badge-neutral" };
}

/** 展示名：具体模型用 provider:model；模型组带「组」前缀；未映射保留原值。 */
export function entityLabel(entity: ReferenceEntity): string {
  if (entity.kind === "group") return `组 ${entity.name}`;
  return entity.reference;
}
