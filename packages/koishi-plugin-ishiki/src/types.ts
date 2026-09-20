import { AgentCustomMessage, CustomMessage } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": CustomMessage<"ishiki.message.created", IshikiMessageCreated>;
    "ishiki.message.deleted": CustomMessage<"ishiki.message.deleted", IshikiMessageDeleted>;
    "ishiki.self.message": CustomMessage<"ishiki.self.message", IshikiMessageCreated>;
    "ishiki.notification": CustomMessage<"ishiki.notification", IshikiNotification>;

    // OneBot Events
    "onebot.guild.member-added": CustomMessage<"onebot.guild.member-added", OneBotGuildMemberAdded>;
  }

  interface AgentCustomEntry {
    "ishiki.checkpoint": IshikiCheckpointEntry;
  }
}

/**
 * A declared event in a profile's stream. `AgentCustomMessage` is open and its bare `custom` member carries no
 * payload at all, so it is not one of these: an undeclared type is the renderer's fail-closed business, not a fact.
 */
export type IshikiEvent = Exclude<AgentCustomMessage[keyof AgentCustomMessage], { type: "custom" }>;

/**
 * Ishiki Event Types
 */
export interface IshikiEventBase {
  timestamp: number;
  /** Body address, `platform:selfId`. Addressing and matching both read it; nothing ever splits it. */
  sid: string;
  /** Channel id, whose meaning is scoped to the body named by `sid`. */
  channelId: string;
  platform: string;
  selfId: string;
}

export interface IshikiMessageCreated extends IshikiEventBase {
  content: string;
  user: { id: string; name?: string };
  direct?: boolean;
  guildId?: string;
  messageId: string;
  quote?: { id: string; content?: string; user?: { id: string; name?: string }; channel?: { id: string }; guild?: { id: string } };
}

export interface IshikiNotification extends IshikiEventBase {
  /** Which of the profile's attention rules made this worth interrupting for. */
  reason: string;
  /** The events that contributed. Each renders through its own type's rule. */
  sources: IshikiEvent[];
}

export interface IshikiMessageDeleted extends IshikiEventBase {
  messageId: string;
  channelId: string;
  operatorId?: string;
}

/**
 * OneBot Event Types
 */
export interface OneBotGuildMemberAdded extends IshikiEventBase {
  channelId: string;
  guildId: string;
  userId: string;
  operatorId?: string;
}

export interface OneBotNoticePoke extends IshikiEventBase {
  channelId: string;
  guildId: string;
  userId: string;
  targetId: string;
}

/**
 * The generation boundary: the frame is materialized here (its text plus the focus the generation started
 * in), so every later step reuses one stable string instead of re-rendering the previous generation.
 */
export interface IshikiCheckpointEntry {
  frameFocus: { sid: string; channelId: string };
  text: string;
  createdAt: number;
}
