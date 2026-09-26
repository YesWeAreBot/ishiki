import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    hermes: Record<never, never>;
  }
}

/** hermes 协议：`<tool_call>` 标签里包一个 `{"name": …, "arguments": …}` JSON 对象。 */
class HermesToolcallEngine extends ToolcallEngine<"hermes"> {
  constructor(config: Record<never, never>) {
    super("hermes", config);
  }

  protected middleware = () => {
    const { createToolMiddleware, formatToolResponseAsHermes, hermesProtocol, hermesSystemPromptTemplate } = parser();
    return createToolMiddleware({
      protocol: hermesProtocol(),
      toolSystemPromptTemplate: hermesSystemPromptTemplate,
      toolResponsePromptTemplate: formatToolResponseAsHermes,
    });
  };
}

registerToolcallEngine("hermes", (config) => new HermesToolcallEngine(config));
