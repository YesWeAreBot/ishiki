import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";

declare module "./engine.js" {
  interface ToolcallEngines {
    native: Record<never, never>;
  }
}

export class NativeToolcallInstance extends ToolcallEngineInstance {
  protected middleware = (): undefined => undefined;
}

export class NativeToolcallEngine extends ToolcallEngine<"native"> {
  constructor(ctx: Context) {
    super(ctx, "native");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "native">>): ToolcallEngineInstance {
    return new NativeToolcallInstance();
  }
}
