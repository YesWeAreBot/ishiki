import { h } from "koishi";

import type { IshikiEvent, IshikiMessageCreated } from "../types.js";
import { WakeupEngine, registerWakeupEngine, type WakeupDecision } from "./engine.js";

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
export class StandardWakeupEngine extends WakeupEngine<"standard"> {
  constructor(config: Partial<StandardWakeupConfig> = {}) {
    super("standard", { ...DEFAULT_WAKEUP, ...config });
  }

  decide(event: IshikiEvent): WakeupDecision {
    if (event.type !== "ishiki.message.created") return "wait";

    const message = event.data;
    if (this.config.direct && message.isDirect) return "trigger";
    if (this.config.quoteSelf && message.quote?.user?.id === message.selfId) return "trigger";
    if (this.config.keywords.some((keyword) => keyword.length > 0 && message.content.includes(keyword))) return "trigger";
    return this.config.atSelf && this.atSelf(message) ? "trigger" : "wait";
  }

  private atSelf(message: IshikiMessageCreated): boolean {
    if (!message.content.includes("<at")) return false;
    try {
      return h.parse(message.content).some((element) => element.type === "at" && element.attrs?.id === message.selfId);
    } catch {
      return false;
    }
  }
}

declare module "./engine.js" {
  interface WakeupEngines {
    standard: StandardWakeupConfig;
  }
}

registerWakeupEngine("standard", (config) => new StandardWakeupEngine(config));
