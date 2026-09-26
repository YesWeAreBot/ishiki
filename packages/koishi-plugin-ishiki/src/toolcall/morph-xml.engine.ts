import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "morph-xml": Record<never, never>;
  }
}

/** morph-xml 协议：工具调用写成 XML 元素。 */
class MorphXmlToolcallEngine extends ToolcallEngine<"morph-xml"> {
  constructor(config: Record<never, never>) {
    super("morph-xml", config);
  }

  protected middleware = () => {
    const { createToolMiddleware, morphFormatToolResponseAsXml, morphXmlProtocol, morphXmlSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: morphXmlProtocol(),
      toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
      toolResponsePromptTemplate: morphFormatToolResponseAsXml,
    });
  };
}

registerToolcallEngine("morph-xml", (config) => new MorphXmlToolcallEngine(config));
