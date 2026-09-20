import { createCustomMessage } from "@yesimagent/core";
import type { Session } from "koishi";

import type { Profile } from "./profiles.js";
import type { IshikiEvent } from "./types.js";

/** One event type's normalization rule: a session it claims becomes that fact, anything else yields nothing. */
export type SessionHandlerRule = (session: Session) => IshikiEvent | undefined;

/**
 * The profile's ingress: Koishi sessions become the facts of its stream. Ordered rules, first match wins.
 * Nothing here judges the fact — whether it wakes the mind is `WeakUpEngine`'s question, not this one's.
 */
export class SessionHandler {
  constructor(private readonly profile: Profile) {}

  private readonly rules: SessionHandlerRule[] = [
    // message-created
    (session) => {
      if (session.type !== "message-created") return undefined;
      const authorName = session.author?.name;
      return createCustomMessage("ishiki.message.created", {
        content: session.content!,
        user: { id: session.userId!, ...(authorName === undefined ? {} : { name: authorName }) },
        sid: session.sid,
        channelId: session.channelId!,
        direct: session.isDirect,
        guildId: session.guildId,
        messageId: session.messageId!,
        timestamp: session.timestamp,
        platform: session.platform,
        selfId: session.selfId,
        quote: session.quote
          ? {
              id: session.quote.id!,
              content: session.quote.content,
              user: session.quote.user,
              channel: session.quote.channel,
              guild: session.quote.guild,
            }
          : undefined,
      });
    },

    // message-deleted
    (session) => {
      if (session.type !== "message-deleted") return undefined;
      if (!session.messageId || !session.channelId) return undefined;
      return createCustomMessage("ishiki.message.deleted", {
        messageId: session.messageId,
        sid: session.sid,
        channelId: session.channelId,
        operatorId: session.userId,
        timestamp: session.timestamp,
        platform: session.platform,
        selfId: session.selfId,
      });
    },
  ];

  handle(session: Session): IshikiEvent | undefined {
    for (const rule of this.rules) {
      const event = rule(session);
      if (event !== undefined) return event;
    }
    return undefined;
  }
}
