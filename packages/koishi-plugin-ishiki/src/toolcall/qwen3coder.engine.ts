import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    qwen3coder: Record<never, never>;
  }
}

export class Qwen3CoderToolcallInstance extends ToolcallEngineInstance {
  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsQwen3CoderXml, qwen3CoderProtocol, qwen3coderSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: qwen3CoderProtocol(),
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
    });
  };
}

export class Qwen3CoderToolcallEngine extends ToolcallEngine<"qwen3coder"> {
  constructor(ctx: Context) {
    super(ctx, "qwen3coder");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "qwen3coder">>): ToolcallEngineInstance {
    return new Qwen3CoderToolcallInstance();
  }
}
