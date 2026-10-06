import type { Agent } from "@yesimagent/core";
import { h, Service, type Context } from "koishi";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import type { IshikiEvent } from "../types.js";

export interface WakeupEngines {}

export type WakeupDecision = "trigger" | "wait";

export interface WakeupEngineInstance {
  attach?(agent: Agent): () => void;
  decide(event: IshikiEvent): WakeupDecision | Promise<WakeupDecision>;
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

  public constructor(ctx: Context, name: K) {
    super(ctx, WakeupEngine.GetName(String(name)));
  }

  public abstract [Service.invoke](config: EngineConfig<Pick<WakeupEngines, K>>, context: ExtensionContext): WakeupEngineInstance;
}
