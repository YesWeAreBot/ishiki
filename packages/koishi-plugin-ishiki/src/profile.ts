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
 * 代码模式的参数：模型改写一段程序，程序在沙箱里调工具，中间数据不出上下文。
 *
 * 它不动工具调用协议（仍是模型原生的 function call），只改工具面：除 `direct` 里的工具外，
 * 其余工具全部收进沙箱，模型的目录里只剩 code_mode 一个。
 */
export interface CodemodeConfig {
  /** 是否启用；关闭时工具面与配置无关，模型照旧逐个调工具。 */
  enable: boolean;
  /**
   * 仍只给模型直调、不收进沙箱的工具名。
   * `send_message` 与 `finish` 恒在模型目录里，不靠这份清单：前者的停轮语义挂在直调的那次调用上
   * （程序里也能说话，但不结束轮次），后者是直调的专属动作（程序够不着）。这里给的是额外那份。
   */
  direct: string[];
  /** 单次沙箱执行的总时限（毫秒）；超时连同在飞的调用一并中止。 */
  timeoutMs: number;
}

/**
 * 唯一一份声明：preset 与 scene 共用它。
 * 不给默认值——被它补上的值与用户写的值在合并层形状相同、无从分辨，覆写语义会因此失效；缺省值在 {@link FALLBACK}。
 */
