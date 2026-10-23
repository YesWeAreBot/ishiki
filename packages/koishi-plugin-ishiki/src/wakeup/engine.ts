import type { Agent } from "@yesimagent/core";
import { h, Service, type Context } from "koishi";
import Schema from "schemastery";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import { listServices, registerService } from "../registry.js";

export interface WakeupEngines {}

export interface WakeupEngineInstance {
  /**
   * Observe committed inputs and schedule wakes. Check agent.isIdle() before scheduling
   * and again after a delay or async decision. Dispose subscriptions and pending work on stop.
   */
  attach(agent: Agent): () => void;
}

export function atSelf(content: string, selfId: string): boolean {
  if (!content.includes("<at")) return false;
  try {
    return h.parse(content).some((element) => element.type === "at" && element.attrs?.id === selfId);
  } catch {
    return false;
  }
}

declare module "koishi" {
  interface Context {
    [name: `ishiki.engine.wakeup.${string}`]: (WakeupEngine & WakeupEngine[typeof Service.invoke]) | undefined;
  }
}

export abstract class WakeupEngine<K extends keyof WakeupEngines = keyof WakeupEngines> extends Service {
  static GetName(name: string): `ishiki.engine.wakeup.${string}` {
    return `ishiki.engine.wakeup.${name}`;
  }

  static GetService(ctx: Context, name: string): WakeupEngine & WakeupEngine[typeof Service.invoke] {
    const service = WakeupEngine.GetName(name);
    const provider = ctx.get(service);
    if (provider === undefined) throw new Error(`engine service "${service}" is not available`);
    return provider;
  }

  static list(ctx: Context): WakeupEngine[] {
    return listServices<WakeupEngine>(ctx, "wakeup");
  }

  public Schema?: Schema<any>;

  public constructor(ctx: Context, name: K) {
    super(ctx, WakeupEngine.GetName(String(name)));
    registerService(ctx, "wakeup", String(name), this);
  }

  public abstract [Service.invoke](config: EngineConfig<Pick<WakeupEngines, K>>, context: ExtensionContext): WakeupEngineInstance;
}
