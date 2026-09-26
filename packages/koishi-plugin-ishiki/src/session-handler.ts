import { createCustomMessage } from "@yesimagent/core";
import type { Session } from "koishi";

import type { IshikiEvent } from "./types.js";

export interface SessionHandler {
  handle(session: Session): IshikiEvent | undefined;
}

function pickUserName(session: Session) {
  const l = [session.author.nick, session.author.name, session.userId];
  for (const name of l) {
    if (String(name) != "") return name;
  }
}

/**
 * 是不是私聊。`session.isDirect` 只在适配器把 `channel.type` 填成 `direct` 时才为真（satori 的取法），
 * 有的适配器只给 `private:` 开头的频道号、不填类型；两种信号取或，私聊规则才不会漏。
 */
function isDirect(session: Session): boolean {
  return session.isDirect === true || session.channelId?.startsWith("private:") === true;
}

export class StandardHandler implements SessionHandler {
  readonly platform = "*";
  readonly priority = 1000;

  handle(session: Session): IshikiEvent | undefined {
    // message-created
    if (session.type === "message-created") {
      const authorName = pickUserName(session);
      return createCustomMessage("ishiki.message.created", {
        timestamp: session.timestamp,
        platform: session.platform,
        channelId: session.channelId!,
        selfId: session.selfId,
        isDirect: isDirect(session),
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
