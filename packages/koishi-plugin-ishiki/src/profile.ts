import { Schema } from "koishi";

import { ContextEngines } from "./context-engine.js";
import { ToolcallEngines } from "./toolcall/config.js";
import { WakeupEngines } from "./wakeup-engine.js";

/**
 * 按 `engine` 判别的联合类型，同名键下为该引擎的参数（可省略，引擎自行填充默认值）。
 * 参数声明为可选而非改用索引签名，以保证 `config[config.engine]` 仍能推导出具体类型。
 * 未登记的引擎名只可能出现在 YAML 中，运行时按参数缺失处理。
 */
type EngineConfig<E> = [keyof E] extends [never]
  ? { engine: string; [k: string]: unknown }
  : { [K in keyof E]: { engine: K } & Partial<Record<K, E[K]>> }[keyof E];

export type ContextConfig = EngineConfig<ContextEngines>;

export const ContextConfig: Schema<ContextConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string(),
  }).required(),
  Schema.union([Schema.any()]),
]);

export type WakeupConfig = EngineConfig<WakeupEngines>;

export const WakeupConfig: Schema<WakeupConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string(),
  }).required(),
  Schema.union([Schema.any()]),
]);

export type ToolcallConfig = EngineConfig<ToolcallEngines>;

export const ToolcallConfig: Schema<ToolcallConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string().default("native").description("工具调用方式：native 用模型原生 function call，json 由解析引擎从纯文本输出提取"),
  }),
  Schema.union([Schema.any()]),
]);

/**
 * 模拟打字节奏的参数：每条消息发出前等多久。
 * 延迟按可见字符数估算，CJK 与拉丁字符各按一档速度计，再乘一个随机系数，最后夹在上下限之间。
 */
export interface TypingConfig {
  /** 每条消息的基础延迟（毫秒）。 */
  baseDelay: number;
  /** 模拟打字速度（字符/秒）；拉丁字符按 1.5 倍计，设为 0 时只留 minDelay。 */
  charPerSecond: number;
  /** 单条消息延迟下限（毫秒）。 */
  minDelay: number;
  /** 单条消息延迟上限（毫秒）。 */
  maxDelay: number;
}

/** 未配置时的打字节奏；Schema 默认值与展开时的兜底都取自这里。 */
export const DEFAULT_TYPING: TypingConfig = { baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 };

export const TypingConfig: Schema<TypingConfig> = Schema.object({
  baseDelay: Schema.number().default(DEFAULT_TYPING.baseDelay).description("基础延迟（毫秒）"),
  charPerSecond: Schema.number().default(DEFAULT_TYPING.charPerSecond).description("模拟打字速度（字符/秒）"),
  minDelay: Schema.number().default(DEFAULT_TYPING.minDelay).description("单条延迟下限（毫秒）"),
  maxDelay: Schema.number().default(DEFAULT_TYPING.maxDelay).description("单条延迟上限（毫秒）"),
});

/** 覆写形状：字段与 {@link TypingConfig} 相同但不带默认值，未写的字段留给 preset。 */
export const TypingOverride: Schema<Partial<TypingConfig>> = Schema.object({
  baseDelay: Schema.number().description("基础延迟（毫秒）"),
  charPerSecond: Schema.number().description("模拟打字速度（字符/秒）"),
  minDelay: Schema.number().description("单条延迟下限（毫秒）"),
  maxDelay: Schema.number().description("单条延迟上限（毫秒）"),
});

/**
 * ### Scene
 *
 * Scene 是一份装配清单（工厂）：绑定一个 Bot 账号，并认领该账号名下的若干频道。
 * 每个匹配到的频道各创建一个 `SceneRuntime`（一 Channel 一 Agent），
 * 同一频道全局只能被一个 Scene 认领。
 *
 * Example:
 * ```yaml
 * sid: onebot:12345 # 必填：Scene 绑定的 Bot 账号
 * preset: <preset-name>
 *
 * whitelist:
 *   - "group:*" # 该账号下的全部群聊
 *   - "private:12345" # 也可逐个列出频道 id
 *
 * blacklist:
 *   - "12345678"
 *
 * # 对 preset 的局部覆写
 * model: <model-or-group-name>
 * typing:
 *   baseDelay: 500
 *   charPerSecond: 5
 *   minDelay: 800
 *   maxDelay: 4000
 * context:
 *   engine: <context-engine-a>
 *   <context-engine-a>:
 *     paramA:
 *     paramB:
 * ```
 */
