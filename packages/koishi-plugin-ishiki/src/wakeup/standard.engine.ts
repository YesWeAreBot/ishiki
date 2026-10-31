import type { Agent } from "@yesimagent/core";
import { Service, type Context } from "koishi";
import Schema from "schemastery";

import type { ExtensionHost } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import type { IshikiMessageCreated } from "../types/messages.js";
import { atSelf, WakeupEngine, type WakeupEngineInstance, type WakeupEngines } from "./engine.js";

const DEFAULT_WAKEUP: StandardWakeupConfig = { direct: true, atSelf: true, quoteSelf: true, keywords: [] };

export interface StandardWakeupConfig {
  direct: boolean;
  atSelf: boolean;
  quoteSelf: boolean;
  keywords: string[];
}

export const StandardWakeupConfig = Schema.object({
  direct: Schema.boolean().default(true).description("私聊消息直接唤醒"),
  atSelf: Schema.boolean().default(true).description("提及机器人时唤醒"),
  quoteSelf: Schema.boolean().default(true).description("引用机器人消息时唤醒"),
  keywords: Schema.array(Schema.string()).default([]).description("包含任一关键词时唤醒"),
});

export class StandardWakeupInstance implements WakeupEngineInstance {
  public readonly config: StandardWakeupConfig;

  constructor(config: Partial<StandardWakeupConfig> = {}) {
    this.config = { ...DEFAULT_WAKEUP, ...config };
  }

  attach(agent: Agent): () => void {
    return agent.channel.subscribe("agent", (event) => {
      if (event.type !== "message.appended") return;
      const message = event.message;
      if (message.role !== "custom" || message.type !== "ishiki.message.created") return;
      if (agent.isIdle() && this.matches(message.data)) agent.continue();
    });
  }

  matches(message: IshikiMessageCreated): boolean {
    if (this.config.direct && message.isDirect) return true;
    if (this.config.quoteSelf && message.quote?.user?.id === message.selfId) return true;
    if (this.config.keywords.some((keyword) => keyword.length > 0 && message.content.includes(keyword))) return true;
    return this.config.atSelf && atSelf(message.content, message.selfId);
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    standard: StandardWakeupConfig;
  }
}

export class StandardWakeupEngine extends WakeupEngine<"standard"> {
  public readonly Schema = StandardWakeupConfig;

  constructor(ctx: Context) {
    super(ctx, "standard");
  }

  public [Service.invoke](_host: ExtensionHost, config: EngineConfig<Pick<WakeupEngines, "standard">>): WakeupEngineInstance {
    return new StandardWakeupInstance(config.standard ?? {});
  }
}
