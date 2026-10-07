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

const MEDIA_TYPE_HINT = { image: "image/*", audio: "audio/*", video: "video/*" } as const;

function extractMedia(content: string): InboundMedia[] {
  const media: InboundMedia[] = [];
  const visit = (element: Element): void => {
    const kind = MEDIA_KINDS[element.type as keyof typeof MEDIA_KINDS];
    if (kind && typeof element.attrs.src === "string") {
      // 除 src 外的全部平台属性原样留存：名字不确定、只作参考，不做语义假设。
      const { src, ...rest } = element.attrs;
      const filename = typeof rest.file === "string" ? rest.file : typeof rest.filename === "string" ? rest.filename : undefined;
      media.push({
        kind,
        src,
        mediaType: MEDIA_TYPE_HINT[kind as keyof typeof MEDIA_TYPE_HINT] as string | undefined,
        filename,
        sourceInfo: Object.keys(rest).length > 0 ? { ...rest } : undefined,
      });
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
