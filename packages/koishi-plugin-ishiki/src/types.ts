import { CustomMessage } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": CustomMessage<"ishiki.message.created", IshikiEvent.MessageCreated>;
    "ishiki.message.deleted": CustomMessage<"ishiki.message.deleted", IshikiEvent.MessageDeleted>;
    "ishiki.self.message": CustomMessage<"ishiki.self.message", IshikiEvent.MessageCreated>;

    // OneBot Events
    "onebot.guild.member-added": CustomMessage<"onebot.guild.member-added", OneBotEvent.GuildMemberAdded>;
  }

  interface AgentCustomEntry {
    "ishiki.checkpoint": IshikiEntry.Checkpoint;
    "ishiki.focus.changed": IshikiEntry.FocusChanged;
  }
}

export namespace IshikiEvent {
  export interface EventBase {
    timestamp: number;
    platform: string;
    selfId: string;
  }

  export interface MessageCreated extends EventBase {
    content: string;
    /** A snapshot: a later rename never rewrites the lines already rendered from this fact. */
    user: { id: string; name?: string };
    channel: { id: string; name?: string; direct?: boolean };
    guildId?: string;
    messageId: string;
    quote?: { id: string; content?: string; user?: { id: string; name?: string }; channel?: { id: string }; guild?: { id: string } };
  }

  export interface MessageDeleted extends EventBase {
    messageId: string;
    channelId: string;
    operatorId?: string;
  }
}

export namespace OneBotEvent {
  export interface GuildMemberAdded extends IshikiEvent.EventBase {
    channelId: string;
    guildId: string;
    userId: string;
    operatorId?: string;
  }

  export interface NoticePoke extends IshikiEvent.EventBase {
    channelId: string;
    guildId: string;
    userId: string;
    targetId: string;
  }
}

export namespace IshikiEntry {
  /** Appended at a step boundary when `switch_focus` changed the scene mid-step. */
  export interface FocusChanged {
    previous: { sid: string; channelId: string };
    next: { sid: string; channelId: string };
    reason?: string;
  }

  /**
   * The generation boundary: the frame is materialized here (its text plus the focus the generation started
   * in), so every later step reuses one stable string instead of re-rendering the previous generation.
   */
  export interface Checkpoint {
    frameFocus: { sid: string; channelId: string };
    text: string;
    createdAt: number;
  }
}
