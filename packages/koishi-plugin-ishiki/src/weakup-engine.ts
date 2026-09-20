import { AgentCustomMessage, createCustomMessage } from "@yesimagent/core";
import { Context, h } from "koishi";

import type { Focus, Profile } from "./profiles.js";
import {} from "./types.js";
import type { IshikiEvent, IshikiMessageCreated } from "./types.js";

type Notification = AgentCustomMessage["ishiki.notification"];

/**
 * One question, one answer: does this event start a turn? The judgement reads the event, the live focus and the
 * profile's attention policy, and writes nothing. It also owns the retelling — an event that cannot wake the
 * mind where it stands is offered back as one that can.
 */
export class WeakUpEngine {
  constructor(private readonly options: { ctx: Context; profile: Profile; currentFocus: () => Focus }) {}

  handleEvent(event: IshikiEvent): boolean {
    if (!this.atFocus(event)) return false;
    // A notification exists to interrupt, so it never has to argue for itself.
    if (event.type === "ishiki.notification") return true;
    return this.attentionReason(event) !== undefined;
  }

  /**
   * The retelling. Only facts that address the mind are worth moving, and only while they sit somewhere else.
   * What comes back is a new event addressed to the focus, so the judgement above accepts it on its own terms.
   */
  escalate(event: IshikiEvent): Notification[] {
    if (this.atFocus(event)) return [];
    const reason = this.attentionReason(event);
    if (reason === undefined) return [];

    const focus = this.options.currentFocus();
    const body = this.options.ctx.bots[focus.sid];
    if (!body) return [];

    // The retelling stands where the mind stands and carries the address of what it retells.
    return [
      createCustomMessage("ishiki.notification", {
        timestamp: Date.now(),
        sid: focus.sid,
        channelId: focus.channelId,
        platform: body.platform!,
        selfId: body.selfId,
        reason,
        sources: [event],
      }),
    ];
  }

  private atFocus(event: IshikiEvent): boolean {
    const focus = this.options.currentFocus();
    return event.data.sid === focus.sid && event.data.channelId === focus.channelId;
  }

  /** Why this event addresses the mind, or nothing when it does not. The reason is what a retelling carries. */
  private attentionReason(event: IshikiEvent): string | undefined {
    if (event.type !== "ishiki.message.created") return undefined;
    const fact = event.data;
    if (fact.direct === true) return "direct";
    if (this.options.profile.attention.quoteSelf && fact.quote?.user?.id === fact.selfId) return "quote";
    const keyword = this.options.profile.keywords.find((candidate) => candidate.length > 0 && fact.content.includes(candidate));
    if (keyword !== undefined) return `keyword:${keyword}`;
    if (this.mentionsSelf(fact)) return "mention";
    return undefined;
  }

  /** The mention has to be read out of `content`: it is the only form the fact keeps. */
  private mentionsSelf(fact: IshikiMessageCreated): boolean {
    if (!fact.content.includes("<at")) return false;
    try {
      return h.parse(fact.content).some((element) => element.type === "at" && element.attrs?.id === fact.selfId);
    } catch {
      return false;
    }
  }
}
