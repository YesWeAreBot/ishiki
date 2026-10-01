import type { Agent, AgentEntry, AgentMessage, ToolSet } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Service, type Context, type Logger } from "koishi";

import type { InstanceDomain } from "../domain.js";

/**
 * 上下文引擎：管一件事——这次请求的上下文长什么样。
 *
 * 引擎分两层：provider 是 Koishi 服务，一个变体一个，名字即准入；instance 是运行体，
 * 一个 AgentRuntime 一份，配置与实例状态都留在它里面。provider 只做两件事：持有自己的
 * 插件级配置、按运行时配置造 instance，不携带任何运行状态。
 *
 * instance 拥有自己的方法名，不实现 core 的插件契约：`transformEntries` / `transformMessages`
 * 这类名字属于 core 的接线端，由装配点（`runtime.ts` 的 `createAgentPlugin`）转发过来。
 * core 的 `AgentPlugin` 类型只在 `runtime.ts` 出现过一次，引擎这一侧看得见的是 core 的具体数据类型
 * （`AgentEntry` / `AgentMessage` / `Agent`），不是它的钩子形状。
 *
 * 实例拿到的是 core 的插件契约允许的一切，止于此：core 在 entries 之前就调 `extendInstructions()`，
 * 所以 {@link ContextEngineInstance.instructions} 拿不到本轮的 entries；`prepareStep` 之后只给
 * `ModelMessage`，跨步上下文无处可取。真正原子的「指令 + 消息 + 工具」一次成型需要 core 加钩子，
 * 本阶段不做，也不伪装成已经做到。
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
 * 方法按需实现；未实现的那一步表示不改，原样放行。名字是引擎自己的，装配器按同一份接口转发。
 * 与决策点有关的事（`onStepFinish` / `prepareStep` / `beforeToolCall` / `afterToolCall`）不在这里——
 * 它们是内核独占的，引擎管上下文，不管 Agent 的循环决策。
 *
 * 加工有先后两步，是因为 core 的数据流本身就是两段：可见条目先裁剪，再组织成消息。
 * `prepareEntries` 拿到事件流里的 `AgentEntry[]`，`renderMessages` 拿到组织好的 `AgentMessage[]`；
 * 往后 core 才把它们转成 `ModelMessage[]`。这不是两个插件，是同一份上下文的两段加工。
 */
export interface ContextEngineInstance {
  /**
   * 挂载到 agent 上：core 建好 agent 之后调它一次，返回拆卸函数，agent 停止时再调一次。
   *
   * 这是引擎拿到运行资源的唯一入口（storage、模型都从 agent 上取），也是它自己订阅事件的时机——
   * 订阅退订不用另外操心，拆卸函数里一并做掉。不用 `init` + `stop` 两个钩子的原因就在这儿：
   * 挂了东西就得能一次拆干净，两个钩子拆不出这个配对。
   */
  attach?: (agent: Agent) => () => void;
  /** 事件流改写：裁窗口、提摘要、分段。拿不到就原样放行。 */
  prepareEntries?: (entries: readonly AgentEntry[], request: ContextRequest) => readonly AgentEntry[] | Promise<readonly AgentEntry[]>;
  /** 消息行渲染：把条目变成模型真正读到的那几行。拿不到就原样放行。 */
  renderMessages?: (messages: readonly AgentMessage[], request: ContextRequest) => AgentMessage[] | Promise<AgentMessage[]>;
  /**
   * 实例级上下文提示词：追加在内核拼好的那一段之后。
   * 拿不到本轮 entries——core 在流裁剪之前就问一次，所以这段只能是与轮次无关的常驻内容。
   */
  instructions?: () => string | undefined | Promise<string | undefined>;
}

/**
 * 本次请求引擎能看到的东西：就这两样。
 *
 * 没有 stepNumber：core 的 `transformEntries` / `transformMessages` 收的是 `TurnOptions`，
 * 步号在更靠后的 `prepareStep` 才出现，那里只有 `ModelMessage`。要步号就得改 core，本阶段不改，
 * 于是不占这个位——留一个恒为 undefined 的字段比没有它更糟。
 */
export interface ContextRequest {
  readonly turnId: string;
  readonly signal: AbortSignal;
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
  /**
   * 本实例最终的工具面：内核工具与扩展包的加法都在内。
   *
   * 引擎拿它是为了让自己的上下文模型与模型实际看到的那份对上——比如 Classic 要按工具清单决定
   * 指令里写什么。实例造在扩展挂载之后就是为了这个：早一步拿到的是半份工具面，比没有更坏。
   * 它是只读的上下文依据，不是工具管理权：引擎不能换它、不能执行它、不能改它。
   * 代码模式收窄发生在之后，所以这份清单比模型最终拿到的目录多一件沙箱工具。
   */
  tools: ToolSet;
  /**
   * 本实例最终的系统提示词：内核那一段、聚合形态的地址簿、扩展包的那几段，接在一起。
   * 与 {@link ContextEngineInstance.instructions} 追加的那一段是同一份文本的两个方向——
   * 这里给的是它要接在后面的东西，不是给整个引擎的指令。
   */
  instructions: string;
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