export const CodemodeConfig: Schema<Partial<CodemodeConfig>> = Schema.object({
  enable: Schema.boolean().description("启用代码模式：模型写程序，程序在沙箱里调工具"),
  direct: Schema.array(Schema.string()).description("仍只给模型直调、不收进沙箱的工具名（send_message 与 finish 恒在目录里）"),
  timeoutMs: Schema.number().description("单次沙箱执行的总时限（毫秒）"),
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
 * ### 频道名单
 *
 * `whitelist` / `blacklist` 这一对字段在配置面出现两处：普通 scene 的认领清单与 cross preset 的 claim，
 * 形状完全一致，声明只留一份。
 *
 * 两个数组的缺省层刻意取 undefined：schemastery 会为空缺的 array 物化出 `[]`，
 * 于是「显式声明不认领任何频道」与「忘了写」在解析之后会长得一模一样。
 * 键保持缺席，装载期才能查出 scene 漏写 whitelist 并报出——`[]` 是合法配置，缺字段是配置错误。
 *
 * Example:
 * ```yaml
whitelist:
  - "group:*" # `*` 全部，尾随 `*` 按前缀，其余精确
  - "private:12345" # 也可逐个列出频道 id
blacklist:
  - "12345678" # 排除的频道，写法同 whitelist
 * ```
 */
export interface ChannelClaim {
  /** 认领的频道模式：`*` 全部，尾随 `*` 按前缀，其余精确；空数组不认领任何频道。 */
  whitelist?: string[];
  /** 排除的频道模式，写法同 whitelist。 */
  blacklist?: string[];
}

export const ChannelClaim: Schema<ChannelClaim> = Schema.object({
  whitelist: Schema.array(Schema.string())
    .default(undefined as unknown as string[])
    .description("认领的频道模式：`*` 全部，尾随 `*` 按前缀，其余精确；空数组表示不认领任何频道"),
  blacklist: Schema.array(Schema.string()).description("排除的频道模式，写法同 whitelist"),
});

/**
 * ### Scene
 *
 * Scene 挂在 preset 下，是一份针对某组频道的扩展：语义是「在这个心智里，对这些频道再补一层」，
 * 不是覆写同 preset 的兄弟 scene。三层合并（内置缺省 ← preset ← scene）逐 scene 独立进行，
 * 生效范围被它自己的名单圈住，跨 scene 的配置冲突在结构上不可能发生，不需要任何合法性规则。
 *
 * Example:
 * ```yaml
presets:
  chat:
    model: <model-or-group-name>
    scenes:
      rooms:
        sid: onebot:12345 # 必填：绑定的 Bot 账号
        whitelist: ["group:*"] # 也可逐个列出频道 id
        blacklist: ["12345678"]
        # 就地扩展 preset 基线；未写的字段沿用 preset，preset 也没写就用内置缺省
        model: <model-or-group-name>
        wakeup: # 引擎变体也可就地覆盖；准入仍受 preset 的 extends 约束
          engine: <wakeup-engine-b>
          <wakeup-engine-b>:
            paramA:
        typing:
          charPerSecond: 8
 * ```
 */
export interface SceneConfig extends ChannelClaim {
  description?: string;
  /**
   * 绑定的 Bot 账号。存在性在 {@link resolveProfile} 报出而不是交给 Schema：
   * Schema 只会说「缺 sid」，不带它在树里的位置，而装载期的一次性清单要能指到具体那一个 scene。
   */
  sid?: string;
  model?: string;
  /** 降级与重试的局部扩展；未写的字段沿用 preset（若 preset 也没写，用内置缺省）。 */
  failover?: Partial<FailoverConfig>;
  /** 上下文引擎的局部覆盖；未写沿用 preset。引擎实例随 AgentRuntime 诞生，一个实例一份。 */
  context?: ContextConfig;
  /** 唤醒引擎的局部覆盖；未写沿用 preset。跨实例状态经 WakeupEngineDeps.shared，不依赖共享实例。 */
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  /** 是否启用幕后通道：每个工具的参数表前置 inner_thoughts，think 工具退场。默认关闭。 */
  innerThoughts?: boolean;
  /** 代码模式的局部覆盖；未写沿用 preset（若 preset 也没写，默认关闭）。 */
  codemode?: Partial<CodemodeConfig>;
  /** 打字节奏的局部扩展；未写的字段沿用 preset（若 preset 也没写，用内置缺省）。 */
  typing?: Partial<TypingConfig>;
}

export const SceneConfig: Schema<SceneConfig> = Schema.object({
  // 名单字段从 {@link ChannelClaim} 借用，两处形状相同，声明只留一份。
  ...ChannelClaim.dict,
  description: Schema.string(),
  sid: Schema.string().description("绑定的 Bot 账号；其名下频道均由该 scene 认领"),
  model: Schema.string(),
  failover: FailoverConfig,
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  innerThoughts: Schema.boolean().description("将幕后念头挂到每个工具的参数表上（inner_thoughts），并移除 think 工具"),
  codemode: CodemodeConfig,
  typing: TypingConfig,
});

/**
 * ### Preset
 *
 * Preset 是心智基线，也是树的分叉点：两种形态互斥，装载期即校验。
 *
 * - 普通形态挂 `scenes`，每个 scene 是一个生效单位（一份按名单圈定频道集的装配清单），
 *   可在自己的频道上就地扩展这份基线。
 * - cross 形态以 `cross: true` 声明 preset 自身即生效单位，频道来自 `claims`：
 *   运行参数只有 preset 这一层，没有 scene 层可以扩展——共享实例下 per-channel 字段无从定义。
 *
 * 形态与归属都写在结构里，不靠「哪个 scene 引用了我」反推：给已被多 scene 挂靠的 preset 打上 cross
 * 不可能顺带合流谁，合流范围就是写下 `claims` 的那几行。
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
 * context: # 一 preset 一套实例，本 preset 的全部频道共用
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
 * scenes: # 普通形态
 *   <scene-name-a>:
 *     sid: <bot-sid> # 必填
 *     whitelist: [<channel-pattern>]
 *
 * cross: true # cross 形态，与 scenes 互斥
 * claims:
 *   "<bot-sid>":
 *     whitelist: [<channel-pattern>]
 * ```
 */
export interface PresetConfig {
  description?: string;
  model: string;
  /**
   * 选中的扩展包名。包级准入是唯一的选择处：选中某个包，它注册的引擎变体（名字写成
   * `包名/名字`）才对本 preset 可用；未列出的不生效。包内细分（阈值多少等）归包自己的配置。
   * 空数组等于不选任何扩展，与不写等价。
   */
  extends?: string[];
  failover?: Partial<FailoverConfig>;
  /** 上下文引擎。缺省补成 `standard`；实例随 AgentRuntime 各造一份。 */
  context?: ContextConfig;
  /** 唤醒引擎。缺省补成 `standard`；跨实例状态经 WakeupEngineDeps.shared。 */
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  /** 是否启用幕后通道：每个工具的参数表前置 inner_thoughts，think 工具退场。默认关闭。 */
  innerThoughts?: boolean;
  /** 代码模式。缺省关闭；启用后除收尾工具与 `direct` 列出的之外，全部工具收进沙箱。 */
  codemode?: Partial<CodemodeConfig>;
  typing?: Partial<TypingConfig>;
  /** 声明本 preset 自身即生效单位（跨频道合流）；与 `scenes` 互斥。 */
  cross?: boolean;
  /** 普通形态下挂靠的 scene 们。 */
  scenes?: Record<string, SceneConfig>;
  /** cross 形态下按 sid 认领的频道；`cross: true` 时必填。 */
  claims?: Record<string, ChannelClaim>;
}

export const PresetConfig: Schema<PresetConfig> = Schema.object({
  description: Schema.string(),
  model: Schema.string().required(),
  extends: Schema.array(Schema.string()).description("选中的扩展包名；选中后该包的引擎变体才对本 preset 可用"),
  failover: FailoverConfig,
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  innerThoughts: Schema.boolean().description("将幕后念头挂到每个工具的参数表上（inner_thoughts），并移除 think 工具"),
  codemode: CodemodeConfig,
  typing: TypingConfig,
  cross: Schema.boolean().description("声明本 preset 自身即生效单位（跨频道合流）；与 scenes 互斥"),
  scenes: Schema.dict(SceneConfig).description("普通形态下挂靠的 scene 们"),
  claims: Schema.dict(ChannelClaim).description("cross 形态下按 sid 认领的频道"),
});

/**
 * ### Profile
 *
 * Profile 是一份人设，也是一个通信域：事实与实例都不跨 Profile 流动。
 *
 * Example:
 * ```yaml
 * id: <profile-id> # 可选，缺省为所在目录名
 * description: <profile-description> # for display only
 *
 * presets:
 *   <preset-name-a>:
 *     <preset-config-a>
 *     scenes: # 或 cross: true + claims，二者互斥
 *       <scene-name-a>:
 *         description: <scene-description-a> # for display only
 *         sid: <bot-sid> # 该 Scene 绑定的 Bot 账号，必填
 *         whitelist:
 *           - <channel-pattern> # `*` 全部，`<前缀>*` 前缀匹配
 *         blacklist:
 *           - <channel-pattern>
 *         # 就地扩展 preset，未写的字段沿用 preset
 *         model: <model-or-group-name>
 * ```
 */
export interface ProfileConfig {
  id?: string;
  description?: string;
  presets: Record<string, PresetConfig>;
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  id: Schema.string(),
  description: Schema.string(),
  presets: Schema.dict(PresetConfig).required(),
});

/**
 * 展开后的装配清单，即一份工厂，Preset 已展开到本层。
 * 它描述一个生效单位的运行参数；匹配到的每个频道各创建一个 `AgentRuntime`（一 Channel 一 Agent）。
 *
 * 引擎配置随三层合并落到本层：引擎实例在装配期按 spec 逐个诞生（一生效单位一份），
 * 配置与实例同层，不再有按 preset 归集的旁路。
 *
 * 两种形态共用一个形状而不是联合类型：运行参数与名单的读法完全一致，差别只在
 * `cross` 这一个判别位与「认领的频道集合怎么来」。多写一套联合会让每个读 spec 的人
 * 都要先分一次支，而分完之后做的事是同一件。
 */
export interface SceneSpec {
  /** 所属 Profile 的 id。 */
  profile: string;
  /**
   * Profile 内唯一的生效单位名：普通形态是 `scenes` 的键，cross 形态是 preset 名。
   * 树内唯一性由位置保证——scene 挂在 preset 下，cross 用 preset 名，profile 内不重名。
   */
  name: string;
  /** 挂靠的 preset 名；两种形态都是它的心智基线。 */
  preset: string;
  /**
   * 认领的频道模式。普通形态来自该 scene 自己的名单，cross 形态是 `claims` 各 sid 的并集。
   * 刻意不按 sid 拆分：现状里 scene 恒定绑一个账号，路由先比 sid 再比名单；
   * cross 一个生效单位跨多个账号，拆开就要让每处读名单的地方改用不同的数据形状。
   */
  whitelist: string[];
  /** 排除的频道模式，写法同 whitelist；cross 形态取各 sid 的并集。 */
  blacklist: string[];
  /**
   * 普通形态绑定的 Bot 账号。cross 形态没有单一账号——见 {@link claims}。
   * 空串表示无：cross 的频道可能分属多个账号，强行取一个会让路由在 `matchSceneSpec` 处静默失配。
   */
  sid: string;
  /** cross 形态按 sid 认领的频道；普通形态为 undefined。 */
  claims?: Record<string, ChannelClaim>;
  /** 该生效单位是否为 cross preset 自身（跨频道合流，共享一块视窗）。 */
  cross: boolean;
  /** 该 preset 选中的扩展包名；引擎变体的准入清单，随 preset 继承。 */
  extends: string[];
  description?: string;
  model: string;
  /** 降级与重试，Preset 与 Scene 的扩展已在此合并。 */
  failover: FailoverConfig;
  /** 上下文引擎配置，内置缺省 ← preset ← scene 已在此合并；缺省补成 standard。 */
  context: ContextConfig;
  /** 唤醒引擎配置，合并规则同 context；缺省补成 standard。 */
  wakeup: WakeupConfig;
  /** 工具调用方式，Preset 与 Scene 的扩展已在此合并；缺省 native。 */
  toolcall: ToolcallConfig;
  /** 幕后通道是否启用，Preset 与 Scene 的扩展已在此合并；缺省关闭。 */
  innerThoughts: boolean;
  /** 代码模式配置，Preset 与 Scene 的扩展已在此合并；缺省关闭。 */
  codemode: CodemodeConfig;
  /** 打字节奏，Preset 与 Scene 的扩展已在此合并。 */
  typing: TypingConfig;
}

/** 目录名安全化：生成由 sid 与 channelId 拼成的单段文件名时使用。 */
export function sceneDirectoryName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}

