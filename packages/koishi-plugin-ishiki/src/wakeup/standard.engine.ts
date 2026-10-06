import { Service, type Context } from "koishi";

import type { ExtensionContext } from "../extension.js";
import type { EngineConfig } from "../profile/index.js";
import type { IshikiEvent } from "../types.js";
import { atSelf, WakeupEngine, type WakeupDecision, type WakeupEngineInstance, type WakeupEngines } from "./engine.js";

const DEFAULT_WAKEUP: StandardWakeupConfig = { direct: true, atSelf: true, quoteSelf: true, keywords: [] };

export interface StandardWakeupConfig {
  direct: boolean;
  atSelf: boolean;
  quoteSelf: boolean;
  keywords: string[];
}

export class StandardWakeupInstance implements WakeupEngineInstance {
  public readonly config: StandardWakeupConfig;

  constructor(config: Partial<StandardWakeupConfig> = {}) {
    this.config = { ...DEFAULT_WAKEUP, ...config };
  }

  decide(event: IshikiEvent): WakeupDecision {
    if (event.type !== "ishiki.message.created") return "wait";

    const message = event.data;
    if (this.config.direct && message.isDirect) return "trigger";
    if (this.config.quoteSelf && message.quote?.user?.id === message.selfId) return "trigger";
    if (this.config.keywords.some((keyword) => keyword.length > 0 && message.content.includes(keyword))) return "trigger";
    return this.config.atSelf && atSelf(message.content, message.selfId) ? "trigger" : "wait";
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    standard: StandardWakeupConfig;
  }
}

export class StandardWakeupEngine extends WakeupEngine<"standard"> {
  constructor(ctx: Context) {
    super(ctx, "standard");
  }

  public [Service.invoke](config: EngineConfig<Pick<WakeupEngines, "standard">>, _context: ExtensionContext): WakeupEngineInstance {
    return new StandardWakeupInstance(config.standard ?? {});
  }
}
