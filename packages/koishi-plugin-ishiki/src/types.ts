import type { CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
    "ishiki.attachment": IshikiAttachment;
    "ishiki.tools.catalog": IshikiToolsCatalog;
  }
}

export type IshikiEvent = CustomMessages<"ishiki.message.created" | "ishiki.message.deleted" | "ishiki.tools.catalog">;

export interface AttachmentItem {
  url: string;
  mediaType: string;
  filename?: string;
  byteLength?: number;
  width?: number;
  height?: number;
}

export type IshikiAttachment =
  | { source: "tool"; toolName: string; toolCallId: string; items: AttachmentItem[] }
  | { source: "platform"; platform: string; selfId: string; channelId: string; messageId: string; items: AttachmentItem[] };

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

/**
 * Tool catalog update, persisted into the conversation by the toolsearch
 * runtime. Full replay: each entry announces the complete visible-tool set
 * and supersedes every earlier catalog.
 */
export interface IshikiToolsCatalog {
  /** Catalog text rendered at write time (vendored code-mode renderer). */
  text: string;
  /** Visible tool names at write time; informational, for inspection and debugging. */
  tools: readonly string[];
}
