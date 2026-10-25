import type { ModelDecl, RemoteModelInfo } from "../types";
import { MODEL_TYPE_OPTIONS, THINK_LEVELS } from "./models";

export type ModelType = (typeof MODEL_TYPE_OPTIONS)[number]["value"];
export type ModelTypeLabel = { value: ModelType; label: string };

export const MODEL_TYPE_VALUES: readonly ModelType[] = MODEL_TYPE_OPTIONS.map((option) => option.value);

/** 输入类型的取值范围与展示名，来自网关 MODALITIES。 */
export const MODALITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "text", label: "text · 文本" },
  { value: "image", label: "image · 图像" },
  { value: "audio", label: "audio · 音频" },
  { value: "video", label: "video · 视频" },
  { value: "pdf", label: "pdf · 文档" },
];

export const THINK_LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = THINK_LEVELS.map((level) => ({ value: level, label: level }));

export type FieldSection = "basic" | "capability" | "generation" | "advanced";

export const SECTION_ORDER: readonly FieldSection[] = ["basic", "capability", "generation", "advanced"];

export const SECTION_LABELS: Record<FieldSection, string> = {
  basic: "基础信息",
  capability: "模型能力",
  generation: "生成参数",
  advanced: "高级选项",
};

export const SECTION_DESCRIPTIONS: Record<FieldSection, string> = {
  basic: "模型标识与用途，Profile 通过 provider:标识 引用。",
  capability: "模型支持的能力与输入类型，只有语言模型可配置。",
  generation: "上下文与输出限制，供网关做预算控制。",
  advanced: "特定类型模型才需要的参数。",
};

export type FieldKey = "id" | "name" | "type" | "toolCall" | "reasoning" | "input" | "thinking" | "contextWindow" | "maxTokens" | "dimensions";

export type FieldInput = "text" | "number" | "boolean" | "enum" | "modalities" | "thinking";

export interface ModelFieldDef {
  key: FieldKey;
  label: string;
  section: FieldSection;
  input: FieldInput;
  types: readonly ModelType[];
  required?: boolean;
  placeholder?: string;
  hint?: string;
  unit?: string;
}

const ANY_TYPE: readonly ModelType[] = MODEL_TYPE_VALUES;

/**
 * 各模型类型的字段定义、默认提示与适用范围集中在这里；
 * 编辑器与向导共用同一份注册表，避免创建与编辑行为漂移。
 */
export const MODEL_FIELDS: readonly ModelFieldDef[] = [
  {
    key: "id",
    label: "模型标识",
    section: "basic",
    input: "text",
    types: ANY_TYPE,
    required: true,
    placeholder: "供应商内的标识，例如 gpt-4o",
    hint: "Profile 引用它时写成 provider:标识。",
  },
  {
    key: "type",
    label: "模型类型",
    section: "basic",
    input: "enum",
    types: ANY_TYPE,
    required: true,
    hint: "决定表单显示哪些字段，以及网关如何调用。",
  },
  { key: "name", label: "展示名称", section: "basic", input: "text", types: ANY_TYPE, placeholder: "留空使用模型标识", hint: "只在控制台里展示。" },
  { key: "toolCall", label: "工具调用", section: "capability", input: "boolean", types: ["language"], hint: "模型能否发起工具调用。" },
  { key: "reasoning", label: "推理输出", section: "capability", input: "boolean", types: ["language"], hint: "响应里是否携带推理内容。" },
  {
    key: "input",
    label: "输入类型",
    section: "capability",
    input: "modalities",
    types: ["language", "embedding"],
    hint: "模型能接受的输入形式，可多选。",
  },
  {
    key: "thinking",
    label: "思考档位",
    section: "capability",
    input: "thinking",
    types: ["language"],
    hint: "思考模式参数名是调用接口时的参数；档位是引用可追加的 :level 后缀。",
  },
  { key: "contextWindow", label: "上下文窗口", section: "generation", input: "number", types: ["language"], unit: "token", placeholder: "例如 128000" },
  { key: "maxTokens", label: "输出上限", section: "generation", input: "number", types: ["language"], unit: "token", placeholder: "例如 4096" },
  { key: "dimensions", label: "向量维度", section: "advanced", input: "number", types: ["embedding"], hint: "仅嵌入模型需要。" },
];

export function fieldsForType(type: ModelType): ModelFieldDef[] {
  return MODEL_FIELDS.filter((field) => field.types.includes(type));
}

/** 当前类型不适用的字段一律不参与提交，切换回来时从各自的暂存恢复。 */
export function applicableKeys(type: ModelType): Set<FieldKey> {
  return new Set(fieldsForType(type).map((field) => field.key));
}

export function typeOfDraft(draft: Record<string, unknown>): ModelType {
  const value = draft.type;
  return typeof value === "string" && (MODEL_TYPE_VALUES as readonly string[]).includes(value) ? (value as ModelType) : "language";
}

