import { AgentEntry } from "@yesimagent/core";
import { h } from "koishi";

import type { Focus, Profile } from "./profiles.js";
import type { IshikiEvent } from "./types.js";

/**
 * Scene primitives: identity, the event-render registry, workspace classification, and storage queries.
 * A scene is a body (sid) plus a channel id; the address is `platform:selfId:channelId`.
 */

/** 场景身份 = 身体 + 频道;地址写作 `platform:selfId:channelId`(`channelId` 的语义域是 `selfId`)。 */
export function sceneKey(scene: Focus): string {
  return `${scene.sid}:${scene.channelId}`;
}

/** 事实行与帧头共用的时钟写法。 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export function sidOf(fact: { platform: string; selfId: string }): string {
  return `${fact.platform}:${fact.selfId}`;
}

/** `[21:40] Miaow(42) #m1: 内容` — a message event's canonical line. */
export function renderLine(fact: IshikiEvent.MessageCreated): string {
  const who = fact.user.name === undefined || fact.user.name.length === 0 ? fact.user.id : `${fact.user.name}(${fact.user.id})`;
  return `[${formatClock(fact.timestamp)}] ${who} #${fact.messageId}: ${fact.content}`;
}

// ---------------------------------------------------------------------------
// Event render registry
// ---------------------------------------------------------------------------

/**
 * Per-message-type render rule: how to extract a scene, produce a text line, and decide workspace visibility.
 * The framework (classify, collectLines, renderFrame) dispatches through this table instead of per-type
 * if/else chains.  Adding a new event type = adding one entry here + its AgentCustomMessage declaration.
 */
export interface EventRender<T = unknown> {
  /** Which scene this event belongs to. */
  scene(data: T): Focus;
  /** Render the event as a single text line (no notification wrapper — the framework adds that). */
  render(data: T): string;
  /** Is this the mind's own action? Own lines enter the frame but not the workspace. */
  own: boolean;
  /**
   * When the event is NOT in the focus scene, does it still reach the workspace (as a notification)?
   * Omit or return false for events that are only visible when in focus.
   */
  reaches?(data: T, profile: Pick<Profile, "allowedChannels" | "keywords">): boolean;
}

/** Message-type string → render rule. Unknown types are invisible (fail-closed). */
export const eventRenders: Record<string, EventRender> = {
  "ishiki.message.created": {
    scene: (d: IshikiEvent.MessageCreated) => ({ sid: sidOf(d), channelId: d.channel.id }),
    render: renderLine,
    own: false,
    reaches(d: IshikiEvent.MessageCreated, profile) {
      if (d.channel.direct === true) return true;
      if (profile.keywords.some((kw) => kw.length > 0 && d.content.includes(kw))) return true;
      if (d.content.includes("<at")) {
        try {
          return h.parse(d.content).some((el) => el.type === "at" && el.attrs?.id === d.selfId);
        } catch {
          return false;
        }
      }
      return false;
    },
  } satisfies EventRender<IshikiEvent.MessageCreated>,

  "ishiki.self.message": {
    scene: (d: IshikiEvent.MessageCreated) => ({ sid: sidOf(d), channelId: d.channel.id }),
    render: renderLine,
    own: true,
  } satisfies EventRender<IshikiEvent.MessageCreated>,

  "ishiki.message.deleted": {
    scene: (d: IshikiEvent.MessageDeleted) => ({ sid: sidOf(d), channelId: d.channelId }),
    render: (d: IshikiEvent.MessageDeleted) => `[${formatClock(d.timestamp)}] #${d.messageId}: (已撤回)`,
    own: false,
    reaches(d: IshikiEvent.MessageDeleted, profile) {
      return d.operatorId !== undefined && profile.allowedChannels.some((decl) => decl.sid === sidOf(d));
    },
  } satisfies EventRender<IshikiEvent.MessageDeleted>,
};

// ---------------------------------------------------------------------------
// RenderedLine (output of event render resolution)
// ---------------------------------------------------------------------------

/**
 * A storage entry after render resolution: the scene it belongs to, the text line it renders to, and the
 * channel name it arrived with.
 */
export interface RenderedLine {
  scene: Focus;
  line: string;
  /** The mind's own message: read back in a frame like anybody else's line, never emitted into the workspace. */
  own: boolean;
  /** The channel name this entry carried. */
  channelName?: string;
  /** The timestamp of the entry on the stream; the frame cuts its window and orders its segments by it. */
  timestamp: number;
}

/** Resolve a custom message entry via the event render registry. Returns undefined for unknown types. */
function resolveRender(type: string, data: unknown): Omit<RenderedLine, "timestamp"> | undefined {
  const desc = eventRenders[type];
  if (!desc) return undefined;
  let channelName: string | undefined;
  if (data && typeof data === "object" && "channel" in data) {
    const ch = data.channel;
    if (ch && typeof ch === "object" && "name" in ch) {
      if (typeof ch.name === "string") channelName = ch.name;
    }
  }
  return {
    scene: desc.scene(data),
    line: desc.render(data),
    own: desc.own,
    ...(channelName !== undefined ? { channelName } : {}),
  };
}

/** What the walk reads out of an entry stream, in stream order. Attribution is settled here; emission is not. */
export type WalkRecord =
  | { kind: "switch"; previous: Focus; next: Focus; reason?: string; entry: AgentEntry<"ishiki.focus.changed"> }
  | ({ kind: "fact"; entry: AgentEntry<"message">; focus: boolean } & RenderedLine)
  | { kind: "trace"; scene: Focus; entry: AgentEntry<"message"> };

/**
 * Reads the workspace as records: advances the cursor over the recorded switches, decides whether a rendered
 * line reaches the mind, and pins each entry to the scene it belonged to when the stream reached it.
 */
export function classify(profile: Pick<Profile, "allowedChannels" | "keywords">, entries: readonly AgentEntry[], startFocus: Focus): WalkRecord[] {
  const out: WalkRecord[] = [];
  let cursor = startFocus;

  for (const entry of entries) {
    if (entry.type === "ishiki.focus.changed") {
      cursor = { ...entry.data.next };
      out.push({
        kind: "switch",
        previous: { ...entry.data.previous },
        next: cursor,
        ...(entry.data.reason === undefined ? {} : { reason: entry.data.reason }),
        entry,
      });
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.data;
    if (message.role === "custom") {
      const resolved = resolveRender(message.type, message.data);
      if (!resolved) continue;
      const inFocus = sceneKey(resolved.scene) === sceneKey(cursor);
      const visible = resolved.own || inFocus || eventRenders[message.type]?.reaches?.(message.data, profile) === true;
      if (!visible) continue;
      out.push({ kind: "fact", entry, ...resolved, focus: inFocus, timestamp: entry.timestamp });
      continue;
    }

    out.push({ kind: "trace", scene: cursor, entry });
  }
  return out;
}

/**
 * One scene's rendered lines, in stream order.
 */
export function collectLines(entries: readonly AgentEntry[], scene: Focus): RenderedLine[] {
  const key = sceneKey(scene);
  const out: RenderedLine[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.data;
    if (message.role !== "custom") continue;

    const resolved = resolveRender(message.type, message.data);
    if (!resolved) continue;
    if (sceneKey(resolved.scene) !== key) continue;
    out.push({ ...resolved, timestamp: entry.timestamp });
  }
  return out;
}
