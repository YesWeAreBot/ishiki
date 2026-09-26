import type { AgentPlugin } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Logger } from "koishi";

/**
 * 上下文引擎：在装配与轮次边界介入事件流。
 *
 * 一个引擎 = 一个上下文策略 + 它的参数。引擎本身实现 `AgentPlugin`，把 hook 挂在实例上交给
 * core；运行态依赖（日志、足迹、跨场景前情）随 scene 传入，不写进配置。
 */

/** 上下文引擎参数表：键即 `context.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface ContextEngines {}

export abstract class ContextEngine<K extends keyof ContextEngines = keyof ContextEngines> implements AgentPlugin {
  public readonly name: K;
  public readonly config: ContextEngines[K];

  constructor(name: K, config: ContextEngines[K]) {
    this.name = name;
    this.config = config;
  }
}

/** 装配一个上下文引擎所需的运行态依赖：随 scene 而变，不来自配置。 */
export interface ContextEngineOptions {
  logger: Logger;
  gateway?: Gateway;
  /** 本 profile 的数据目录：需要自有文件的引擎（记忆块等）在这里读写。 */
  directory?: string;
  /** 包内 `resources/` 的绝对路径：需要模板的引擎在这里找。 */
  resources?: string;
}

/** 运行期注册表：各引擎的配置类型不同，登记时收窄、取用时按名收敛。 */
const contextEngines: Record<string, (config: never, options: ContextEngineOptions) => ContextEngine> = {};

/** 登记一个引擎；重名抛错，配置错误在装载时立刻暴露。 */
export function registerContextEngine<K extends keyof ContextEngines>(
  name: K,
  create: (config: ContextEngines[K], options: ContextEngineOptions) => ContextEngine<K>,
): void {
  if (name in contextEngines) throw new Error(`context engine "${String(name)}" already registered`);
  contextEngines[name] = create;
}

/** 按配置建出引擎：参数取与引擎名同名的那个键，未写则空。未登记的名字抛错，不静默退化。 */
export function createContextEngine(config: { engine: string; [k: string]: unknown }, options: ContextEngineOptions): ContextEngine {
  const create = contextEngines[config.engine];
  if (create === undefined) {
    throw new Error(`unknown context engine "${config.engine}", available: ${Object.keys(contextEngines).join(", ")}`);
  }
  return create((config[config.engine] ?? {}) as never, options);
}