export interface SceneConfig {
  description?: string;
  sid: string;
  preset: string;
  /** 认领的频道模式：`*` 全部，尾随 `*` 按前缀，其余精确；留空不认领任何频道。 */
  whitelist?: string[];
  /** 排除的频道模式，写法同 whitelist。 */
  blacklist?: string[];
  model?: string;
  context?: ContextConfig;
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  /** 打字节奏的局部覆写；未写的字段沿用 preset（若 preset 也没写，用内置默认）。 */
  typing?: Partial<TypingConfig>;
}

export const SceneConfig: Schema<SceneConfig> = Schema.object({
  description: Schema.string(),
  sid: Schema.string().required(),
  preset: Schema.string().required(),
  whitelist: Schema.array(Schema.string()).default([]),
  blacklist: Schema.array(Schema.string()).default([]),
  model: Schema.string(),
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  typing: TypingOverride,
});

/**
 * ### Preset
 *
 * Preset 是可复用运行模式配置
 *
 * Example:
 * ```yaml
 * description: <preset-description> # for display only
 *
 * model: <model-or-group-name>
 *
 * # 发消息前等多久，模拟打字
 * typing:
 *   baseDelay: 500
 *   charPerSecond: 5
 *   minDelay: 800
 *   maxDelay: 4000
 *
 * context:
 *   engine: <context-engine-a>
 *   <context-engine-a>:
 *     paramA:
 *     paramB:
 *
 * wakeup:
 *   engine: <wakeup-engine-a>
 *   <wakeup-engine-a>:
 *     paramA:
 *     paramB:
 *
 * # for future features
 * memory:
 *   engine: <memory-engine-a>
 *   <memory-engine-a>:
 *     paramA:
 *     paramB:
 * ```
 */
export interface PresetConfig {
  description?: string;
  model: string;
  context: ContextConfig;
  wakeup: WakeupConfig;
  toolcall?: ToolcallConfig;
  typing: TypingConfig;
}

export const PresetConfig: Schema<PresetConfig> = Schema.object({
  description: Schema.string(),
  model: Schema.string().required(),
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  typing: TypingConfig,
});

/**
 * ### Profile
 *
 * Profile 是一份人设，也是一个通信域：仅同一 Profile 内的 Scene 之间可互相投递 stimulus。
 *
 * Example:
 * ```yaml
 * id: <profile-id> # 可选，缺省为所在目录名
 * description: <profile-description> # for display only
 *
 * presets:
 *   <preset-name-a>:
 *     <preset-config-a>
 *   ...
 *
 * scenes:
 *   <scene-name-a>:
 *     description: <scene-description-a> # for display only
 *     sid: <bot-sid> # 该 Scene 绑定的 Bot 账号，必填
 *     preset: <preset-to-use>
 *     whitelist:
 *       - <channel-pattern> # `*` 全部，`<前缀>*` 前缀匹配；留空不认领任何频道
 *     blacklist:
 *       - <channel-pattern>
 *
 *     # 可局部覆写 preset 配置
 *     model: <model-or-group-name>
 * ```
 */
export interface ProfileConfig {
  id?: string;
  description?: string;
  presets: Record<string, PresetConfig>;
  scenes: Record<string, SceneConfig>;
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  id: Schema.string(),
  description: Schema.string(),
  presets: Schema.dict(PresetConfig).required(),
  scenes: Schema.dict(SceneConfig).required(),
});

/**
 * 展开后的装配清单，即一份工厂，Preset 已展开到本层。
 * 它描述该类频道的运行参数；匹配到的每个频道各创建一个 `SceneRuntime`（一 Channel 一 Agent）。
 */
