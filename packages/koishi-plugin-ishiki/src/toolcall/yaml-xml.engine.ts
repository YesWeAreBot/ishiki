import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "yaml-xml": Record<never, never>;
  }
}

export class YamlXmlToolcallInstance extends ToolcallEngineInstance {
  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsYaml, yamlXmlProtocol, yamlXmlSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: yamlXmlProtocol(),
      toolSystemPromptTemplate: yamlXmlSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsYaml,
    });
  };
}

export class YamlXmlToolcallEngine extends ToolcallEngine<"yaml-xml"> {
  constructor(ctx: Context) {
    super(ctx, "yaml-xml");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "yaml-xml">>): ToolcallEngineInstance {
    return new YamlXmlToolcallInstance();
  }
}
