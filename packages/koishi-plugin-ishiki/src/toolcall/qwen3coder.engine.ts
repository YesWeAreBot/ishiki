import type { Context } from "koishi";

import { ToolcallEngine, ToolcallEngineInstance } from "./engine.js";
import { parser } from "./parser.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    qwen3coder: Record<never, never>;
  }
}

/** qwen3coder 协议：`<function=名字><parameter=参数名>值</parameter></function>` XML。 */
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

/** qwen3coder 的 provider：没有插件级配置，只把 profile/scene 的参数交给运行体。 */
export class Qwen3CoderToolcallEngine extends ToolcallEngine<"qwen3coder"> {
  constructor(ctx: Context) {
    super(ctx, "qwen3coder");
  }

  create(): ToolcallEngineInstance {
    return new Qwen3CoderToolcallInstance();
  }
}
