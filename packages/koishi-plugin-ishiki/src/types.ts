import type { AgentCustomMessage, CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
  }
}

export type IshikiEvent = CustomMessages<Extract<keyof AgentCustomMessage, `ishiki.${string}`>>;

export interface IshikiEventBase {
  timestamp: number;
  platform: string;
  selfId: string;
  channelId: string;
}

export interface IshikiMessageCreated extends IshikiEventBase {
  messageId: string;
  content: string;
  isDirect: boolean;
  user: { id: string; name?: string };
  guildId?: string;
  /** Media elements extracted from the message; empty when it carries none. */
  media: InboundMedia[];
  quote?: {
    id: string;
    content?: string;
    user?: { id: string; name?: string };
    channel?: { id: string };
    guild?: { id: string };
  };
}

/** An inbound media element (image/audio/video/file) before asset registration. */
export interface InboundMedia {
  kind: "image" | "audio" | "video" | "file";
  src: string;
  filename?: string;
}

export interface IshikiMessageDeleted extends IshikiEventBase {
  messageId: string;
  userId?: string;
  operatorId?: string;
}
