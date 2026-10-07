import { createCustomMessage } from "@yesimagent/core";
import { h, type Element, type Session } from "koishi";

import type { InboundMedia, IshikiEvent } from "./types.js";

export interface SessionHandler {
  handle(session: Session): IshikiEvent | undefined;
}

function isDirect(session: Session): boolean {
  return session.isDirect === true || session.channelId?.startsWith("private:") === true;
}

const MEDIA_KINDS = { img: "image", audio: "audio", video: "video", file: "file" } as const;

function extractMedia(content: string): InboundMedia[] {
  const media: InboundMedia[] = [];
  const visit = (element: Element): void => {
    const kind = MEDIA_KINDS[element.type as keyof typeof MEDIA_KINDS];
    if (kind && typeof element.attrs.src === "string") {
      media.push({ kind, src: element.attrs.src, filename: element.attrs.filename });
      return;
    }
    for (const child of element.children) {
      if (typeof child !== "object") continue;
      visit(child);
    }
  };
  for (const element of h.parse(content)) visit(element);
  return media;
}

export class StandardHandler implements SessionHandler {
  readonly platform = "*";
  readonly priority = 1000;

  handle(session: Session): IshikiEvent | undefined {
    if (session.type === "message-created") {
      const authorName = [session.author.nick, session.author.name, session.userId].find((name) => String(name) != "")!;
      const content = session.content!;
      return createCustomMessage("ishiki.message.created", {
        timestamp: session.timestamp,
        platform: session.platform,
        channelId: session.channelId!,
        selfId: session.selfId,
        isDirect: isDirect(session),
        guildId: session.guildId,
        messageId: session.messageId!,
        content,
        media: extractMedia(content),
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

    if (session.type === "message-deleted") {
      if (!session.messageId || !session.channelId) return undefined;
      return createCustomMessage("ishiki.message.deleted", {
        timestamp: session.timestamp,
        platform: session.platform,
        channelId: session.channelId,
        selfId: session.selfId,
        messageId: session.messageId,
        userId: session.userId,
        operatorId: session.operatorId,
      });
    }

    return undefined;
  }
}
