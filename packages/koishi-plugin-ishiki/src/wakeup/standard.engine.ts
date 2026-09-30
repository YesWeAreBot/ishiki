import type { Context } from "koishi";

import type { IshikiEvent } from "../types.js";
import { atSelf, WakeupEngine, type WakeupDecision, type WakeupEngineInstance } from "./engine.js";

const DEFAULT_WAKEUP: StandardWakeupConfig = { direct: true, atSelf: true, quoteSelf: true, keywords: [] };

export interface StandardWakeupConfig {
  direct: boolean;
  atSelf: boolean;
  quoteSelf: boolean;
  keywords: string[];
}

/**
 * 规则判定：私聊看 `isDirect`，群聊看引用、关键词与 @；命中任一即触发一轮。
 */
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

/** standard 的 provider：没有插件级配置，只把 profile/scene 合出来的参数交给运行体。 */
export class StandardWakeupEngine extends WakeupEngine<"standard"> {
  constructor(ctx: Context) {
    super(ctx, "standard");
  }

  create(config: Partial<StandardWakeupConfig>): WakeupEngineInstance {
    return new StandardWakeupInstance(config);
  }
}
