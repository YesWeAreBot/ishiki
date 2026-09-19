import { createCustomMessage, type AgentCustomMessage } from "@yesimagent/core";
import type { Session } from "koishi";

import type { Profile } from "./profiles.js";

export type HandlerResult = { message: AgentCustomMessage[keyof AgentCustomMessage]; trigger: boolean };

type SessionHandler = (session: Session, profile: Profile) => HandlerResult | undefined;

/** Ordered handler list. The first handler that returns a non-undefined result wins. */
export const sessionHandlers: SessionHandler[] = [
  // message-created
  (session, profile) => {
    if (session.type !== "message-created") return undefined;
    const authorName = session.author?.name;
    const message = createCustomMessage("ishiki.message.created", {
      content: session.content!,
      user: { id: session.userId!, ...(authorName === undefined ? {} : { name: authorName }) },
      channel: { id: session.channelId!, direct: session.isDirect },
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
    const trigger =
      session.isDirect ||
      session.stripped.atSelf ||
      (session.stripped.hasAt && session.elements?.some((el) => el.type === "at" && el.attrs?.id === session.selfId)) ||
      profile.keywords.some((keyword) => session.content?.includes(keyword));
    return { message, trigger };
  },

  // message-deleted
  (session) => {
    if (session.type !== "message-deleted") return undefined;
    if (!session.messageId || !session.channelId) return undefined;
    const message = createCustomMessage("ishiki.message.deleted", {
      messageId: session.messageId,
      channelId: session.channelId,
      operatorId: session.userId,
      timestamp: session.timestamp,
      platform: session.platform,
      selfId: session.selfId,
    });
    return { message, trigger: false };
  },
];
