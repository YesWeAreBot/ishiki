import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    "yaml-xml": Record<never, never>;
  }
}

/** yaml-xml 协议：工具调用写成 XML 元素，参数体是 YAML。 */
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

/** yaml-xml 的 provider：没有插件级配置，只把 profile/scene 的参数交给运行体。 */
export class YamlXmlToolcallEngine extends ToolcallEngine<"yaml-xml"> {
  constructor(ctx: Context) {
    super(ctx, "yaml-xml");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "yaml-xml">>): ToolcallEngineInstance {
    return new YamlXmlToolcallInstance();
  }
}
