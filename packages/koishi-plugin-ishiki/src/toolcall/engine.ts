import type { LanguageModelV4, LanguageModelV4Middleware } from "@yesimagent/core";
import { wrapLanguageModel } from "@yesimagent/core";
import { Service, type Context } from "koishi";
import Schema from "schemastery";

import type { EngineConfig } from "../profile/index.js";
import { listServices, registerService } from "../registry.js";

export interface ToolcallEngines {}

export abstract class ToolcallEngineInstance {
  protected abstract middleware(): LanguageModelV4Middleware | undefined;

  wrap(model: LanguageModelV4): LanguageModelV4 {
    const middleware = this.middleware();
    if (middleware === undefined) return model;
    return wrapLanguageModel({ model, middleware });
  }
}

declare module "koishi" {
  interface Context {
    [name: `ishiki.engine.toolcall.${string}`]: (ToolcallEngine & ToolcallEngine[typeof Service.invoke]) | undefined;
  }
}

export abstract class ToolcallEngine<K extends keyof ToolcallEngines = keyof ToolcallEngines> extends Service {
  static GetName(name: string): `ishiki.engine.toolcall.${string}` {
    return `ishiki.engine.toolcall.${name}`;
  }

  static GetService(ctx: Context, name: string): ToolcallEngine & ToolcallEngine[typeof Service.invoke] {
    const service = ToolcallEngine.GetName(name);
    const provider = ctx.get(service);
    if (provider === undefined) throw new Error(`engine service "${service}" is not available`);
    return provider;
  }

  static list(ctx: Context): ToolcallEngine[] {
    return listServices<ToolcallEngine>(ctx, "toolcall");
  }

  public Schema?: Schema<any>;

  public constructor(ctx: Context, name: K) {
    super(ctx, ToolcallEngine.GetName(String(name)));
    registerService(ctx, "toolcall", String(name), this);
  }

  public abstract [Service.invoke](config: EngineConfig<Pick<ToolcallEngines, K>>): ToolcallEngineInstance;
}
