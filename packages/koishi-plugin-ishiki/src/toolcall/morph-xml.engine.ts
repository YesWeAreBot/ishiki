import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "morph-xml": Record<never, never>;
  }
}

export class MorphXmlToolcallInstance extends ToolcallEngineInstance {
  protected middleware = () => {
    const { createToolMiddleware, morphFormatToolResponseAsXml, morphXmlProtocol, morphXmlSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: morphXmlProtocol(),
      toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
      toolResponsePromptTemplate: morphFormatToolResponseAsXml,
    });
  };
}

export class MorphXmlToolcallEngine extends ToolcallEngine<"morph-xml"> {
  constructor(ctx: Context) {
    super(ctx, "morph-xml");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "morph-xml">>): ToolcallEngineInstance {
    return new MorphXmlToolcallInstance();
  }
}
