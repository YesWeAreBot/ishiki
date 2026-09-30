import { Service, type Context } from "koishi";

import type { AgentRuntime } from "./runtime.js";

/** 扩展包对应的服务名；与引擎族同一写法，可用性只由这个名字对应的服务是否存在决定。 */
export function extensionServiceName(name: string): string {
  return `ishiki.ext.${name}`;
}

/** 拆卸函数：可以不返回，也可以返回一个 promise。 */
export type Disposer = () => void | Promise<void>;

/**
 * 扩展包的挂载函数，由 `ctx.ishiki.provide(name, handler)` 登记。
 *
 * 内核在 `AgentRuntime` 构造期间、`createAgent` 之前对每个实例叫一次，同步。实例已初始化基础字段、
 * 尚未创建 `Agent`：加法只能经 `addTools` / `addInstructions`，坐标在 `ctx` / `domain` / `directory` 上。
 * 这个实例用不上这个包，就什么都不调。
 *
 * 返回值是这次挂载的拆卸函数，实例停止时逆序执行。工具与提示词本身不撤销——它们随实例一起消失，
 * 工具面在实例生命周期内固定，逐项回删没有使用者。
 * 包若在返回拆卸函数之前打开了外部资源，失败路径的清理由包自己负责：内核只拆已经拿到拆卸函数的那几次挂载。
 */
export type ExtensionHandler = (presetConfig: unknown, runtime: AgentRuntime) => void | Disposer;

/**
 * 扩展包在服务上挂的东西：一个 handler。仅此而已。
 *
 * 服务本身是扩展可用性的唯一事实来源：`ishiki.ext.<包名>` 在，依赖它的 preset 才激活。
 * 生命周期归调用方——`ctx.ishiki.provide()` 建的这条 fiber 挂在调用方那条上，
 * 因此 `ctx.on("dispose", disposer)` 是归属声明，不是可选的卫生习惯。
 * 不从包入口导出：扩展作者拿到的是 `provide()` 返回的注册 disposer 与这里的 handler 签名。
 */
export class ExtensionService extends Service {
  constructor(
    ctx: Context,
    name: string,
    public readonly handler: ExtensionHandler,
  ) {
    super(ctx, extensionServiceName(name));
  }
}
