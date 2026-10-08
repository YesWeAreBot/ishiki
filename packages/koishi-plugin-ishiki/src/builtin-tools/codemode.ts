import type { DIRECT_TOOL_CALL, experimental_codeModeTool } from "@ai-sdk/code-mode";
import type { Tool, ToolCallers, ToolSet } from "@yesimagent/core";

import type { CodemodeConfig } from "../profile/index.js";

const CODEMODE_PACKAGE = "@ai-sdk/code-mode";

interface CodemodeModule {
  experimental_codeModeTool: typeof experimental_codeModeTool;
  DIRECT_TOOL_CALL: typeof DIRECT_TOOL_CALL;
}

let loading: Promise<void> | undefined;
let loaded: CodemodeModule | undefined;

export function loadCodemode(): Promise<void> {
  loading ??= (import(CODEMODE_PACKAGE) as Promise<CodemodeModule>).then((module) => {
    loaded = module;
  });
  return loading;
}

function codemode(): CodemodeModule {
  if (loaded === undefined) throw new Error("Codemode module not loaded. Call loadCodemode() first.");
  return loaded;
}

export const CODE_MODE = "codemode";

const BOTH_REACHABLE: readonly string[] = ["send_message"];

const DIRECT_ONLY: readonly string[] = ["finish"];

export interface CodemodeSurface {
  tool: Tool;
  callers: ToolCallers;
}

/**
 * Build the code_mode sandbox tool and its caller routing.
 *
 * `conversation` mode (used with toolsearch): the provider-visible code tool
 * keeps a stable description and tool signatures arrive through the
 * toolsearch catalog messages instead of the SDK's per-step ephemeral
 * `prepareModelMessage` user message, which does not survive this agent's
 * per-step streamText loop.
 */
export function createCodemode(config: CodemodeConfig, tools: ToolSet, conversation: boolean): CodemodeSurface {
  const direct = new Set([...DIRECT_ONLY, ...config.direct]);
  const { DIRECT_TOOL_CALL, experimental_codeModeTool } = codemode();
  const callers: ToolCallers = {};
  for (const name of Object.keys(tools)) {
    if (BOTH_REACHABLE.includes(name)) callers[name] = [CODE_MODE, DIRECT_TOOL_CALL];
    else if (!direct.has(name)) callers[name] = [CODE_MODE];
  }
  const sandboxTool = experimental_codeModeTool({
    executionPolicy: { timeoutMs: config.timeoutMs },
    ...(conversation ? { toolDiscovery: "conversation" as const } : {}),
  });
  const caller = sandboxTool.experimental_toolCaller;
  if (caller === undefined) throw new Error("failed to create codemode tool caller");

  // Neutralize the SDK's ephemeral catalog message: in this agent every step
  // is a fresh streamText call, so the SDK-side dedup (compares only the last
  // user text) never matches and the catalog would be re-appended each step.
  // Persistent catalog delivery is owned by the toolsearch runtime instead.
  const exposedCaller = conversation && caller.type === "local" ? { ...caller, prepareModelMessage: () => null } : caller;

  const exposed: Record<string, unknown> = {};
  for (const key of Object.keys(sandboxTool)) exposed[key] = (sandboxTool as Record<string, unknown>)[key];
  exposed.experimental_toolCaller = exposedCaller;
  return { tool: exposed as Tool, callers };
}
