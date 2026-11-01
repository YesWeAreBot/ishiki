import type { CodemodeStoreWrites } from "@earendil-works/pi-codemode";
import type { CustomMessages } from "@yesimagent/core";

declare module "@yesimagent/core" {
  interface AgentCustomMessage {
    "ishiki.message.created": IshikiMessageCreated;
    "ishiki.message.deleted": IshikiMessageDeleted;
    "ishiki.attachment": IshikiAttachment;
    "ishiki.task": IshikiTaskNotice;
  }

  interface AgentCustomEntry {
    "ishiki.codemode.store": IshikiCodemodeStore;
    "ishiki.task.record": IshikiTaskRecord;
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
  | { source: "task"; taskId: string; items: AttachmentItem[] }
  | { source: "platform"; platform: string; selfId: string; channelId: string; messageId: string; items: AttachmentItem[] };

/** Store writes of one codemode call, replayed in entry order to rebuild `store`/`load` state. */
export type IshikiCodemodeStore = CodemodeStoreWrites & { toolCallId: string };

export type TaskState = "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";

export type TerminalTaskState = Exclude<TaskState, "running" | "cancelling">;

/** One terminal-state announcement for a codemode background task. */
export interface IshikiTaskNotice {
  taskId: string;
  toolName: string;
  state: TaskState;
  startedAt: number;
  finishedAt: number;
  summary: string;
}

/** One line of `codemode-tasks.jsonl`: the task start, then its single terminal record. */
export type IshikiTaskRecord =
  | { kind: "start"; id: string; toolName: string; startedAt: number }
  | {
      kind: "terminal";
      id: string;
      state: TerminalTaskState;
      finishedAt: number;
      text?: string;
      items?: AttachmentItem[];
      error?: string;
    };

/** Query snapshot of one background task. */
export interface TaskStatus {
  id: string;
  toolName: string;
  state: TaskState;
  startedAt: number;
  finishedAt?: number;
}

export interface TaskResult extends TaskStatus {
  text?: string;
  items?: AttachmentItem[];
  error?: string;
}

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
