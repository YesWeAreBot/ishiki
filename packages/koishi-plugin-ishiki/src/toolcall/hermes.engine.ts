import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    hermes: Record<never, never>;
  }
}

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

export class HermesToolcallEngine extends ToolcallEngine<"hermes"> {
  constructor(ctx: Context) {
    super(ctx, "hermes");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "hermes">>): ToolcallEngineInstance {
    return new HermesToolcallInstance();
  }
}
