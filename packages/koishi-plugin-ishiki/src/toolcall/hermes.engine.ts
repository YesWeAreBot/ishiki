import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    hermes: Record<never, never>;
  }
}

/** hermes 协议：`<tool_call>` 标签里包一个 `{"name": …, "arguments": …}` JSON 对象。 */
export class HermesToolcallInstance extends ToolcallEngineInstance {
  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsHermes, hermesProtocol, hermesSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: hermesProtocol(),
      toolSystemPromptTemplate: hermesSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsHermes,
    });
  };
}

/** hermes 的 provider：没有插件级配置，只把 profile/scene 的参数交给运行体。 */
export class HermesToolcallEngine extends ToolcallEngine<"hermes"> {
  constructor(ctx: Context) {
    super(ctx, "hermes");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "hermes">>): ToolcallEngineInstance {
    return new HermesToolcallInstance();
  }
}
