import type { Agent, AgentEntry, AgentMessage } from "@yesimagent/core";
import { Awaitable, Service, type Context } from "koishi";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";

export interface ContextEngines {}

export interface ContextEngineInstance {
  attach?: (agent: Agent) => () => void;
  prepareEntries?: (entries: readonly AgentEntry[], request: ContextRequest) => Awaitable<readonly AgentEntry[]>;
  renderMessages?: (messages: AgentMessage[], request: ContextRequest) => Awaitable<AgentMessage[]>;
  instructions?: () => Awaitable<string | undefined>;
}

export interface ContextRequest {
  readonly turnId: string;
  readonly signal: AbortSignal;
}

declare module "koishi" {
  interface Context {
    [name: `ishiki.engine.context.${string}`]: (ContextEngine & ContextEngine[typeof Service.invoke]) | undefined;
  }
}

export abstract class ContextEngine<K extends keyof ContextEngines = keyof ContextEngines> extends Service {
  static GetName(name: string): `ishiki.engine.context.${string}` {
    return `ishiki.engine.context.${name}`;
  }

  static GetService(ctx: Context, name: string): ContextEngine & ContextEngine[typeof Service.invoke] {
    const service = ContextEngine.GetName(name);
    const provider = ctx.get(service);
    if (provider === undefined) throw new Error(`engine service "${service}" is not available`);
    return provider;
  }

  public constructor(ctx: Context, name: K) {
    super(ctx, ContextEngine.GetName(String(name)));
  }

  public abstract [Service.invoke](config: EngineConfig<Pick<ContextEngines, K>>, context: ExtensionContext): ContextEngineInstance;
}
