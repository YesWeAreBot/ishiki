import type { Agent } from "@yesimagent/core";
import { h, type Logger } from "koishi";

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

/**
 * 建引擎时宿主递进来的东西：引擎拿不到 `Context`，只拿这一小包。
 * 需要发请求的引擎（如 `jev`）要一个日志出口，否则失败只能无声降级。
 */
export interface WakeupEngineDeps {
  logger?: Logger;
}

export abstract class WakeupEngine<K extends keyof WakeupEngines = keyof WakeupEngines> {
  public readonly name: K;
  public readonly config: WakeupEngines[K];

  constructor(name: K, config: WakeupEngines[K]) {
    this.name = name;
    this.config = config;
  }

  /**
   * 判定要同步给结果还是要等一次往返，由引擎自己定：`await` 对同步实现只是一个微任务。
   * 调用点必须 `await` —— `Promise` 恒不等于 `"trigger"`。
   */
  abstract decide(event: IshikiEvent): WakeupDecision | Promise<WakeupDecision>;

  /**
   * 场景的 agent 建好后挂上来。引擎要「这个场景发生了什么、我自己说过什么」，只能从这里拿：
   * 订阅 `agent.channel` 看事实流，读 `agent.storage` 补上进程启动之前的历史。
   *
   * 一个引擎实例按 spec 共享，可能被多个频道的 agent 先后挂上来，`agent.channel` 的事件里又
   * 不带频道，所以频道由调用方在挂载时给出，引擎按它各自记账。
   */
  attach?(agent: Agent, channelId: string): void;

  /** 场景停止时解开这一轮的挂载：取消订阅、丢掉这个频道的记账。不实现即没有要拆的东西。 */
  detach?(channelId: string): void;
}

/** 内容里是否 @ 了指定身份。`<at>` 不是合法消息内容时按「没有」处理。 */
export function atSelf(content: string, selfId: string): boolean {
  if (!content.includes("<at")) return false;
  try {
    return h.parse(content).some((element) => element.type === "at" && element.attrs?.id === selfId);
  } catch {
    return false;
  }
}

/** 运行期注册表：各引擎的配置类型不同，登记时收窄、取用时按名收敛。 */
const wakeupEngines: Record<string, (config: never, deps: WakeupEngineDeps) => WakeupEngine> = {};

/** 登记一个引擎；重名抛错，配置错误在装载时立刻暴露。 */
export function registerWakeupEngine<K extends keyof WakeupEngines>(
  name: K,
  create: (config: WakeupEngines[K], deps: WakeupEngineDeps) => WakeupEngine<K>,
): void {
  if (name in wakeupEngines) throw new Error(`wakeup engine "${String(name)}" already registered`);
  wakeupEngines[name] = create;
}

/** 按配置建出引擎：参数取与引擎名同名的那个键，未写则空。未登记的名字抛错，不静默退化。 */
export function createWakeupEngine(config: { engine: string; [k: string]: unknown }, deps: WakeupEngineDeps = {}): WakeupEngine {
  const create = wakeupEngines[config.engine];
  if (create === undefined) {
    throw new Error(`unknown wakeup engine "${config.engine}", available: ${Object.keys(wakeupEngines).join(", ")}`);
  }
  return create((config[config.engine] ?? {}) as never, deps);
}
