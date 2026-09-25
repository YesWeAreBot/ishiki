import type { AgentCustomMessage, CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
    "ishiki.inner_stimulus": IshikiInnerStimulus;
  }
}

export type IshikiEvent = CustomMessages<Extract<keyof AgentCustomMessage, `ishiki.${string}`>>;

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

/**
 * 由一个频道实例投递给另一个频道实例的刺激。它写入目标自身的事件流，
 * 目标在下一次唤醒时将其作为本地事件读取，并自行决定是否发起轮次。
 */
export interface IshikiInnerStimulus extends IshikiEventBase {
  /** 来源频道实例当时的地址；由宿主插件直接投递时缺席。 */
  source?: { platform: string; selfId: string; channelId: string };
  /** 投递原因，供目标实例理解上下文。 */
  reason: string;
  /** 投递内容。 */
  content: string;
}
