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

export const CODE_MODE = "code_mode";

const BOTH_REACHABLE: readonly string[] = ["send_message"];

const DIRECT_ONLY: readonly string[] = ["finish"];

export interface CodemodeSurface {
  tool: Tool;
  callers: ToolCallers;
}

export function createCodemode(config: CodemodeConfig, tools: ToolSet): CodemodeSurface {
  const direct = new Set([...DIRECT_ONLY, ...config.direct]);
  const { DIRECT_TOOL_CALL, experimental_codeModeTool } = codemode();
  const callers: ToolCallers = {};
  for (const name of Object.keys(tools)) {
    if (BOTH_REACHABLE.includes(name)) callers[name] = [CODE_MODE, DIRECT_TOOL_CALL];
    else if (!direct.has(name)) callers[name] = [CODE_MODE];
  }
  const sandboxTool = experimental_codeModeTool({ executionPolicy: { timeoutMs: config.timeoutMs } });
  const caller = sandboxTool.experimental_toolCaller;
  if (caller === undefined) throw new Error("failed to create codemode tool caller");
  const exposed: Record<string, unknown> = {};
  for (const key of Object.keys(sandboxTool)) exposed[key] = (sandboxTool as Record<string, unknown>)[key];
  exposed.experimental_toolCaller = caller;
  return { tool: exposed as Tool, callers };
}
