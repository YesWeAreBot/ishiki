import type { ToolSet } from "@yesimagent/core";
import type { Context } from "koishi";

import type { InstanceDomain } from "./domain.js";

/**
 * 扩展包：一个 Koishi 插件，以 `ishiki.ext.<包名>` 提供服务，由 preset 的 `extends` 选中。
 *
 * 一个包对内核只有两件事可说：给自己的引擎变体建一个 provider 服务（见各 `engine.ts` 的 provider 基类），
 * 以及对一个 AgentRuntime 做加法（本文件）。两件事互不依赖，包可以只做其中一件。
 */

/** 一个 AgentRuntime 诞生时，内核交给扩展包的实例级常量。 */
export interface ExtensionCoords {
  /**
   * 平台能力与其它 Koishi 服务的入口，例如 `ctx.bots`、`ctx.http`。
   * 内核不另造一层能力面：插件是 Koishi 插件，手上本来就有 ctx；缺的只有实例坐标。
   */
  ctx: Context;
  /** 这个实例的可见域。 */
  domain: InstanceDomain;
  /** 本实例的数据目录；包自己的文件放在自己的子目录里，随实例生灭。 */
  directory: string;
}

/**
 * 扩展包对某一个实例做的加法。只有加，没有决策。
 *
 * 上下文管线的改写段（`onAppend` / `transformEntries` / `transformMessages`）与唯一的收尾、
 * 停轮判定都不在这里：前者同一条线上只能有一个引擎，后者没有共同正确的合成语义，
 * 社区面一拿到就是 `priority` 抢权的复辟（03 号文被否定前提 4）。
 *
 * 包的成员写成 `extend(coords: ExtensionCoords): Extension | undefined`，
 * 返回 `undefined` 表示这个实例用不上它（每频道的过滤归包自己）。
 */
export interface Extension {
  /** 并入本实例的工具面；与内核工具或先装配的包撞名在装配点抛错。 */
  tools?: ToolSet;
  /** 追加到本实例系统提示词的最后一段。 */
  instructions?: string;
}

/** 扩展包在服务上暴露的成员：内核在装配点对每个实例叫一次。缺这个成员表示这个包只提供引擎变体。 */
export type ExtensionProvider = (coords: ExtensionCoords) => Extension | undefined;
