import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    qwen3coder: Record<never, never>;
  }
}

/** qwen3coder 协议：`<function=名字><parameter=参数名>值</parameter></function>` XML。 */
class Qwen3CoderToolcallEngine extends ToolcallEngine<"qwen3coder"> {
  constructor(config: Record<never, never>) {
    super("qwen3coder", config);
  }

  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsQwen3CoderXml, qwen3CoderProtocol, qwen3coderSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: qwen3CoderProtocol(),
      toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
    });
  };
}

registerToolcallEngine("qwen3coder", (config) => new Qwen3CoderToolcallEngine(config));