/** 这批模式是否覆盖指定频道：`*` 全部，尾随 `*` 按前缀（`group:*`），其余按精确值。 */
export function matchesChannel(patterns: readonly string[], channelId: string): boolean {
  return patterns.some((pattern) => pattern === "*" || (pattern.endsWith("*") ? channelId.startsWith(pattern.slice(0, -1)) : pattern === channelId));
}

/** 该份名单是否认领指定频道：白名单命中且未被黑名单排除。 */
export function claimsChannel(claim: ChannelClaim, channelId: string): boolean {
  return matchesChannel(claim.whitelist ?? [], channelId) && !matchesChannel(claim.blacklist ?? [], channelId);
}

/**
 * 名字里的扩展包前缀：`pkg/name` 的 `pkg`。内置变体（`standard` 这类）不走包机制，返回 undefined。
 * 前缀同时是准入的依据与归属——注册名即声明，不做第二处登记。
 */
export function packagePrefix(name: string): string | undefined {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(0, slash) : undefined;
}

/**
 * 名字是否被这份准入清单选中：内置变体恒可用；带包前缀的要求包在 `extends` 里。
 * 选中是配置的事（preset 写下的那行），包活着与否是生命周期的事（cordis 的 fiber），两处各管各的。
 */
export function isSelected(name: string, selected: readonly string[]): boolean {
  const pkg = packagePrefix(name);
  return pkg === undefined || selected.includes(pkg);
}

