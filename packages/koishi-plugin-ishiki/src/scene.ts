import { AgentEntry } from "@yesimagent/core";
import { h } from "koishi";

import type { Focus, Profile } from "./profiles.js";
import type { IshikiEvent } from "./types.js";

/**
 * Scene primitives: identity, fact rendering, workspace classification, and storage queries.
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

function sidOf(fact: { platform: string; selfId: string }): string {
  return `${fact.platform}:${fact.selfId}`;
}

function sceneOf(fact: IshikiEvent.MessageCreated): Focus {
  return { sid: sidOf(fact), channelId: fact.channel.id };
}

/** `[21:40] Miaow(42) #m1: 内容` — 一条事实唯一会渲染成的行。 */
export function renderLine(fact: IshikiEvent.MessageCreated): string {
  const who = fact.user.name === undefined || fact.user.name.length === 0 ? fact.user.id : `${fact.user.name}(${fact.user.id})`;
  return `[${formatClock(fact.timestamp)}] ${who} #${fact.messageId}: ${fact.content}`;
}

/**
 * A fact as the projection sees it: the scene it belongs to, the one line it renders to, and the channel name
 * it arrived with.
 */
export interface Fact {
  scene: Focus;
  line: string;
  /** The mind's own message: read back in a frame like anybody else's line, never emitted into the workspace. */
  own: boolean;
  /** The channel name this fact carried; the mind's own messages and retractions have none. */
  channelName?: string;
  /** The timestamp of the entry on the stream; the frame cuts its window and orders its segments by it. */
  timestamp: number;
}

/** A fact without its place on the stream, which only the walk can attach. */
function toFact(fact: IshikiEvent.MessageCreated, own: boolean): Omit<Fact, "timestamp"> {
  return {
    scene: sceneOf(fact),
    line: renderLine(fact),
    own,
    ...(fact.channel.name === undefined ? {} : { channelName: fact.channel.name }),
  };
}

function toRetraction(fact: IshikiEvent.MessageDeleted): Omit<Fact, "timestamp"> {
  return {
    scene: { sid: sidOf(fact), channelId: fact.channelId },
    line: `[${formatClock(fact.timestamp)}] #${fact.messageId}: (已撤回)`,
    own: false,
  };
}

/** A fact plus the one thing a projection adds: whether the cursor is on that scene. */
type Seen = Omit<Fact, "timestamp"> & { focus: boolean };

/**
 * Decides whether a non-focus fact reaches the mind's workspace (as a notification).
 *
 * The conditions mirror the wake rules in the ingestion handler (direct / @self / keywords),
 * so a fact that triggered a turn is always visible inside it. The ingestion handler reads
 * Koishi's `session.stripped.atSelf`; here we re-parse from stored content via `h.parse`.
 */
function seenFact(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageCreated): Seen | undefined {
  if (sceneKey(sceneOf(fact)) === sceneKey(cursor)) return { ...toFact(fact, false), focus: true };

  let reaches = fact.channel.direct === true || profile.keywords.some((keyword) => keyword.length > 0 && fact.content.includes(keyword));
  if (!reaches && fact.content.includes("<at")) {
    try {
      reaches = h.parse(fact.content).some((element) => element.type === "at" && element.attrs?.id === fact.selfId);
    } catch {
      reaches = false;
    }
  }
  if (!reaches) return undefined;
  return { ...toFact(fact, false), focus: false };
}

function seenRetraction(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageDeleted): Seen | undefined {
  const retraction = toRetraction(fact);
  const inFocus = sceneKey(retraction.scene) === sceneKey(cursor);
  const ours = fact.operatorId !== undefined && profile.allowedChannels.some((declaration) => declaration.sid === retraction.scene.sid);
  if (!inFocus && !ours) return undefined;
  return { ...retraction, focus: inFocus };
}

/** What the walk reads out of an entry stream, in stream order. Attribution is settled here; emission is not. */
export type WalkRecord =
  | { kind: "switch"; previous: Focus; next: Focus; reason?: string; entry: AgentEntry<"ishiki.focus.changed"> }
  | ({ kind: "fact"; entry: AgentEntry<"message">; focus: boolean } & Fact)
  | { kind: "trace"; scene: Focus; entry: AgentEntry<"message"> };

/**
 * Reads the workspace as records: advances the cursor over the recorded switches, decides whether a fact
 * reaches the mind, and pins each entry to the scene it belonged to when the stream reached it.
 */
export function classify(profile: Profile, entries: readonly AgentEntry[], startFocus: Focus): WalkRecord[] {
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
      if (message.type === "ishiki.self.message") {
        out.push({ kind: "fact", entry, ...toFact(message.data, true), focus: false, timestamp: entry.timestamp });
        continue;
      }
      const seen =
        message.type === "ishiki.message.created"
          ? seenFact(profile, cursor, message.data)
          : message.type === "ishiki.message.deleted"
            ? seenRetraction(profile, cursor, message.data)
            : undefined;
      if (seen === undefined) continue;
      out.push({ kind: "fact", entry, ...seen, timestamp: entry.timestamp });
      continue;
    }

    out.push({ kind: "trace", scene: cursor, entry });
  }
  return out;
}

/**
 * One scene's facts, in stream order. What the window showed and what storage holds are read the same way; the
 * only difference is `retractions`, because a frame reads a retraction back as a fact of that scene while
 * `peek_channel` only reads the conversation.
 */
export function collectFacts(entries: readonly AgentEntry[], scene: Focus, options: { retractions?: boolean } = {}): Fact[] {
  const key = sceneKey(scene);
  const out: Fact[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.data;
    if (message.role !== "custom") continue;

    if (message.type === "ishiki.message.created" || message.type === "ishiki.self.message") {
      if (sceneKey(sceneOf(message.data)) === key) out.push({ ...toFact(message.data, message.type === "ishiki.self.message"), timestamp: entry.timestamp });
      continue;
    }
    if (message.type === "ishiki.message.deleted" && options.retractions !== false) {
      const retraction = toRetraction(message.data);
      if (sceneKey(retraction.scene) === key) out.push({ ...retraction, timestamp: entry.timestamp });
    }
  }
  return out;
}
