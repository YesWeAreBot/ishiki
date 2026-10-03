import type { AgentPlugin } from "@yesimagent/core";

import type { InstanceDomain } from "./domain.js";

/**
 * cordis 的 `Context.get` 有一条 `get<K extends string & keyof this>(name: K): undefined | this[K]` 重载，
 * 名字是模板字面量类型时才会被选中，`Ishiki.getExtension()` 取工厂因此不必写断言。
 * 增强只覆盖 `ishiki.ext.` 前缀，别的服务取用照旧。
 */
declare module "koishi" {
  interface Context {
    /** 扩展包服务：服务的值就是那个工厂本身，存在即该包可用。 */
    [name: `ishiki.ext.${string}`]: RuntimePluginFactory | undefined;
  }
}

/**
 * 扩展包在一个实例上挂载时能看到的坐标。
 *
 * 只有内核才知道的坐标在这里。调用方那条插件 fiber 上的东西（`ctx`、logger、自己取的 Koishi 服务）
 * 不在其中：`agent.use()` 拿不到调用方的 ctx，放进坐标只会诱使包在钩子里现取，而钩子的调用时刻
 * 可能晚于注册插件的 dispose。包在构造期取好闭包进来——`workspace` 取 `ctx.ishiki.dataPath` 是范例。
 */
export interface RuntimeScope {
  /** 本 profile 的 `extends.<包名>.config` 原样；字段含义与默认值由包自己解释。 */
  readonly config: unknown;
  /** 本实例的可见域：单频道视窗给出那个频道，聚合视窗给出认领的账号与各自名单。 */
  readonly domain: InstanceDomain;
  /** 本实例的数据目录，`events.jsonl` 在里面。 */
  readonly home: string;
  /** 所属 profile 的目录：`profile.yaml` 与 profile 级配置（如 `mcp.json`）从它定位。 */
  readonly root: string;
}

/**
 * 扩展包交回的运行体插件：上游 `AgentPlugin` 的子集，只留组合语义明确的那几件。
 *
 * 名字、返回类型（`Awaitable`）与合成规则都照抄 `AgentPlugin` 的同名钩子——包实现、内核调用，
 * 工具增量并入工具面并与内核工具或先装配的包撞名抛错，提示词增量按 `extends` 的顺序拼接，
 * `stop` 在实例停止时逆序执行。逐个 await 而不是并发取：顺序就是撞名的判定顺序。差别只在位置：
 * 内核不缓存结果，core 每轮第一步取一次，工具面与提示词因此每轮现算，跨轮稳定由包自己在闭包里保证。
 *
 * `name` 与上游同名，约定写成 `ishiki.<包名>`；内核不为它建注册表也不校验撞名，留着是为了这组钩子
 * 将来与上游插件链合流时不必再补一层包装。
 *
 * 其余钩子不在这里。`onStepFinish` / `prepareStep` / `beforeToolCall` / `toModelMessages` 是唯一决策式
 * 或改写式，多个包同时动同一个环节时没有通用合并规则，放进来就是按优先级抢拦截权的复辟；
 * 要那类变化就做成引擎变体。返回对象上出现名单之外的键，装配期当即抛错，不静默忽略。
 */
export type RuntimePlugin = Pick<AgentPlugin, "name" | "extendTools" | "extendInstructions" | "stop">;

/**
 * 扩展包的挂载函数，由 `ctx.ishiki.agent.use(name, factory)` 登记。
 *
 * 内核在 `AgentRuntime` 构造期间、`createAgent` 之前对每个实例叫一次，同步；坐标见
 * {@link RuntimeScope}。这个实例用不上这个包就返回 `undefined`。
 *
 * 返回值是这次挂载的 {@link RuntimePlugin}，它那两件加法每轮被取用，出错（含撞名）因此发生在轮次里。
 * 包若在返回之前打开了外部资源，失败路径的清理由包自己负责：内核只拆已经拿到 RuntimePlugin 的那几次挂载。
 */
export type RuntimePluginFactory = (scope: RuntimeScope) => RuntimePlugin | undefined;