/**
 * 两个白名单能否命中同一频道：`*` 与一切重叠，尾随 `*` 撞同前缀的具体值（`group:*` 撞 `group:1`），
 * 两个不同前缀（`group:*` 与 `private:*`）则各不相干，其余按精确值。
 * 判定刻意取保守：只看白名单模式本身，不去证明黑名单能否把交集排空。冲突宁可多报一次，配置者换个模式即可；
 * 反过来漏报则要等到运行时静默错配。
 */
function listsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((pattern) =>
    right.some(
      (other) =>
        pattern === "*" ||
        other === "*" ||
        (pattern.endsWith("*") ? other.startsWith(pattern.slice(0, -1)) : other.endsWith("*") ? pattern.startsWith(other.slice(0, -1)) : pattern === other),
    ),
  );
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
const FALLBACK: Pick<SceneSpec, "failover" | "context" | "wakeup" | "toolcall" | "innerThoughts" | "codemode" | "typing" | "whitelist" | "blacklist"> = {
  failover: { backoffMs: 500, failoverOn: "unavailable" },
  context: { engine: "standard" },
  wakeup: { engine: "standard" },
  toolcall: { engine: "native" },
  innerThoughts: false,
  codemode: { enable: false, direct: [], timeoutMs: 30_000 },
  typing: { baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
  whitelist: [],
  blacklist: [],
};

/** 展开一份 profile 的结果：生效单位清单。引擎配置已随三层合并落进各 spec。 */
export interface ResolvedProfile {
  /** 各生效单位的装配清单。 */
  specs: SceneSpec[];
}

/**
 * 展开一个已解析的 Profile 树：逐 preset 走形态分支，产出各生效单位的 spec 与该 preset 的引擎配置。
 * 频道归属在这里一次性判定完——两个 spec 都可能认领同一频道时不再靠「先声明者接管」：
 * 那种让配置者猜归属的规则在树形结构下已无必要，直接报冲突。
 * 入参是 {@link ProfileConfig} 解析过的配置；原始 YAML 由装载方（`loadProfiles`）负责读取与解析。
 */
export function resolveProfile(profile: ProfileConfig, id: string): ResolvedProfile {
  const specs: SceneSpec[] = [];

  for (const [presetName, preset] of Object.entries(profile.presets)) {
    const scenes = preset.scenes ?? {};
    const sceneNames = Object.keys(scenes);
    // 形态开关与两处名单不是心智基线：不剥掉会随 preset 层并进每个 spec。
    // 引擎块随 baseline 进三层合并——实例按 spec 逐个诞生，配置没有理由留在别处。
    const { scenes: _scenes, claims: presetClaims, cross: _cross, extends: presetExtends, ...baseline } = preset;
    const selected = presetExtends ?? [];

    // 形态互斥与空心智是一组判断：认不出这个 preset 以什么形态生效，就没法装配。
    if (preset.cross === true) {
      if (sceneNames.length !== 0) throw new Error(`Cross preset "${presetName}" of profile "${id}" must not have scenes`);
      if (Object.keys(presetClaims ?? {}).length === 0) throw new Error(`Cross preset "${presetName}" of profile "${id}" needs "claims"`);
    } else if (sceneNames.length === 0) {
      throw new Error(`Preset "${presetName}" of profile "${id}" has no scenes and is not cross`);
    }

    for (const name of sceneNames) {
      const scene = scenes[name]!;
      const sid = scene.sid?.trim();
      if (!sid) throw new Error(`Scene "${presetName}/${name}" of profile "${id}" needs a "sid"`);
      // whitelist 的键被 Schema 刻意留成 absent，好把「显式空数组」与「忘了写」分开。
      if (scene.whitelist === undefined) throw new Error(`Scene "${presetName}/${name}" of profile "${id}" needs a "whitelist"`);

      // 名单与 sid 只用于定位与认领，不参与配置合并。
      const { sid: _sid, whitelist: _whitelist, blacklist: _blacklist, ...overrides } = scene;
      specs.push({
        // 三层：内置缺省 ← preset ← scene。model 由 PresetConfig 保证必填，先落进 base 定住结果类型。
        ...merge({ ...FALLBACK, model: baseline.model, description: baseline.description }, baseline, overrides),
        profile: id,
        name,
        preset: presetName,
        cross: false,
        extends: selected,
        sid,
        whitelist: scene.whitelist,
        blacklist: scene.blacklist ?? [],
      });
    }

    // cross 形态：preset 自身即生效单位，运行参数只有这一层，频道集合是各 sid claim 的并集。
    if (preset.cross === true) {
      const claims = presetClaims!;
      specs.push({
        // 只有两层：内置缺省 ← preset。scene 层在这里不存在，跨频道合流不认 per-channel 的扩写。
        ...merge({ ...FALLBACK, model: baseline.model, description: baseline.description }, baseline),
        profile: id,
        name: presetName,
        preset: presetName,
        cross: true,
        extends: selected,
        // 无单一账号：路由按 claims 逐 sid 判，sid 留空串表示此处不适用。
        sid: "",
        claims,
        whitelist: Object.values(claims).flatMap((claim) => claim.whitelist ?? []),
        blacklist: Object.values(claims).flatMap((claim) => claim.blacklist ?? []),
      });
    }
  }

  assertNoOverlap(specs, id);
  assertEngineAdmission(specs);
  return { specs };
}

/**
 * 引擎变体的准入校验：带包前缀的名字要求包在 extends 里，装载期报出。
 * 准入是 preset 的承诺，scene 覆写也不能越过它——「这个 preset 能用哪些变体」
 * 读 preset 一处就能回答，不必扫所有 scene。
 */
function assertEngineAdmission(specs: readonly SceneSpec[]): void {
  for (const spec of specs) {
    for (const [family, engine] of [
      ["context", spec.context],
      ["wakeup", spec.wakeup],
      ["toolcall", spec.toolcall],
    ] as const) {
      if (!isSelected(engine.engine, spec.extends)) {
        throw new Error(`${family} engine "${engine.engine}" of spec "${spec.name}" comes from an extension package not listed in "extends"`);
      }
    }
  }
}

/**
 * 某 spec 在指定账号下认领的频道：普通形态用自己的名单，cross 形态取该 sid 的 claim。
 * 名单不按 sid 拆进 spec 是刻意的——现状里 scene 恒定绑一个账号，路由先比 sid 再比名单；
 * cross 一个生效单位跨多个账号，拆开会让每处读名单的地方都得先判一次形态。
 */
function resolveClaim(spec: SceneSpec, sid: string): ChannelClaim {
  return (spec.cross ? spec.claims?.[sid] : spec) ?? {};
}

/** 该 spec 覆盖的账号：普通形态恒为它绑定的那个，cross 形态为 claims 的全部键。 */
function listSids(spec: SceneSpec): string[] {
  return spec.cross ? Object.keys(spec.claims ?? {}) : [spec.sid];
}

/**
 * 装载期的一次性冲突报出：同一 sid 下两个 spec 的白名单相交即冲突。
 * 只在共同覆盖的账号上比——不同账号的频道 id 空间互不相交，跨 sid 无从冲突。
 * 普通 scene 与 cross claim 走同一段判定：合流与独立都由这份名单说话，不另立规则。
 */
function assertNoOverlap(specs: readonly SceneSpec[], id: string): void {
  for (let left = 0; left < specs.length; left += 1) {
    for (let right = left + 1; right < specs.length; right += 1) {
      const first = specs[left]!;
      const second = specs[right]!;
      for (const sid of listSids(first).filter((account) => listSids(second).includes(account))) {
        if (listsOverlap(resolveClaim(first, sid).whitelist ?? [], resolveClaim(second, sid).whitelist ?? [])) {
          throw new Error(`Scene "${first.name}" and scene "${second.name}" of profile "${id}" both claim channels of "${sid}"`);
        }
      }
    }
  }
}

/** 按账号与频道匹配 spec：数组顺序即优先级，首条命中即归属；命中后由运行时按需创建对应的 AgentRuntime。 */
export function matchSceneSpec(specs: readonly SceneSpec[], target: { sid: string; channelId: string }): SceneSpec | undefined {
  return specs.find((spec) => listSids(spec).includes(target.sid) && claimsChannel(resolveClaim(spec, target.sid), target.channelId));
}
