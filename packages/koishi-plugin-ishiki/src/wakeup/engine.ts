import type { IshikiEvent } from "../types.js";

/**
 * 唤醒引擎：判断一条事件要不要唤起一轮。
 *
 * 一个引擎 = 一个唤醒策略 + 它的参数。不是 `AgentPlugin`：它不参与 turn 内的钩子，
 * 而是由调用点在收到事件时主动问一次（`decide`），与 `ToolcallEngine` 同类。
 */

/** 唤醒引擎参数表：键即 `wakeup.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface WakeupEngines {}

/** 一条事件要不要唤起一轮；`wait` 表示继续等。 */
export type WakeupDecision = "trigger" | "wait";

export abstract class WakeupEngine<K extends keyof WakeupEngines = keyof WakeupEngines> {
  public readonly name: K;
  public readonly config: WakeupEngines[K];

  constructor(name: K, config: WakeupEngines[K]) {
    this.name = name;
    this.config = config;
  }

  abstract decide(event: IshikiEvent): WakeupDecision;
}

/** 运行期注册表：各引擎的配置类型不同，登记时收窄、取用时按名收敛。 */
const wakeupEngines: Record<string, (config: never) => WakeupEngine> = {};

/** 登记一个引擎；重名抛错，配置错误在装载时立刻暴露。 */
export function registerWakeupEngine<K extends keyof WakeupEngines>(name: K, create: (config: WakeupEngines[K]) => WakeupEngine<K>): void {
  if (name in wakeupEngines) throw new Error(`wakeup engine "${String(name)}" already registered`);
  wakeupEngines[name] = create;
}

/** 按配置建出引擎：参数取与引擎名同名的那个键，未写则空。未登记的名字抛错，不静默退化。 */
export function createWakeupEngine(config: { engine: string; [k: string]: unknown }): WakeupEngine {
  const create = wakeupEngines[config.engine];
  if (create === undefined) {
    throw new Error(`unknown wakeup engine "${config.engine}", available: ${Object.keys(wakeupEngines).join(", ")}`);
  }
  return create((config[config.engine] ?? {}) as never);
}
