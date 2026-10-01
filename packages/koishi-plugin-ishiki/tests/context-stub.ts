import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentPlugin } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";

import type { ContextEngineInstance, ContextEngineOptions } from "../src/context/engine.js";

const RESOURCES = fileURLToPath(new URL("../resources", import.meta.url));

/** 一个读不到的目录：多数用例不需要记忆块，读不到就是空。 */
const NOWHERE = path.join(tmpdir(), "ishiki-tests-absent");

/**
 * 上下文引擎的装配选项，只留 logger 是真的。
 *
 * 目录、资源路径、可见域这些用例都不关心，但字段是必填的——给一份最省事的真值，
 * 而不是把类型放宽成可选，那会让真正需要它们的引擎少一道编译期检查。
 * `gateway` 目前没有任何内置引擎读它，这里同样只占个位。
 */
export function contextOptions(logger: ContextEngineOptions["logger"]): ContextEngineOptions {
  return {
    logger,
    gateway: {} as Gateway,
    directory: NOWHERE,
    resources: RESOURCES,
    domain: { form: "channel", platform: "onebot", selfId: "1", channelId: "group:1" },
  };
}

/** 删掉一项必填字段的 options：给「装配前提」那类用例用，引擎自己得看见缺口。 */
export function contextOptionsMissing(logger: ContextEngineOptions["logger"], missing: "directory" | "resources"): ContextEngineOptions {
  const options: Record<string, unknown> = { ...contextOptions(logger) };
  delete options[missing];
  return options as unknown as ContextEngineOptions;
}

/**
 * 把一个上下文引擎接到 core 的 agent 上，只接上下文这一条线。
 *
 * core 的接线端在 src 里是内联构造、不导出的，测试要直接驱动 core（预置事件流、
 * 自己拿模型）就得自己接。这不是复制生产代码：停轮判定与日志都不在这里，
 * 只有引擎那三个钩子与一段 instructions。
 */
export function contextPlugin(context: ContextEngineInstance): AgentPlugin {
  let detach: (() => void) | undefined;
  return {
    name: "context-stub",
    init: (agent) => {
      detach = context.attach?.(agent);
    },
    stop: () => {
      detach?.();
      detach = undefined;
    },
    transformEntries: (entries, options) => context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries,
    transformMessages: (messages, options) => context.renderMessages?.(messages, { turnId: options.turnId, signal: options.signal }) ?? messages,
    extendInstructions: () => context.instructions?.(),
  };
}
