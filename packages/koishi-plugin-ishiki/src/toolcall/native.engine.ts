import { ToolcallEngine, registerToolcallEngine } from "./engine.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    native: Record<never, never>;
  }
}

/** 模型原生 function call：不包任何中间件，工具目录走提供商自己的 tools 通道。 */
class NativeToolcallEngine extends ToolcallEngine<"native"> {
  constructor(config: Record<never, never>) {
    super("native", config);
  }

  protected middleware = (): undefined => undefined;
}

registerToolcallEngine("native", (config) => new NativeToolcallEngine(config));
