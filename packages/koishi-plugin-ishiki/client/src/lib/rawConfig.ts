import { parse, stringify, YAMLParseError } from "yaml";

import { applicableKeys, typeOfDraft, validateModelDraft, type FieldErrors } from "./modelFields";

/** RAW 模式与磁盘配置同格式（YAML）；这里统一序列化、解析与字段检查。 */
export interface RawIssue {
  message: string;
  /** YAML 语法错误的行号（1 起）。 */
  line?: number;
  /** 语义错误的字段路径，例如 provider.api。 */
  path?: string;
}

export type RawParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; issues: RawIssue[] };

export function serializeRaw(value: unknown): string {
  return stringify(value, { lineWidth: 0 }) ?? "";
}

export function parseRaw(text: string): RawParseResult {
  if (text.trim().length === 0) return { ok: false, issues: [{ message: "内容为空，至少需要一个空对象。" }] };
  try {
    const value: unknown = parse(text, { merge: false });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, issues: [{ message: "顶层必须是一个对象。" }] };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    if (error instanceof YAMLParseError) {
      return { ok: false, issues: [{ message: error.message, line: error.linePos?.[0]?.line }] };
    }
    return { ok: false, issues: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

export function formatRawIssue(issue: RawIssue): string {
  const at = issue.line !== undefined ? `第 ${issue.line} 行` : issue.path !== undefined ? issue.path : undefined;
  return at === undefined ? issue.message : `${at}：${issue.message}`;
}

export function formatRawIssues(issues: readonly RawIssue[]): string[] {
  return issues.map(formatRawIssue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Profile 配置的 RAW 检查：类型错误、必填缺失与未知顶层字段。
 * knownKeys 由调用方从 Schema 目录（基础字段 + 扩展名）汇总后传入。
 */
export function inspectProfileConfig(value: Record<string, unknown>, knownKeys: readonly string[]): RawIssue[] {
  const issues: RawIssue[] = [];
  const known = new Set([...knownKeys, "context", "wakeup", "toolcall", "extends"]);

  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    issues.push({ message: "必填字段缺失：model 需要是非空字符串。", path: "model" });
  }
  if (value.mode !== undefined && value.mode !== "channel" && value.mode !== "cross") {
    issues.push({ message: "mode 只能是 channel 或 cross。", path: "mode" });
  }
  if (value.channels !== undefined) {
    if (!isRecord(value.channels)) issues.push({ message: "channels 需要是账号到频道模式数组的映射。", path: "channels" });
    else {
      for (const [account, patterns] of Object.entries(value.channels)) {
        if (!stringArray(patterns)) issues.push({ message: "频道模式需要是字符串数组。", path: `channels.${account}` });
      }
    }
  }
  if (value.instructions !== undefined && !stringArray(value.instructions)) {
    issues.push({ message: "instructions 需要是字符串数组。", path: "instructions" });
  }
  for (const key of ["context", "wakeup", "toolcall"] as const) {
    const engine = value[key];
    if (engine === undefined) continue;
    if (!isRecord(engine)) issues.push({ message: `${key} 需要是对象。`, path: key });
    else if (engine.engine !== undefined && typeof engine.engine !== "string") issues.push({ message: "engine 需要是字符串。", path: `${key}.engine` });
  }
  if (value.extends !== undefined) {
    if (!isRecord(value.extends)) issues.push({ message: "extends 需要是对象。", path: "extends" });
    else {
      for (const [name, entry] of Object.entries(value.extends)) {
        if (!isRecord(entry)) issues.push({ message: "扩展条目需要是对象。", path: `extends.${name}` });
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issues.push({ message: `未知字段 ${key}，保存时会被丢弃。`, path: key });
  }
  return issues;
}

export interface RawModelEntry {
  provider: Record<string, unknown>;
  model: Record<string, unknown>;
}

/**
 * 模型编辑器的 RAW 载体：{ provider: 连接信息, model: 模型声明 }。
 * 字段级校验复用 modelFields 注册表，表单与 RAW 不会出现两套规则。
 */
export function inspectModelEntry(value: Record<string, unknown>, context: Parameters<typeof validateModelDraft>[1]): { issues: RawIssue[]; entry?: RawModelEntry } {
  const issues: RawIssue[] = [];
  const provider = value.provider;
  const model = value.model;

  if (!isRecord(provider)) {
    issues.push({ message: "provider 需要是对象。", path: "provider" });
  } else {
    if (typeof provider.api !== "string" || provider.api.trim().length === 0) issues.push({ message: "接口类型 api 必填。", path: "provider.api" });
    if (provider.baseUrl !== undefined && provider.baseUrl !== null && typeof provider.baseUrl !== "string") {
      issues.push({ message: "baseUrl 需要是字符串。", path: "provider.baseUrl" });
    }
    if (provider.apiKey !== undefined && provider.apiKey !== null && typeof provider.apiKey !== "string") {
      issues.push({ message: "apiKey 需要是字符串。", path: "provider.apiKey" });
    }
    if (provider.headers !== undefined && provider.headers !== null && !isRecord(provider.headers)) {
      issues.push({ message: "headers 需要是对象。", path: "provider.headers" });
    }
    if (provider.settings !== undefined && provider.settings !== null && !isRecord(provider.settings)) {
      issues.push({ message: "settings 需要是对象。", path: "provider.settings" });
    }
  }

  if (!isRecord(model)) {
    issues.push({ message: "model 需要是对象。", path: "model" });
  } else {
    const type = typeOfDraft(model);
    const allowed = applicableKeys(type);
    for (const key of Object.keys(model)) {
      if (!allowed.has(key as never)) issues.push({ message: `字段 ${key} 不适用于 ${type} 类型模型。`, path: `model.${key}` });
    }
    const fieldErrors: FieldErrors = validateModelDraft(model, context);
    for (const [key, message] of Object.entries(fieldErrors)) {
      if (message !== undefined) issues.push({ message, path: `model.${key}` });
    }
  }

  if (issues.length > 0) return { issues };
  return { issues, entry: { provider: provider as Record<string, unknown>, model: model as Record<string, unknown> } };
}
