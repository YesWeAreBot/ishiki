import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "morph-xml": Record<never, never>;
  }
}

/** morph-xml 协议：工具调用写成 XML 元素。 */
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

/** morph-xml 的 provider：没有插件级配置，只把 profile/scene 的参数交给运行体。 */
export class MorphXmlToolcallEngine extends ToolcallEngine<"morph-xml"> {
  constructor(ctx: Context) {
    super(ctx, "morph-xml");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "morph-xml">>): ToolcallEngineInstance {
    return new MorphXmlToolcallInstance();
  }
}
