import { CustomMessage } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": CustomMessage<"ishiki.message.created", IshikiEvent.MessageCreated>;
    "ishiki.message.deleted": CustomMessage<"ishiki.message.deleted", IshikiEvent.MessageDeleted>;

    // OneBot Events
    "onebot.guild.member-added": CustomMessage<"onebot.guild.member-added", OneBotEvents.GuildMemberAdded>;
  }

  interface AgentCustomEntry {
    "ishiki.checkpoint": IshikiEntry.Checkpoint;
    "ishiki.focus-change": IshikiEntry.FocusChange;
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
    userId: string;
    channelId?: string;
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

export namespace OneBotEvents {
  export interface GuildMemberAdded extends IshikiEvent.EventBase {
    guildId: string;
    userId: string;
    operatorId?: string;
  }
}

export namespace IshikiEntry {
  export interface FocusChange {
    previous: { sid: string; channelId: string };
    next: { sid: string; channelId: string };
  }
  export interface Checkpoint {
    focus: { sid: string; channelId: string };
    frameText: string;
  }
}
