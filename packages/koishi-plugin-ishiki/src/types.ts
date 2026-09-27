import type { AgentCustomMessage, AgentMessage, CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
  }
}

export type IshikiEvent = CustomMessages<Extract<keyof AgentCustomMessage, `ishiki.${string}`>>;

/**
 * 这条消息落在哪个频道；模型自己发的话没有频道可言（它不是事件，只是 agent 的记忆）。
 */
export function readChannelId(message: AgentMessage): string | undefined {
  if (message.role !== "custom") return undefined;
  switch (message.type) {
    case "ishiki.message.created":
    case "ishiki.message.deleted":
      return message.data.channelId;
    default:
      return undefined;
  }
}

/**
 * 事件的落址：一个 bot 账号下的一个频道。`(platform:selfId, channelId)` 是唯一标识，
 * 场景容器只按这一对寻址，不再携带频道形态。
 */
export interface IshikiEventBase {
  timestamp: number;
  platform: string;
  selfId: string;
  channelId: string;
}

export interface IshikiMessageCreated extends IshikiEventBase {
  messageId: string;
  content: string;
  /** 这条消息来自私聊。事件的瞬时属性，不进场景容器：唤醒判定读它，场景本身不关心。 */
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
  operatorId?: string;
}