export interface ThinkingDraft {
  mode: string;
  efforts: string[];
}

export function readThinking(draft: Record<string, unknown>): ThinkingDraft {
  const value = draft.thinking;
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const mode = typeof record.mode === "string" ? record.mode.trim() : "";
  const efforts = Array.isArray(record.efforts) ? record.efforts.filter((item): item is string => typeof item === "string") : [];
  return { mode, efforts };
}

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : undefined;
}

export interface ValidationContext {
  /** 该标识在目标供应商下是否已被其他模型占用。 */
  modelTaken: (id: string) => boolean;
  /** 该模型被模型组引用时标识锁定。 */
  lockedId?: boolean;
  /** 编辑中的原始标识；与原始一致不视为占用。 */
  originalId?: string;
}

export type FieldErrors = Partial<Record<FieldKey, string>>;

export function validateModelDraft(draft: Record<string, unknown>, context: ValidationContext): FieldErrors {
  const errors: FieldErrors = {};
  const type = typeOfDraft(draft);
  const keys = applicableKeys(type);
  const id = typeof draft.id === "string" ? draft.id.trim() : "";

  if (id.length === 0) errors.id = "模型标识必填。";
  else if (id.includes(":")) errors.id = "模型标识不能包含冒号。";
  else if (/\s/.test(id)) errors.id = "模型标识不能包含空白字符。";
  else if (context.lockedId === true && context.originalId !== undefined && id !== context.originalId) errors.id = "该模型被模型组引用，标识不能修改。";
  else if (id !== context.originalId && context.modelTaken(id)) errors.id = `模型标识 ${id} 在该供应商下已存在。`;

  if (keys.has("thinking")) {
    const thinking = readThinking(draft);
    if (thinking.mode.length === 0 && thinking.efforts.length > 0) errors.thinking = "填写思考档位之前需要先填写思考模式参数名。";
    if (thinking.mode.length > 0 && thinking.efforts.length === 0) errors.thinking = "思考模式参数名已填写时至少选择一个档位。";
    if (thinking.efforts.some((level) => !(THINK_LEVELS as readonly string[]).includes(level))) errors.thinking = "思考档位包含未知的取值。";
  }

  for (const [key, label] of [
    ["contextWindow", "上下文窗口"],
    ["maxTokens", "输出上限"],
    ["dimensions", "向量维度"],
  ] as const) {
    if (!keys.has(key)) continue;
    const value = draft[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) errors[key] = `${label}需要大于 0 的整数。`;
  }
  return errors;
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined && message.length > 0);
}

/** 从声明构造各类型的暂存草稿；编辑已有模型时按类型还原。 */
export function draftsFromDecl(decl: ModelDecl): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const type of MODEL_TYPE_VALUES) result[type] = {};
  const source = decl as unknown as Record<string, unknown>;
  const type = typeof source.type === "string" && (MODEL_TYPE_VALUES as readonly string[]).includes(source.type) ? (source.type as ModelType) : "language";
  const target = result[type];
  for (const field of fieldsForType(type)) {
    const value = source[field.key];
    if (value !== undefined) target[field.key] = value;
  }
  target.type = type;
  return result;
}

/** 只保留当前类型适用的字段并组装声明；布尔仅在显式开启时写入。 */
export function buildModelDecl(draft: Record<string, unknown>): ModelDecl {
  const type = typeOfDraft(draft);
  const keys = applicableKeys(type);
  const id = (typeof draft.id === "string" ? draft.id : "").trim();
  const decl: ModelDecl = { id, type };

  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (keys.has("name") && name.length > 0) decl.name = name;
  if (keys.has("toolCall") && draft.toolCall === true) decl.toolCall = true;
  if (keys.has("reasoning") && draft.reasoning === true) decl.reasoning = true;
  const input = keys.has("input") ? stringList(draft.input) : undefined;
  if (input !== undefined && input.length > 0) decl.input = input;
  if (keys.has("thinking")) {
    const thinking = readThinking(draft);
    if (thinking.mode.length > 0 && thinking.efforts.length > 0) decl.thinking = { mode: thinking.mode, efforts: [...thinking.efforts] };
  }
  for (const key of ["contextWindow", "maxTokens", "dimensions"] as const) {
    if (!keys.has(key)) continue;
    const value = draft[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) decl[key] = value;
  }
  return decl;
}

/** 在线名单条目转换为表单草稿；能力字段缺失时留给用户补填。 */
export function remoteToDraft(remote: RemoteModelInfo): Record<string, unknown> {
  const draft: Record<string, unknown> = { id: remote.id, type: "language" };
  if (remote.name !== undefined && remote.name.length > 0) draft.name = remote.name;
  if (remote.contextWindow !== undefined) draft.contextWindow = remote.contextWindow;
  if (remote.maxTokens !== undefined) draft.maxTokens = remote.maxTokens;
  return draft;
}