export interface SceneSpec {
  /** 所属 Profile 的 id。 */
  profile: string;
  /** Profile 内唯一的 Scene 名，即 `scenes` 的键。 */
  name: string;
  /** 绑定的 Bot 账号；其名下频道均由该 spec 展开。 */
  sid: string;
  description?: string;
  model: string;
  context: ContextConfig;
  wakeup: WakeupConfig;
  /** 工具调用方式，Preset 与 Scene 的覆写已在此合并；缺省 native。 */
  toolcall: ToolcallConfig;
  /** 打字节奏，Preset 与 Scene 的覆写已在此合并。 */
  typing: TypingConfig;
  whitelist: string[];
  blacklist: string[];
}

const STANDARD = { engine: "standard" } as const;
const NATIVE_TOOLCALL: ToolcallConfig = { engine: "native" };

/** 目录名安全化：生成由 sid 与 channelId 拼成的单段文件名时使用。 */
export function sceneDirectoryName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}

/** 这批模式是否覆盖指定频道：`*` 全部，尾随 `*` 按前缀（`group:*`），其余按精确值。 */
export function matchesChannel(patterns: readonly string[], channelId: string): boolean {
  return patterns.some((pattern) => pattern === "*" || (pattern.endsWith("*") ? channelId.startsWith(pattern.slice(0, -1)) : pattern === channelId));
}

/** 该 spec 是否认领指定频道：白名单命中且未被黑名单排除。 */
export function claimsChannel(spec: Pick<SceneSpec, "whitelist" | "blacklist">, channelId: string): boolean {
  return matchesChannel(spec.whitelist, channelId) && !matchesChannel(spec.blacklist, channelId);
}

/** Scene 对 Preset 的覆写：引擎名相同时合并参数，不同时整体替换。 */
function mergeEngine<T extends { engine: string; [k: string]: unknown }>(preset: T, scene?: Partial<T>): T {
  if (!scene?.engine) return { ...preset };
  if (scene.engine !== preset.engine) return { ...scene } as T;
  const key = preset.engine;
  const presetParams = preset[key] as Record<string, unknown> | undefined;
  const sceneParams = scene[key] as Record<string, unknown> | undefined;
  return { ...preset, ...scene, [key]: { ...presetParams, ...sceneParams } } as T;
}

/** 将 Preset 展开到单个 Scene；此处校验悬空 preset 引用与缺失的 sid。`id` 是调用方定好的 Profile 标识。 */
export function resolveScene(profile: ProfileConfig, name: string, id: string): SceneSpec {
  const scene = profile.scenes[name];
  if (!scene) throw new Error(`Profile "${id}" has no scene "${name}"`);

  const preset = profile.presets[scene.preset];
  if (!preset) throw new Error(`Scene "${name}" of profile "${id}" references unknown preset "${scene.preset}"`);

  const sid = scene.sid?.trim();
  if (!sid) throw new Error(`Scene "${name}" of profile "${id}" needs a "sid"`);

  return {
    profile: id,
    name,
    sid,
    description: scene.description || preset.description,
    model: scene.model || preset.model,
    context: mergeEngine(preset.context ?? STANDARD, scene.context),
    wakeup: mergeEngine(preset.wakeup ?? STANDARD, scene.wakeup),
    toolcall: mergeEngine(preset.toolcall ?? NATIVE_TOOLCALL, scene.toolcall),
    // 手写的配置未必过 Schema，所以这里再兜一次默认值，让 spec 的 typing 始终完整。
    typing: { ...DEFAULT_TYPING, ...preset.typing, ...scene.typing },
    whitelist: scene.whitelist ?? [],
    blacklist: scene.blacklist ?? [],
  };
}

/**
 * 展开一个已解析的 Profile 的全部 spec。频道归属不在这里判定：两个 spec 都认领同一频道时，写在前面的那个接管。
 * 入参是 {@link ProfileConfig} 解析过的配置；原始 YAML 由装载方（`loadProfiles`）负责读取与解析。
 */
export function resolveProfile(profile: ProfileConfig, id: string): SceneSpec[] {
  return Object.keys(profile.scenes).map((name) => resolveScene(profile, name, id));
}

/** 按账号与频道匹配 spec：数组顺序即优先级，首条命中即归属；命中后由运行时按需创建对应的 SceneRuntime。 */
export function matchSceneSpec(specs: readonly SceneSpec[], target: { sid: string; channelId: string }): SceneSpec | undefined {
  return specs.find((spec) => spec.sid === target.sid && claimsChannel(spec, target.channelId));
}
