import type { AgentPlugin } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Service, type Context, type Logger } from "koishi";

import type { InstanceDomain } from "../domain.js";

/**
 * 上下文引擎：在装配与轮次边界介入事件流。
 *
 * 引擎分两层：provider 是 Koishi 服务，一个变体一个，名字即准入；instance 是运行体，
 * 一个 AgentRuntime 一份，配置与实例状态都留在它里面。provider 只做两件事：持有自己的
 * 插件级配置、按运行时配置造 instance，不携带任何运行状态。
 *
 * instance 不实现 `AgentPlugin`——它只声明自己干预上下文管线上的哪几段，由装配点
 * （`runtime.ts` 的 `createAgentPlugin`）收拢成 core 侧的唯一插件；运行态依赖（日志、足迹、
 * 跨场景前情）随装配传入，不写进配置。
 */

/** 上下文引擎参数表：键即 `context.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface ContextEngines {}

/** 变体对应的服务名。可用性只由这个名字对应的服务是否存在决定，不看名字里有没有包前缀。 */
export function contextEngineServiceName(name: string): string {
  return `ishiki.engine.context.${name}`;
}

/**
 * 上下文引擎的运行体：一个 AgentRuntime 一份。
 *
 * 钩子按需实现；未实现的段表示这一步不改。签名直接取自 core 的插件契约，装配器按同一份
 * 契约转发。与决策点有关的钩子（`onStepFinish` / `prepareStep` / `beforeToolCall` /
 * `toModelMessages`）不在这里——它们是内核独占的。
 */
export interface ContextEngineInstance {
  init?: AgentPlugin["init"];
  stop?: AgentPlugin["stop"];
  onAppend?: AgentPlugin["onAppend"];
  transformEntries?: AgentPlugin["transformEntries"];
  transformMessages?: AgentPlugin["transformMessages"];
  extendInstructions?: AgentPlugin["extendInstructions"];
  onTurnFinish?: AgentPlugin["onTurnFinish"];
}

/** 装配一个上下文引擎所需的运行态依赖：随 scene 而变，不来自配置。 */
export interface ContextEngineOptions {
  logger: Logger;
  gateway?: Gateway;
  /** 本 profile 的数据目录：需要自有文件的引擎（记忆块等）在这里读写。 */
  directory?: string;
  /** 包内 `resources/` 的绝对路径：需要模板的引擎在这里找。 */
  resources?: string;
  /**
   * 本实例的可见域。渲染事实行要它：聚合视窗一块吃下多个频道，不带坐标就分不清谁说的，于是每段
   * 带一个寻址头；单频道视窗行自带出处，不带头。缺省即按单频道视窗渲染。
   */
  domain?: InstanceDomain;
}

/**
 * 引擎 provider：Koishi 服务，一个变体一个，构造即登记。
 *
 * 服务名是唯一的事实来源——preset 依赖这个名字，取用也从这里取；插件级配置由子类自己持有，
 * 与 profile/scene 配置在 `create()` 处汇合，不做深合并。
 */
export abstract class ContextEngine<K extends keyof ContextEngines = keyof ContextEngines> extends Service {
  public constructor(ctx: Context, name: K) {
    super(ctx, contextEngineServiceName(String(name)));
  }

  /**
   * 造一个运行体。`config` 是 profile/scene 合并后该引擎名下的参数块，可能为空；
   * 默认值由引擎自己补，provider 的插件级配置与它互不覆盖。
   */
  public abstract create(config: Partial<ContextEngines[K]>, options: ContextEngineOptions): ContextEngineInstance;
}
