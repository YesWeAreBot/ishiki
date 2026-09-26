import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "yaml-xml": Record<never, never>;
  }
}

/** yaml-xml 协议：工具调用写成 XML 元素，参数体是 YAML。 */
class YamlXmlToolcallEngine extends ToolcallEngine<"yaml-xml"> {
  constructor(config: Record<never, never>) {
    super("yaml-xml", config);
  }

  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsYaml, yamlXmlProtocol, yamlXmlSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: yamlXmlProtocol(),
      toolSystemPromptTemplate: yamlXmlSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsYaml,
    });
  };
}

registerToolcallEngine("yaml-xml", (config) => new YamlXmlToolcallEngine(config));
