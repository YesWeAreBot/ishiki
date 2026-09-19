import { AgentEntry } from "@yesimagent/core";
import { h } from "koishi";

import type { Focus, Profile } from "./profiles.js";
import type { IshikiEvent } from "./types.js";

/**
 * Everything that knows what a scene is and what a fact reads back as. A scene is a body plus a channel id
 * whose meaning is scoped to that body, so the address is `platform:selfId:channelId` and the key carries the
 * body. The workspace projection and the frame between them ask the same three questions — is this fact of the
 * cursor's scene, is it of some given scene, and what line does it render to — so they ask them here.
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
export function lineOf(fact: IshikiEvent.MessageCreated): string {
  const who = fact.user.name === undefined || fact.user.name.length === 0 ? fact.user.id : `${fact.user.name}(${fact.user.id})`;
  return `[${formatClock(fact.timestamp)}] ${who} #${fact.messageId}: ${fact.content}`;
}

/**
 * A fact as the projection sees it: the scene it belongs to, the one line it renders to, and the channel name
 * it arrived with. The wrapper cannot be baked into the line itself, because a fact of another scene renders
 * as a block.
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
function factOf(fact: IshikiEvent.MessageCreated, own: boolean): Omit<Fact, "timestamp"> {
  return {
    scene: sceneOf(fact),
    line: lineOf(fact),
    own,
    ...(fact.channel.name === undefined ? {} : { channelName: fact.channel.name }),
  };
}

function retractionOf(fact: IshikiEvent.MessageDeleted): Omit<Fact, "timestamp"> {
  return {
    scene: { sid: sidOf(fact), channelId: fact.channelId },
    line: `[${formatClock(fact.timestamp)}] #${fact.messageId}: (已撤回)`,
    own: false,
  };
}

/** A fact plus the one thing a projection adds: whether the cursor is on that scene. */
type Seen = Omit<Fact, "timestamp"> & { focus: boolean };

/** A bare line for a fact in the cursor's scene, a line worth an awareness block when it comes from elsewhere. */
function seenFact(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageCreated): Seen | undefined {
  if (sceneKey(sceneOf(fact)) === sceneKey(cursor)) return { ...factOf(fact, false), focus: true };

  // Whether a fact from another scene still reaches the mind. The rules mirror the wake rules, so the fact that
  // started a turn can never be invisible inside it.
  let reaches = fact.channel.direct === true || profile.keywords.some((keyword) => keyword.length > 0 && fact.content.includes(keyword));
  if (!reaches && fact.content.includes("<at")) {
    try {
      reaches = h.parse(fact.content).some((element) => element.type === "at" && element.attrs?.id === fact.selfId);
    } catch {
      reaches = false;
    }
  }
  if (!reaches) return undefined;
  return { ...factOf(fact, false), focus: false };
}

function seenRetraction(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageDeleted): Seen | undefined {
  const retraction = retractionOf(fact);
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
 * reaches the mind, and pins each entry to the scene it belonged to when the stream reached it. A record says
 * what something is, never how it is emitted — the block heads, the awareness wrappers and the trace lines are
 * the consumers' business.
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
        out.push({ kind: "fact", entry, ...factOf(message.data, true), focus: false, timestamp: entry.timestamp });
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

/** One scene's segment of a frame, already rendered. */
export interface Segment {
  scene: Focus;
  /** True once the generation worked in that scene; a scene it only heard from is read back out of storage. */
  focus: boolean;
  lines: string[];
  /** The stream time of the segment's last entry, which is what the caller sorts the segments by. */
  latest: number;
}

/**
 * Buckets a workspace into frame segments, keeping first-appearance order. The lines are already rendered, so
 * nothing downstream has to know one tool from another: a fact is its line, and a call and its result are one
 * line each, in full.
 */
export function frameSegments(profile: Profile, workspace: readonly AgentEntry[], startFocus: Focus): Segment[] {
  const buckets = new Map<string, { segment: Segment; records: WalkRecord[] }>();

  for (const record of classify(profile, workspace, startFocus)) {
    const scene = record.kind === "switch" ? record.next : record.scene;
    const key = sceneKey(scene);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { segment: { scene, focus: false, lines: [], latest: 0 }, records: [] };
      buckets.set(key, bucket);
    }
    if (record.kind === "switch") {
      bucket.segment.focus = true;
      continue;
    }
    if (record.kind === "trace" || record.focus) bucket.segment.focus = true;
    bucket.records.push(record);
    bucket.segment.latest = record.entry.timestamp;
  }

  const segments: Segment[] = [];
  for (const bucket of buckets.values()) {
    bucket.segment.lines = renderLines(bucket.records);
    segments.push(bucket.segment);
  }
  return segments;
}

/**
 * The lines of one scene's records, in the order they happened: its facts, and the behavior and results around
 * them. Every call and every result is printed in full, nothing here knows one tool from another, and the
 * assistant's prose still never enters a frame.
 */
function renderLines(records: readonly WalkRecord[]): string[] {
  const lines: string[] = [];
  const calls = new Map<string, string>();

  for (const record of records) {
    if (record.kind === "fact") {
      lines.push(record.line);
      continue;
    }
    if (record.kind !== "trace") continue;

    const message = record.entry.data;
    if (message.role === "assistant") {
      for (const part of partsOf(message.content)) {
        if (part.type !== "tool-call" || typeof part.toolCallId !== "string") continue;
        const name = String(part.toolName ?? "tool");
        calls.set(part.toolCallId, name);
        lines.push(`[工具调用] ${name}: ${JSON.stringify(part.input ?? null)}`);
      }
      continue;
    }
    if (message.role === "tool") {
      for (const part of partsOf(message.content)) {
        const name = calls.get(String(part.toolCallId)) ?? String(part.toolName ?? "tool");
        const output = part.output as { value?: unknown } | undefined;
        const result = output === undefined ? "" : typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? null);
        lines.push(`[工具结果] ${name}: ${result}`);
      }
    }
  }
  return lines;
}

function partsOf(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content as Array<Record<string, unknown>>;
}

/**
 * One scene's facts, in stream order. What the window showed and what storage holds are read the same way; the
 * only difference is `retractions`, because a frame reads a retraction back as a fact of that scene while
 * `peek_channel` only reads the conversation.
 */
export function factsOf(entries: readonly AgentEntry[], scene: Focus, options: { retractions?: boolean } = {}): Fact[] {
  const key = sceneKey(scene);
  const out: Fact[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.data;
    if (message.role !== "custom") continue;

    if (message.type === "ishiki.message.created" || message.type === "ishiki.self.message") {
      if (sceneKey(sceneOf(message.data)) === key) out.push({ ...factOf(message.data, message.type === "ishiki.self.message"), timestamp: entry.timestamp });
      continue;
    }
    if (message.type === "ishiki.message.deleted" && options.retractions !== false) {
      const retraction = retractionOf(message.data);
      if (sceneKey(retraction.scene) === key) out.push({ ...retraction, timestamp: entry.timestamp });
    }
  }
  return out;
}
