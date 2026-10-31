import type { CodemodeStoreWrites } from "@earendil-works/pi-codemode";
import type { CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
    "ishiki.attachment": IshikiAttachment;
  }

  interface AgentCustomEntry {
    "ishiki.codemode.store": IshikiCodemodeStore;
  }
}

export type IshikiEvent = CustomMessages;

export type ImageLifetime = "once" | "recent" | "retain";

export interface AttachmentItem {
  url: string;
  mediaType: string;
  filename?: string;
  byteLength?: number;
  lifetime?: ImageLifetime;
}

export type IshikiAttachment =
  | { source: "tool"; toolName: string; toolCallId: string; items: AttachmentItem[] }
  | { source: "platform"; platform: string; selfId: string; channelId: string; messageId: string; items: AttachmentItem[] };

/** Store writes of one codemode call, replayed in entry order to rebuild `store`/`load` state. */
export type IshikiCodemodeStore = CodemodeStoreWrites & { toolCallId: string };

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
  quote?: {
    id: string;
    content?: string;
    user?: { id: string; name?: string };
    channel?: { id: string };
    guild?: { id: string };
  };
}

export interface IshikiMessageDeleted extends IshikiEventBase {
  messageId: string;
  userId?: string;
  operatorId?: string;
}
