import type { DIRECT_TOOL_CALL, experimental_codeModeTool } from "@ai-sdk/code-mode";
import type { Tool, ToolCallers, ToolSet } from "@yesimagent/core";

import type { CodemodeConfig } from "../profile.js";

/**
 * 代码模式的装载点，与 {@link file://./parser.ts} 同一处境：`@ai-sdk/code-mode` 只导出 ESM，
 * 而本插件交给 koishi 的是 CJS 产物，打包器会把静态 import 降级成 `require`。
 * 所以说明符走变量：`import()` 原样保留，由运行时解析，装配期先 {@link loadCodemode} 一次。
 */
const CODEMODE_PACKAGE = "@ai-sdk/code-mode";

/** 本插件实际调用的入口：造沙箱工具的工厂，与收窄表里用到的直调标记。 */
interface CodemodeModule {
  experimental_codeModeTool: typeof experimental_codeModeTool;
  DIRECT_TOOL_CALL: typeof DIRECT_TOOL_CALL;
}

let loading: Promise<void> | undefined;
let loaded: CodemodeModule | undefined;

/** 装载代码模式库；重复调用共用同一次 import。 */
export function loadCodemode(): Promise<void> {
  loading ??= (import(CODEMODE_PACKAGE) as Promise<CodemodeModule>).then((module) => {
    loaded = module;
  });
  return loading;
}

/** 取已装载的代码模式库。没先 await {@link loadCodemode} 就是装配顺序错了，直接抛错而不静默降级。 */
function codemode(): CodemodeModule {
  if (loaded === undefined) throw new Error("@ai-sdk/code-mode 尚未装载：装配代码模式前需先 await loadCodemode()");
  return loaded;
}

/** 沙箱工具的名字：模型目录里剩下的那一个，收窄表也按它点名。 */
export const CODE_MODE = "code_mode";

/**
 * 模型目录与沙箱双可达的工具：发言两边都要能调（直调省一层程序，程序里也要能说话），
 * 而停轮判定只认模型直调的那次调用——嵌套调用的结果不落 step messages，程序里发了话也不结束轮次。
 * `finish` 不在此列：收尾是直调的专属动作，写进程序的收尾不该结束轮次，索性只留目录。
 */
const BOTH_REACHABLE: readonly string[] = ["send_message"];

/** 只留模型目录的工具：收尾是模型直调发起的动作，程序里够不着，也不该结束轮次。 */
const DIRECT_ONLY: readonly string[] = ["finish"];

/** 代码模式在工具面上的一次装配：多出来的那件工具，加上把宿主工具收窄的调用者表。 */
export interface CodemodeAssembly {
  /** 交给 agent 的沙箱工具。 */
  tool: Tool;
  /**
   * 哪些工具可以被谁调用：只进沙箱的写 `[code_mode]`，只留目录的不写。
   * SDK 的语义是「表里没点名的既留在目录也不进沙箱」，所以纯直调不必写进表。
   */
  callers: ToolCallers;
}

/**
 * 按配置装配代码模式。宿主工具不由这里交给它——那件工具由 SDK 在生成时绑定，
 * 这里只声明「谁能调谁」与造出沙箱本身。
 */
export function assembleCodemode(config: CodemodeConfig, tools: ToolSet): CodemodeAssembly {
  const direct = new Set([...DIRECT_ONLY, ...config.direct]);
  const callers: ToolCallers = {};
  for (const name of Object.keys(tools)) {
    if (BOTH_REACHABLE.includes(name)) callers[name] = [CODE_MODE, codemode().DIRECT_TOOL_CALL];
    else if (!direct.has(name)) callers[name] = [CODE_MODE];
  }
  // `experimental_toolCaller` 是 SDK 用 defineProperty 挂的非枚举属性，过不了 core createAgent 里
  // `{ ...config.tools }` 的展开（agent.ts 的注释也点名了这一点）。这里把它重建为可枚举，
  // 让 caller 定义活过任何浅拷贝；getToolCaller 与 SDK 的建表逻辑照常读取，行为不变。
  const sandboxTool = codemode().experimental_codeModeTool({ executionPolicy: { timeoutMs: config.timeoutMs } }) as Tool;
  const caller = (sandboxTool as { experimental_toolCaller?: unknown }).experimental_toolCaller;
  if (caller === undefined) throw new Error("@ai-sdk/code-mode 的沙箱工具没有携带 experimental_toolCaller，无法装配调用者表");
  const exposed: Record<string, unknown> = {};
  for (const key of Object.keys(sandboxTool)) exposed[key] = (sandboxTool as Record<string, unknown>)[key];
  exposed.experimental_toolCaller = caller;
  return { tool: exposed as Tool, callers };
}
