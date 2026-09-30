import type { Context } from "koishi";

import { ToolcallEngine, ToolcallEngineInstance } from "./engine.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    native: Record<never, never>;
  }
}

/** 模型原生 function call：不包任何中间件，工具目录走提供商自己的 tools 通道。 */
export class NativeToolcallInstance extends ToolcallEngineInstance {
  protected middleware = (): undefined => undefined;
}

/** native 的 provider：没有插件级配置，只把 profile/scene 的参数交给运行体。 */
export class NativeToolcallEngine extends ToolcallEngine<"native"> {
  constructor(ctx: Context) {
    super(ctx, "native");
  }

  create(): ToolcallEngineInstance {
    return new NativeToolcallInstance();
  }
}
