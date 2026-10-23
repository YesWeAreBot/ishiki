import type { GroupView, ModelDecl, ModelDeclView, ModelOption, ProviderView } from "../types";

export const THINK_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkLevel = (typeof THINK_LEVELS)[number];

export type ParsedReference = { provider: string; modelId: string; level?: ThinkLevel } | { group: string };

export function parseReference(reference: string): ParsedReference {
  const separator = reference.indexOf(":");
  if (separator === -1) return { group: reference };
  const provider = reference.slice(0, separator);
  let modelId = reference.slice(separator + 1);
  let level: ThinkLevel | undefined;
  const tail = modelId.lastIndexOf(":");
  if (tail !== -1) {
    const candidate = modelId.slice(tail + 1);
    if ((THINK_LEVELS as readonly string[]).includes(candidate)) {
      level = candidate as ThinkLevel;
      modelId = modelId.slice(0, tail);
    }
  }
  return { provider, modelId, level };
}

export function findDeclaredModel(
  providers: readonly ProviderView[],
  reference: string,
): { provider: ProviderView; model: ModelDeclView; level?: ThinkLevel } | undefined {
  const parsed = parseReference(reference);
  if ("group" in parsed) return undefined;
  const provider = providers.find((entry) => entry.id === parsed.provider);
  const model = provider?.models.find((entry) => entry.id === parsed.modelId);
  if (provider === undefined || model === undefined) return undefined;
  return { provider, model, level: parsed.level };
}

export function modelRows(providers: readonly ProviderView[]): Array<{ provider: ProviderView; model: ModelDecl; reference: string }> {
  return providers.flatMap((provider) => provider.models.map((model) => ({ provider, model, reference: `${provider.id}:${model.id}` })));
}

export function modelOptions(providers: readonly ProviderView[], groups: readonly GroupView[], options: { languageOnly?: boolean } = {}): ModelOption[] {
  const rows: ModelOption[] = [];
  for (const group of groups) rows.push({ reference: group.name, label: `组 ${group.name}`, kind: "group" });
  for (const { provider, model, reference } of modelRows(providers)) {
    rows.push({
      reference,
      label: model.name === undefined || model.name.length === 0 ? model.id : `${model.name} · ${model.id}`,
      kind: "model",
      type: model.type,
      provider: provider.id,
    });
  }
  return options.languageOnly === true ? rows.filter((row) => row.kind === "group" || row.type === "language") : rows;
}

const MODEL_TYPE_LABELS: Record<string, string> = {
  language: "语言",
  embedding: "向量",
  image: "图像",
  speech: "语音",
  transcription: "转写",
  reranking: "重排",
  decision: "判定",
};

export function modelTypeLabel(type: string | undefined): string {
  return type === undefined ? "语言" : (MODEL_TYPE_LABELS[type] ?? type);
}

export const MODEL_TYPE_OPTIONS = Object.entries(MODEL_TYPE_LABELS).map(([value, label]) => ({ value, label }));

export function apiLabel(api: string): string {
  return api;
}

export const THINK_LEVEL_LABELS: Record<ThinkLevel, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export function groupStrategyLabel(strategy: string | undefined): string {
  switch (strategy) {
    case undefined:
    case "failover":
      return "故障转移";
    case "round-robin":
      return "轮询";
    case "random":
      return "随机";
    default:
      return strategy;
  }
}

export function groupStrategyDescription(strategy: string | undefined): string {
  switch (strategy) {
    case undefined:
    case "failover":
      return "按声明顺序尝试，失败后换下一个候选";
    case "round-robin":
      return "每次请求按顺序轮换候选";
    case "random":
      return "每次请求随机选择候选";
    default:
      return "";
  }
}

export function modelCapabilitySummary(model: ModelDecl): string[] {
  const result: string[] = [];
  if (model.type === undefined || model.type === "language") {
    if (model.toolCall === true) result.push("工具调用");
    if (model.reasoning === true) result.push("推理输出");
    if (model.input?.includes("image") === true) result.push("图像输入");
    if (model.thinking !== undefined) result.push(`${model.thinking.efforts.length} 档思考`);
  }
  if (model.type === "embedding" && model.dimensions !== undefined) result.push(`${model.dimensions} 维`);
  return result;
}
