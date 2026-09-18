import { CustomMessage } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": CustomMessage<"ishiki.message.created", IshikiEvent.MessageCreated>;
    "ishiki.message.deleted": CustomMessage<"ishiki.message.deleted", IshikiEvent.MessageDeleted>;
    "ishiki.inner.thought": CustomMessage<"ishiki.inner.thought", IshikiMessage.InnerThought>;

    // OneBot Events
    "onebot.guild.member-added": CustomMessage<"onebot.guild.member-added", OneBotEvent.GuildMemberAdded>;
  }

  interface AgentCustomEntry {
    "ishiki.checkpoint": IshikiEntry.Checkpoint;
    "ishiki.focus.changed": IshikiEntry.FocusChanged;
  }
}

export namespace IshikiMessage {
  /**
   * The mind's own monologue, recorded at the step boundary. It never leaves the machine and never enters a
   * frame — frames carry behavior and its results, not the mind's own wording.
   */
  export interface InnerThought {
    text: string;
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
    channel: { id: string; name?: string; direct: boolean };
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
    guildId: string;
    userId: string;
    operatorId?: string;
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
    prevFocus?: { sid: string; channelId: string };
    text: string;
    createdAt: number;
  }
}
