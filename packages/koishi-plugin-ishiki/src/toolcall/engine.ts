/**
 * JSON OUTPUT 工具调用引擎：把模型的纯文本输出转换成标准 tool-call 流。
 *
 * 解析与协议由 `@ai-sdk-tool/parser` 承担：hermes / qwen3coder / morph-xml / yaml-xml
 * 等协议各有渲染好的系统提示词、响应解析与历史回写，`createToolMiddleware` 负责
 * 请求改写（撤原生 tools、注入协议提示词、tool-call / tool-result 回写为文本）与
 * 流包装（解析出标准 tool-call 片段）。本模块只做两件事：
 * - 协议注册表：`toolcall.json.protocol` 按名取中间件工厂；
 * - thoughts 协议：ishiki 自有的「每步固定幕后流」格式，注册成库的 `TCMProtocol`。
 */
import {
  createToolMiddleware,
  hermesProtocol,
  hermesSystemPromptTemplate,
  formatToolResponseAsHermes,
  morphXmlProtocol,
  morphXmlSystemPromptTemplate,
  morphFormatToolResponseAsXml,
  qwen3CoderProtocol,
  qwen3coderSystemPromptTemplate,
  formatToolResponseAsQwen3CoderXml,
  yamlXmlProtocol,
  yamlXmlSystemPromptTemplate,
  formatToolResponseAsYaml,
  type TCMProtocol,
} from "@ai-sdk-tool/parser";
import type { LanguageModelV4, LanguageModelV4Middleware } from "@yesimagent/core";
import { wrapLanguageModel } from "@yesimagent/core";
import type { Logger } from "koishi";

import { thoughtsProtocol, thoughtsSystemPromptTemplate, thoughtsToolResponse } from "./thoughts.js";

/** 一个输出协议的装配描述：协议实现 + 提示词模板 + 工具结果模板。 */
export interface ToolcallProtocol {
  readonly name: string;
  /** 中间件工厂；协议内部状态按次调用独立，每轮装配取新实例。 */
  create(): LanguageModelV4Middleware;
}

/** 协议注册表：键即 `toolcall.json.protocol` 的取值。 */
export const toolcallProtocols: Record<string, ToolcallProtocol> = {};

/** 登记一个协议；重名抛错，配置错误在装载时立刻暴露。 */
export function registerToolcallProtocol(protocol: ToolcallProtocol): void {
  if (protocol.name in toolcallProtocols) throw new Error(`toolcall protocol "${protocol.name}" already registered`);
  toolcallProtocols[protocol.name] = protocol;
}

/** 库协议的通用包装：`createToolMiddleware` 接管请求改写与流解析的全部骨架。 */
function libraryProtocol(
  name: string,
  options: {
    protocol: TCMProtocol | (() => TCMProtocol);
    prompt: (tools: Parameters<Parameters<typeof createToolMiddleware>[0]["toolSystemPromptTemplate"]>[0]) => string;
    response?: Parameters<typeof createToolMiddleware>[0]["toolResponsePromptTemplate"];
  },
): ToolcallProtocol {
  return {
    name,
    create: () =>
      createToolMiddleware({
        protocol: options.protocol,
        toolSystemPromptTemplate: options.prompt,
        toolResponsePromptTemplate: options.response,
      }),
  };
}

registerToolcallProtocol(libraryProtocol("hermes", { protocol: hermesProtocol(), prompt: hermesSystemPromptTemplate, response: formatToolResponseAsHermes }));
registerToolcallProtocol(
  libraryProtocol("qwen3coder", { protocol: qwen3CoderProtocol(), prompt: qwen3coderSystemPromptTemplate, response: formatToolResponseAsQwen3CoderXml }),
);
registerToolcallProtocol(
  libraryProtocol("morph-xml", { protocol: morphXmlProtocol(), prompt: morphXmlSystemPromptTemplate, response: morphFormatToolResponseAsXml }),
);
registerToolcallProtocol(libraryProtocol("yaml-xml", { protocol: yamlXmlProtocol(), prompt: yamlXmlSystemPromptTemplate, response: formatToolResponseAsYaml }));
registerToolcallProtocol(libraryProtocol("thoughts", { protocol: thoughtsProtocol(), prompt: thoughtsSystemPromptTemplate, response: thoughtsToolResponse }));

/**
 * JSON 引擎装配：按协议名取中间件，包住底层模型。
 * `tools` 是该实例被引擎接管后的工具集，仅在装配期用于日志；实际工具目录
 * 由库的 `transformParams` 从请求参数里取并经 `providerOptions` 传给响应侧。
 */
export function createJsonToolcallModel(options: { model: LanguageModelV4; protocol: string; logger: Logger }): LanguageModelV4 {
  const protocol = toolcallProtocols[options.protocol];
  if (protocol === undefined) {
    throw new Error(`unknown toolcall protocol "${options.protocol}", available: ${Object.keys(toolcallProtocols).join(", ")}`);
  }
  options.logger.debug(`toolcall: json engine enabled, protocol=${protocol.name}`);
  return wrapLanguageModel({ model: options.model, middleware: protocol.create() });
}
