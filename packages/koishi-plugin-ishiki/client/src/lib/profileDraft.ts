import type { EnginesDirectory, ProfileView } from "../types";

/** 向导与创建/编辑共用的 Profile 草稿结构；提交前统一走这里的校验与组装。 */
export interface ProfileChannelDraft {
  account: string;
  patterns: string;
}

export interface ProfileDraft {
  id: string;
  mode: "channel" | "cross";
  model: string;
  channels: ProfileChannelDraft[];
  persona: string;
  engines: { context: string; wakeup: string; toolcall: string };
}

export const DEFAULT_ENGINES = { context: "standard", wakeup: "standard", toolcall: "native" } as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACCOUNT_PATTERN = /^[^:\s]+:[^:\s]+$/;

export function blankProfileDraft(): ProfileDraft {
  return { id: "", mode: "channel", model: "", channels: [], persona: "", engines: { ...DEFAULT_ENGINES } };
}

function engineName(value: unknown): string {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).engine === "string"
    ? ((value as Record<string, unknown>).engine as string)
    : "";
}

/** 重新进入向导时，用已保存的配置回填草稿。 */
export function draftFromProfile(view: ProfileView): ProfileDraft {
  const config = view.config;
  const channelsRaw = config.channels;
  const channels: ProfileChannelDraft[] =
    channelsRaw !== null && typeof channelsRaw === "object" && !Array.isArray(channelsRaw)
      ? Object.entries(channelsRaw as Record<string, unknown>).map(([account, patterns]) => ({
          account,
          patterns: Array.isArray(patterns) ? patterns.filter((item): item is string => typeof item === "string").join(" ") : "",
        }))
      : [];
  return {
    id: view.id,
    mode: view.mode,
    model: view.model,
    channels,
    persona: view.persona,
    engines: {
      context: engineName(config.context) || DEFAULT_ENGINES.context,
      wakeup: engineName(config.wakeup) || DEFAULT_ENGINES.wakeup,
      toolcall: engineName(config.toolcall) || DEFAULT_ENGINES.toolcall,
    },
  };
}

export function parsePatterns(patterns: string): string[] {
  return patterns
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 组装为与现有配置表单兼容的 ProfileConfig 输入；其余字段由服务端 Schema 补默认值。 */
export function buildProfileConfig(draft: ProfileDraft): Record<string, unknown> {
  const channels: Record<string, string[]> = {};
  for (const row of draft.channels) {
    const account = row.account.trim();
    if (account.length === 0) continue;
    channels[account] = parsePatterns(row.patterns);
  }
  const config: Record<string, unknown> = {
    model: draft.model.trim(),
    mode: draft.mode,
    context: { engine: draft.engines.context },
    wakeup: { engine: draft.engines.wakeup },
    toolcall: { engine: draft.engines.toolcall },
  };
  if (Object.keys(channels).length > 0) config.channels = channels;
  return config;
}

export interface ProfileValidationContext {
  /** 目录是否已被其他 Profile 占用；编辑时排除自身。 */
  idTaken: (id: string) => boolean;
  /** 模型引用（含模型组）是否存在于模型目录。 */
  modelDeclared: (reference: string) => boolean;
}

export type ProfileFieldErrors = Partial<Record<"id" | "model" | "channels", string>>;

export function validateProfileDraft(draft: ProfileDraft, context: ProfileValidationContext): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};
  const id = draft.id.trim();

  if (id.length === 0) errors.id = "Profile 标识必填。";
  else if (!ID_PATTERN.test(id) || id.includes("..")) errors.id = "标识只能包含字母、数字、点、下划线与连字符，并以字母或数字开头。";
  else if (context.idTaken(id)) errors.id = `Profile ${id} 已存在。`;

  const model = draft.model.trim();
  if (model.length === 0) errors.model = "需要选择一个模型或模型组。";
  else if (!context.modelDeclared(model)) errors.model = `模型引用 ${model} 不在模型目录里，先在模型页声明。`;

  if (draft.mode === "channel") {
    for (const row of draft.channels) {
      const account = row.account.trim();
      if (account.length === 0 && row.patterns.trim().length === 0) continue;
      if (!ACCOUNT_PATTERN.test(account)) {
        errors.channels = "账号需要写成 platform:selfId，例如 qq:12345。";
        break;
      }
      if (parsePatterns(row.patterns).length === 0) {
        errors.channels = "每个认领的账号至少需要一个频道模式。";
        break;
      }
    }
  }
  return errors;
}

export function hasProfileErrors(errors: ProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined && message.length > 0);
}

/** 引擎目录为空时回退到默认名，保证选择器始终有可选项。 */
export function engineChoices(directory: EnginesDirectory["context"] | undefined): Array<{ name: string; label: string; available: boolean }> {
  if (directory === undefined || directory.length === 0) return [{ name: "standard", label: "standard", available: true }];
  return directory.map((engine) => ({ name: engine.name, label: engine.label, available: engine.available }));
}
