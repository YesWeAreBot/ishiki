import { Schema } from "koishi";

import { ContextEngines } from "./context/index.js";
import { ToolcallEngines } from "./toolcall/index.js";
import { WakeupEngines } from "./wakeup/index.js";

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
    engine: Schema.string(),
  }).required(),
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

/**
 * 唯一一份声明：preset 与 scene 共用它。
 * 不给默认值——被它补上的值与用户写的值在合并层形状相同、无从分辨，覆写语义会因此失效；缺省值在 {@link FALLBACK}。
 */
export const TypingConfig: Schema<Partial<TypingConfig>> = Schema.object({
  baseDelay: Schema.number().description("每条消息的基础延迟（毫秒）"),
  charPerSecond: Schema.number().description("模拟打字速度（字符/秒）"),
  minDelay: Schema.number().description("单条消息延迟下限（毫秒）"),
  maxDelay: Schema.number().description("单条消息延迟上限（毫秒）"),
});

/**
 * 一次模型调用的降级与重试。谁在组里、按什么顺序试、熔断阈值多少，都在 models.yaml 的 group 里；
 * 这里只管这一次调用最多试几次、隔多久。
 *
 * 不给默认值——理由同 {@link TypingConfig}，缺省在 {@link FALLBACK}。
 */
export interface FailoverConfig {
  /** 一次模型调用的最大尝试次数。缺省跑完一轮候选，即组内每个成员各试一次。 */
  attempts?: number;
  /** 首次重试前的等待（毫秒），逐次翻倍，封顶 8s，取半抖动。 */
  backoffMs: number;
  /** 换不换人：`unavailable` 只在端点不可用时换；`any` 连请求本身的问题也换，用在不认某个参数的 relay 上。 */
  failoverOn: "unavailable" | "any";
}

export const FailoverConfig: Schema<Partial<FailoverConfig>> = Schema.object({
  attempts: Schema.number().description("一次模型调用的最大尝试次数；缺省跑完一轮候选"),
  backoffMs: Schema.number().description("首次重试前的等待（毫秒），逐次翻倍，封顶 8s"),
  failoverOn: Schema.union([Schema.const("unavailable"), Schema.const("any")]).description("unavailable：只在端点不可用时换人；any：请求本身的问题也换"),
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
 * failover:
 *   attempts: 3
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
  /** 降级与重试的局部覆写；未写的字段沿用 preset（若 preset 也没写，用内置默认）。 */
  failover?: Partial<FailoverConfig>;
  context?: ContextConfig;
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  /** 是否启用幕后通道：每个工具的参数表前置 inner_thoughts，think 工具退场。默认关闭。 */
  innerThoughts?: boolean;
  /** 打字节奏的局部覆写；未写的字段沿用 preset（若 preset 也没写，用内置默认）。 */
  typing?: Partial<TypingConfig>;
}

export const SceneConfig: Schema<SceneConfig> = Schema.object({
  description: Schema.string(),
  sid: Schema.string().required(),
  preset: Schema.string().required(),
  whitelist: Schema.array(Schema.string()),
  blacklist: Schema.array(Schema.string()),
  model: Schema.string(),
  failover: FailoverConfig,
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  innerThoughts: Schema.boolean().description("将幕后念头挂到每个工具的参数表上（inner_thoughts），并移除 think 工具"),
  typing: TypingConfig,
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
 * # 一次模型调用最多试几次、隔多久；model 是组名或配了 attempts 时生效
 * failover:
 *   attempts: 3
 *   backoffMs: 500
 *   failoverOn: unavailable
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
  failover?: Partial<FailoverConfig>;
  context: ContextConfig;
  wakeup: WakeupConfig;
  toolcall?: ToolcallConfig;
  /** 是否启用幕后通道：每个工具的参数表前置 inner_thoughts，think 工具退场。默认关闭。 */
  innerThoughts?: boolean;
  typing?: Partial<TypingConfig>;
}

export const PresetConfig: Schema<PresetConfig> = Schema.object({
  description: Schema.string(),
  model: Schema.string().required(),
  failover: FailoverConfig,
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  innerThoughts: Schema.boolean().description("将幕后念头挂到每个工具的参数表上（inner_thoughts），并移除 think 工具"),
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
  /** 降级与重试，Preset 与 Scene 的覆写已在此合并。 */
  failover: FailoverConfig;
  context: ContextConfig;
  wakeup: WakeupConfig;
  /** 工具调用方式，Preset 与 Scene 的覆写已在此合并；缺省 native。 */
  toolcall: ToolcallConfig;
  /** 幕后通道是否启用，Preset 与 Scene 的覆写已在此合并；缺省关闭。 */
  innerThoughts: boolean;
  /** 打字节奏，Preset 与 Scene 的覆写已在此合并。 */
  typing: TypingConfig;
  whitelist: string[];
  blacklist: string[];
}

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

/** 普通对象：合并只在它们之间递归，数组与标量一律整体替换。 */
function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按层合并配置：后一层覆盖前一层，未写的键沿用前一层。
 * `undefined` 与不含键的对象都算「未写」——Schema 会为空缺的块物化出空对象，这里不必特判。
 * 引擎参数按引擎名分键，换引擎后旧引擎的参数会留在结果里；消费端只读 `config[config.engine]`，那些键不会被读到。
 */
function merge<T>(base: T, ...layers: readonly unknown[]): T {
  const overlay = (current: unknown, override: unknown): unknown => {
    if (override === undefined) return current;
    if (!isPlain(current) || !isPlain(override)) return override;
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      merged[key] = overlay(merged[key], value);
    }
    return merged;
  };
  // 入参已过 Schema 校验，故按 base 的形状断言：这一层只管结构，不管取值合法性。
  return layers.reduce<unknown>(overlay, base) as T;
}

/**
 * Spec 的缺省层：三层合并的最底层，也是配置面唯一的默认值来源。
 * Schema 里一律不留 default——被它补上的值与用户写的值在合并层形状相同，覆写语义会因此失效。
 */
const FALLBACK: Pick<SceneSpec, "failover" | "context" | "wakeup" | "toolcall" | "innerThoughts" | "typing" | "whitelist" | "blacklist"> = {
  failover: { backoffMs: 500, failoverOn: "unavailable" },
  context: { engine: "standard" },
  wakeup: { engine: "standard" },
  toolcall: { engine: "native" },
  innerThoughts: false,
  typing: { baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
  whitelist: [],
  blacklist: [],
};

/** 将 Preset 展开到单个 Scene；此处校验悬空 preset 引用与缺失的 sid。`id` 是调用方定好的 Profile 标识。 */
export function resolveScene(profile: ProfileConfig, name: string, id: string): SceneSpec {
  const scene = profile.scenes[name];
  if (!scene) throw new Error(`Profile "${id}" has no scene "${name}"`);

  // sid 与 preset 只用于定位，不参与合并；其余字段按层展开。
  const { sid: rawSid, preset: presetName, ...overrides } = scene;
  const preset = profile.presets[presetName];
  if (!preset) throw new Error(`Scene "${name}" of profile "${id}" references unknown preset "${presetName}"`);

  const sid = rawSid?.trim();
  if (!sid) throw new Error(`Scene "${name}" of profile "${id}" needs a "sid"`);

  return {
    profile: id,
    name,
    sid,
    // 三层：内置缺省 ← preset ← scene。model 由 PresetConfig 保证必填，先落进 base 定住结果类型。
    ...merge({ ...FALLBACK, model: preset.model, description: preset.description }, preset, overrides),
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
