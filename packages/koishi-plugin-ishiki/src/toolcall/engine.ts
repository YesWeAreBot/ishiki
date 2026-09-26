/**
 * 工具调用引擎：把模型的纯文本输出转换成标准 tool-call 流。
 *
 * 一个引擎 = 一个输出协议 + 它的参数。协议的三件事由引擎持有：
 * - 怎么写：`toolSystemPromptTemplate` 渲染输出契约，`protocol.formatTools` 附上工具目录；
 * - 怎么读回：`protocol.parseGeneratedText` / `protocol.createStreamParser`；
 * - 历史回写：`protocol.formatToolCall` + `toolResponsePromptTemplate`。
 *
 * 这些由 `@ai-sdk-tool/parser` 的 `createToolMiddleware` 组装成中间件，引擎只决定
 * 「用哪个协议」与「把中间件接到哪个模型上」。契约与工具目录由中间件在每步请求改写时
 * 注入 system（`placement` 取库默认的 `last`），引擎不向调用方交出文本，避免两处注入。
 *
 * 引擎不进 `AgentPlugin` 体系：它作用于装配期的模型值，不参与 turn 内的钩子，
 * 与 `WakeupEngine` 同类，由调用点在装配时取用一次。
 */
import type { LanguageModel, LanguageModelV4, LanguageModelV4Middleware } from "@yesimagent/core";
import { wrapLanguageModel } from "@yesimagent/core";

/** 协议参数表：键即 `toolcall.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface ToolcallEngines {}

/** 模型是否带 v4 规格；网关没解析出 v4 provider 时模型是别的形态，中间件对它不适用。 */
function isV4(model: LanguageModel): model is LanguageModelV4 {
  return typeof model === "object" && model.specificationVersion === "v4";
}

export abstract class ToolcallEngine<K extends keyof ToolcallEngines = keyof ToolcallEngines> {
  public readonly name: K;
  public readonly config: ToolcallEngines[K];

  constructor(name: K, config: ToolcallEngines[K]) {
    this.name = name;
    this.config = config;
  }

  /** 本引擎的中间件；`undefined` 表示不接管模型（native）。 */
  protected abstract middleware(): LanguageModelV4Middleware | undefined;

  /** 包装模型：接上请求改写、提示词注入与流解析。不接管的模型原样返回。 */
  wrap(model: LanguageModel): LanguageModel {
    const middleware = this.middleware();
    if (middleware === undefined || !isV4(model)) return model;
    return wrapLanguageModel({ model, middleware });
  }
}

/** 运行期注册表：各引擎的配置类型不同，登记时收窄、取用时按名收敛。 */
const toolcallEngines: Record<string, (config: never) => ToolcallEngine> = {};

/** 登记一个引擎；重名抛错，配置错误在装载时立刻暴露。 */
export function registerToolcallEngine<K extends keyof ToolcallEngines>(name: K, create: (config: ToolcallEngines[K]) => ToolcallEngine<K>): void {
  if (name in toolcallEngines) throw new Error(`toolcall engine "${String(name)}" already registered`);
  toolcallEngines[name] = create;
}

/** 按配置建出引擎：参数取与引擎名同名的那个键，未写则空。未登记的名字抛错，不静默退化。 */
export function createToolcallEngine(config: { engine: string; [k: string]: unknown }): ToolcallEngine {
  const create = toolcallEngines[config.engine];
  if (create === undefined) {
    throw new Error(`unknown toolcall engine "${config.engine}", available: ${Object.keys(toolcallEngines).join(", ")}`);
  }
  return create((config[config.engine] ?? {}) as never);
}
