import type { DIRECT_TOOL_CALL, experimental_codeModeTool } from "@ai-sdk/code-mode";
import type { Tool, ToolCallers, ToolSet } from "@yesimagent/core";

import type { CodemodeConfig } from "../profile/index.js";

const CODEMODE_PACKAGE = "@ai-sdk/code-mode";

/** Minimal structural type of the package's CodeModeToolError constructor. */
interface HostToolErrorCtor {
  new (message: string, details?: unknown): Error;
}

interface CodemodeModule {
  experimental_codeModeTool: typeof experimental_codeModeTool;
  CodeModeToolError: HostToolErrorCtor;
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

export const CODEMODE_TOOL = "codemode";

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
  const { DIRECT_TOOL_CALL, experimental_codeModeTool, CodeModeToolError } = codemode();
  const callers: ToolCallers = {};
  for (const name of Object.keys(tools)) {
    if (BOTH_REACHABLE.includes(name)) callers[name] = [CODEMODE_TOOL, DIRECT_TOOL_CALL];
    else if (!direct.has(name)) callers[name] = [CODEMODE_TOOL];
  }
  const sandboxTool = experimental_codeModeTool({
    executionPolicy: { timeoutMs: config.timeoutMs },
    ...(conversation ? { toolDiscovery: "conversation" as const } : {}),
  });
  const caller = sandboxTool.experimental_toolCaller;
  if (caller === undefined) throw new Error("failed to create codemode tool caller");

  // Host tool failures would otherwise surface to the model as the opaque
  // "RunError: Host tool failed." — code-mode replaces any non-CodeModeError
  // throw with that placeholder. Wrapping the bind-time host set so every
  // failure is rethrown as a real CodeModeToolError (the package preserves
  // those instances verbatim, message and details included) keeps the
  // original error text visible to the model.
  const bindWithDiagnostics = (host: ToolSet): ToolSet => {
    const wrapped: ToolSet = {};
    for (const [name, tool] of Object.entries(host)) wrapped[name] = preserveHostToolError(name, tool, CodeModeToolError);
    return wrapped;
  };

  // Neutralize the SDK's ephemeral catalog message: in this agent every step
  // is a fresh streamText call, so the SDK-side dedup (compares only the last
  // user text) never matches and the catalog would be re-appended each step.
  // Persistent catalog delivery is owned by the toolsearch runtime instead.
  const exposedCaller =
    caller.type === "local"
      ? {
          ...caller,
          bind: (host: ToolSet) => caller.bind(bindWithDiagnostics(host)),
          ...(conversation ? { prepareModelMessage: () => null } : {}),
        }
      : caller;

  const exposed: Record<string, unknown> = {};
  for (const key of Object.keys(sandboxTool)) exposed[key] = (sandboxTool as Record<string, unknown>)[key];
  exposed.experimental_toolCaller = exposedCaller;
  return { tool: exposed as Tool, callers };
}

function preserveHostToolError(name: string, tool: Tool, HostToolError: HostToolErrorCtor): Tool {
  const execute = tool.execute;
  if (execute === undefined) return tool;
  const wrapped = async (input: unknown, options: unknown) => {
    try {
      return await (execute as (input: unknown, options: unknown) => unknown).call(tool, input, options);
    } catch (error) {
      // Aborts must keep travelling as aborts.
      if (error instanceof Error && error.name === "AbortError") throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new HostToolError(`Tool "${name}" failed: ${detail}`, { toolName: name, cause: detail });
    }
  };
  return { ...tool, execute: wrapped as Tool["execute"] };
}
