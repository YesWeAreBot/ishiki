/**
 * 工具调用引擎：把模型的纯文本输出转换成标准 tool-call 流。
 *
 * 一个引擎 = 一个输出协议 + 它的参数。协议的三件事由运行体持有：
 * - 怎么写：`toolSystemPromptTemplate` 渲染输出契约，`protocol.formatTools` 附上工具目录；
 * - 怎么读回：`protocol.parseGeneratedText` / `protocol.createStreamParser`；
 * - 历史回写：`protocol.formatToolCall` + `toolResponsePromptTemplate`。
 *
 * 这些由 `@ai-sdk-tool/parser` 的 `createToolMiddleware` 组装成中间件，引擎只决定
 * 「用哪个协议」与「把中间件接到哪个模型上」。契约与工具目录由中间件在每步请求改写时
 * 注入 system（`placement` 取库默认的 `last`），引擎不向调用方交出文本，避免两处注入。
 *
 * 引擎分两层：provider 是 Koishi 服务，一个变体一个，名字即准入，只持有插件级配置；
 * instance 是运行体，一个 AgentRuntime 一份，装配时包一次模型。引擎不进 `AgentPlugin` 体系：
 * 它作用于装配期的模型值，不参与 turn 内的钩子。
 */
import type { LanguageModel, LanguageModelV4, LanguageModelV4Middleware } from "@yesimagent/core";
import { wrapLanguageModel } from "@yesimagent/core";
import { Service, type Context } from "koishi";

/** 协议参数表：键即 `toolcall.<engine>` 的参数键。各引擎文件用 `declare module` 增强它。 */
export interface ToolcallEngines {}

/** 变体对应的服务名。可用性只由这个名字对应的服务是否存在决定，不看名字里有没有包前缀。 */
export function toolcallEngineServiceName(name: string): string {
  return `ishiki.engine.toolcall.${name}`;
}

/** 模型是否带 v4 规格；网关没解析出 v4 provider 时模型是别的形态，中间件对它不适用。 */
function isV4(model: LanguageModel): model is LanguageModelV4 {
  return typeof model === "object" && model.specificationVersion === "v4";
}

/** 工具调用引擎的运行体：一个 AgentRuntime 一份，装配时用一次。 */
export abstract class ToolcallEngineInstance {
  /** 本引擎的中间件；`undefined` 表示不接管模型（native）。 */
  protected abstract middleware(): LanguageModelV4Middleware | undefined;

  /** 包装模型：接上请求改写、提示词注入与流解析。不接管的模型原样返回。 */
  wrap(model: LanguageModel): LanguageModel {
    const middleware = this.middleware();
    if (middleware === undefined || !isV4(model)) return model;
    return wrapLanguageModel({ model, middleware });
  }
}

/**
 * 引擎 provider：Koishi 服务，一个变体一个，构造即登记。
 *
 * 插件级配置由子类自己持有，profile/scene 配置从 `create()` 进——两层各管各的，不做深合并。
 */
export abstract class ToolcallEngine<K extends keyof ToolcallEngines = keyof ToolcallEngines> extends Service {
  public constructor(ctx: Context, name: K) {
    super(ctx, toolcallEngineServiceName(String(name)));
  }

  /** 造一个运行体。`config` 是 profile/scene 合并后该引擎名下的参数块，可能为空，默认值由引擎自己补。 */
  public abstract create(config: Partial<ToolcallEngines[K]>): ToolcallEngineInstance;
}
