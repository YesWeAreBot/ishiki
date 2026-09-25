import { createCustomMessage } from "@yesimagent/core";
import type { Session } from "koishi";

import type { IshikiEvent } from "./types.js";

export interface SessionHandler {
  handle(session: Session): IshikiEvent | undefined;
}

export class StandardHandler implements SessionHandler {
  readonly platform = "*";
  readonly priority = 1000;

  handle(session: Session): IshikiEvent | undefined {
    // message-created
    if (session.type === "message-created") {
      const authorName = session.author?.nick ?? session.author?.name ?? session.userId;
      return createCustomMessage("ishiki.message.created", {
        timestamp: session.timestamp,
        platform: session.platform,
        channelId: session.channelId!,
        selfId: session.selfId,
        isDirect: session.isDirect === true,
        guildId: session.guildId,
        messageId: session.messageId!,
        content: session.content!,
        user: { id: session.userId!, name: authorName },
        quote: session.quote
          ? {
              id: session.quote.messageId!,
              content: session.quote.content,
              user: session.quote.user,
              channel: session.quote.channel,
              guild: session.quote.guild,
            }
          : undefined,
      });
    }

    // message-deleted
    if (session.type === "message-deleted") {
      if (!session.messageId || !session.channelId) return undefined;
      return createCustomMessage("ishiki.message.deleted", {
        timestamp: session.timestamp,
        platform: session.platform,
        channelId: session.channelId,
        selfId: session.selfId,
        messageId: session.messageId,
        operatorId: session.operatorId,
      });
    }

    return undefined;
  }
}
