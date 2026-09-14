import { CustomMessage } from "@yesimagent/core";
import { Element } from "koishi";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": CustomMessage<"ishiki.message.created", IshikiEvents.MessageCreated>;
    "ishiki.message.deleted": CustomMessage<"ishiki.message.deleted", IshikiEvents.MessageDeleted>;
  }

  interface AgentCustomEntry {
    "ishiki.checkpoint": IshikiEvents.Checkpoint;
  }
}

export namespace IshikiEvents {
  export interface MessageCreated {
    content: string;
    userId: string;
    channelId?: string;
    guildId?: string;
    messageId: string;
    timestamp: number;
    platform: string;
    selfId: string;
    quote?: { id: string; content?: string };
  }

  export interface MessageDeleted {
    messageId: string;
    channelId: string;
    operatorId?: string;
    timestamp: number;
    platform: string;
    selfId: string;
  }

  export interface Checkpoint {}
}
