import type { Agent } from "@yesimagent/core";
import { h, Service, type Context, type Logger } from "koishi";

import type { IshikiEvent } from "../types.js";

/**
 * 唤醒引擎：判断一条事件要不要唤起一轮。
 *
 * 引擎分两层：provider 是 Koishi 服务，一个变体一个，名字即准入；instance 是运行体，
 * 一个 AgentRuntime 一份，账本与实例同生共死。provider 只持有插件级配置并按
 * profile/scene 配置造 instance，不携带任何运行状态。
 *
 * instance 不是 `AgentPlugin`：它不参与 turn 内的钩子，而是由调用点在收到事件时主动问一次
 * （`decide`），与 `ToolcallEngine` 同类。
 */

/** 唤醒引擎参数表：键即 `wakeup.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface WakeupEngines {}

/** 一条事件要不要唤起一轮；`wait` 表示继续等。 */
export type WakeupDecision = "trigger" | "wait";

/** 变体对应的服务名。可用性只由这个名字对应的服务是否存在决定，不看名字里有没有包前缀。 */
export function wakeupEngineServiceName(name: string): string {
  return `ishiki.engine.wakeup.${name}`;
}

/**
 * 建运行体时宿主递进来的东西：引擎拿不到 `Context`，只拿这一小包。
 * 需要发请求的引擎（如 `jev`）要一个日志出口，否则失败只能无声降级。
 */
export interface WakeupEngineDeps {
  logger?: Logger;
}

/** 唤醒引擎的运行体：一个 AgentRuntime 一份，账本只记本视窗的事实流。 */
export interface WakeupEngineInstance {
  /**
   * 场景的 agent 建好后挂上来。引擎要「这个场景发生了什么、我自己说过什么」，只能从这里拿：
   * 订阅 `agent.channel` 看事实流，读 `agent.storage` 补上进程启动之前的历史。
   *
   * 不收记账键：账归谁由事实流自己说明——每条消息都带自己的频道号，一次挂载就是一个视窗，
   * 视窗内见过哪些频道，引擎从事件里读，跨频道聚合与单频道因此走同一份代码。
   *
   * 返回拆卸函数：调用点在场景停止时调它，取消订阅并丢掉这次挂载攒下的账。
   * 引擎实例随 agent 诞生，只挂载这一个 agent：账本与实例同生共死，状态留在实例内。
   */
  attach?(agent: Agent): () => void;
  /**
   * 判定要同步给结果还是要等一次往返，由引擎自己定：`await` 对同步实现只是一个微任务。
   * 调用点必须 `await` —— `Promise` 恒不等于 `"trigger"`。
   */
  decide(event: IshikiEvent): WakeupDecision | Promise<WakeupDecision>;
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

/**
 * 引擎 provider：Koishi 服务，一个变体一个，构造即登记。
 *
 * 插件级配置由子类自己持有，profile/scene 配置从 `create()` 进——两层各管各的，不做深合并。
 */
export abstract class WakeupEngine<K extends keyof WakeupEngines = keyof WakeupEngines> extends Service {
  public constructor(ctx: Context, name: K) {
    super(ctx, wakeupEngineServiceName(String(name)));
  }

  /** 造一个运行体。`config` 是 profile/scene 合并后该引擎名下的参数块，可能为空，默认值由引擎自己补。 */
  public abstract create(config: Partial<WakeupEngines[K]>, deps: WakeupEngineDeps): WakeupEngineInstance;
}
