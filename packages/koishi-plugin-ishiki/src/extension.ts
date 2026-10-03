import type { Awaitable, ToolSet } from "@yesimagent/core";

import type { AgentRuntime } from "./runtime.js";

/**
 * cordis 的 `Context.get` 有一条 `get<K extends string & keyof this>(name: K): undefined | this[K]` 重载，
 * 名字是模板字面量类型时才会被选中，`Ishiki.getExtension()` 取 handler 因此不必写断言。
 * 增强只覆盖 `ishiki.ext.` 前缀，别的服务取用照旧。
 */
declare module "koishi" {
  interface Context {
    /** 扩展包服务：服务的值就是那个 handler 本身，存在即该包可用。 */
    [name: `ishiki.ext.${string}`]: ExtensionHandler | undefined;
  }
}

/**
 * 扩展包在一个 AgentRuntime 上贡献的东西：core 那两个加法钩子的子集。
 *
 * 名字、返回类型（`Awaitable`）、合成规则与调用方向都照抄 `AgentPlugin` 的同名钩子——包实现、内核调用，
 * 工具增量并入工具面并与内核工具或先装配的包撞名抛错，提示词增量按 `extends` 的顺序拼接。逐个 await 而不是
 * 并发取：顺序就是撞名的判定顺序。差别只在位置：内核不缓存结果，core 每轮第一步取一次，工具面与提示词
 * 因此每轮现算，跨轮稳定由包自己在闭包里保证。
 *
 * 其余钩子不在这里。`onStepFinish` / `prepareStep` / `beforeToolCall` / `toModelMessages` 是唯一决策式
 * 或改写式，放进来就是上一代按优先级抢拦截权的复辟；要那类变化就做成引擎变体。
 */
export interface Extension {
  /** 本实例这一轮的工具增量；缺席表示这一轮不加。 */
  extendTools?(): Awaitable<ToolSet | void>;
  /** 本实例这一轮的提示词增量，接在内核那一段之后；缺席表示这一轮不加。 */
  extendInstructions?(): Awaitable<string | void>;
  /** 这次挂载的拆卸函数，实例停止时逆序执行。工具与提示词不撤销——它们每轮从钩子现取。 */
  dispose?(): Awaitable<void>;
}

/**
 * 扩展包的挂载函数，由 `ctx.ishiki.provide(name, handler)` 登记。
 *
 * 内核在 `AgentRuntime` 构造期间、`createAgent` 之前对每个实例叫一次，同步。实例已初始化基础字段、
 * 尚未创建 `Agent`：坐标在 `ctx` / `domain` / `home` / `root` 上。这个实例用不上这个包就返回 `undefined`。
 *
 * 返回值是这次挂载的 {@link Extension}，它那两件加法每轮被取用，出错（含撞名）因此发生在轮次里。
 * 包若在返回之前打开了外部资源，失败路径的清理由包自己负责：内核只拆已经拿到 Extension 的那几次挂载。
 */
export type ExtensionHandler = (profileConfig: unknown, runtime: AgentRuntime) => Extension | undefined;
