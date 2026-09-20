import { type AgentCustomMessage, AgentCustomEntry, AgentEntry, createEntry, createUserMessage } from "@yesimagent/core";

import type { Focus, Profile } from "./profiles.js";
import type { IshikiEventBase, IshikiMessageCreated, IshikiNotification } from "./types.js";

/**
 * The projection: everything the model sees that is not the mind's own prompt parts. One render rule per event
 * type, one reader for the fact stream, one place that decides what a generation's workspace looks like.
 */

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

/** 场景身份 = 身体 + 频道;地址写作 `platform:selfId:channelId`(`channelId` 的语义域是 `selfId`)。 */
function sceneKey(scene: Focus): string {
  return `${scene.sid}:${scene.channelId}`;
}

/** 事实行与帧头共用的时钟写法。 */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/** The `<frame ...>` attributes. */
function frameHead(focus: Focus, at: string): string {
  return [`at="${at}"`, `focus_sid="${focus.sid}"`, `focus_channel="${focus.channelId}"`].join(" ");
}

/** `[21:40] Miaow(42) #m1: 内容` — a message event's canonical line. */
export function renderLine(fact: IshikiMessageCreated): string {
  const who = fact.user.name === undefined || fact.user.name.length === 0 ? fact.user.id : `${fact.user.name}(${fact.user.id})`;
  return `[${formatClock(fact.timestamp)}] ${who} #${fact.messageId}: ${fact.content}`;
}

/**
 * A retelling of facts from elsewhere. The common section names where the retold content came from — its own
 * address is where the reader already stands — and every source renders through its own type's rule.
 */
function renderNotification(fact: IshikiNotification): string {
  const [first, ...rest] = fact.sources;
  if (first === undefined) return "";
  const at = sceneOf(first.data);
  const body = [first, ...rest].map((source) => readEvent(source)?.line).filter((line) => line !== undefined);
  const reason = fact.reason.replaceAll('"', "'").replaceAll("\n", " ");
  return `<notification sid="${at.sid}" channel="${at.channelId}" reason="${reason}">${body.join("\n")}</notification>`;
}

// ---------------------------------------------------------------------------
// Event render registry
// ---------------------------------------------------------------------------

/**
 * Type name to render rule, keyed by the declarations themselves: a key cannot be invented, and the payload its
 * renderer receives is the one that type declares. A type with no entry here is invisible (fail-closed).
 */
type EventRenders = { [K in keyof AgentCustomMessage]?: (data: AgentCustomMessage[K]["data"]) => string };

const eventRenders: EventRenders = {
  "ishiki.message.created": renderLine,
  "ishiki.self.message": renderLine,
  "ishiki.message.deleted": (d) => `[${formatClock(d.timestamp)}] #${d.messageId}: (已撤回)`,
  "ishiki.notification": renderNotification,
};

/**
 * Where a fact belongs. Every declared event carries this in its own payload, so it is a field read and not a
 * per-type rule. A record arrives typed as `unknown`, so this is also where that promise gets asserted.
 */
function sceneOf(data: unknown): Focus {
  const fact = data as IshikiEventBase;
  return { sid: fact.sid, channelId: fact.channelId };
}

/** A stream entry after render resolution. */
export interface RenderedLine {
  scene: Focus;
  line: string;
  /** The timestamp of the entry on the stream; the frame cuts its window and orders its segments by it. */
  timestamp: number;
}

/**
 * The registry's one reader. A record's type and payload only relate at runtime — the table's own type holds that
 * promise at the definition, not here — so this is where it gets asserted, once, for the render call and the
 * address read alike.
 */
function readEvent(message: AgentCustomMessage[keyof AgentCustomMessage]): Omit<RenderedLine, "timestamp"> | undefined {
  const render = eventRenders[message.type] as ((data: unknown) => string) | undefined;
  if (render === undefined) return undefined;
  return { scene: sceneOf(message.data), line: render(message.data) };
}

// ---------------------------------------------------------------------------
// Stream reads
// ---------------------------------------------------------------------------

/** The generic loses the narrowing a literal type would give, so the helper owns the one cast. */
export function findLastEntry<T extends keyof AgentCustomEntry>(entries: readonly AgentEntry[], type: T): AgentEntry<T> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === type) return entry as AgentEntry<T>;
  }
  return undefined;
}

/** Everything written since the generation's frame was materialized. */
export function sliceWorkspace(entries: readonly AgentEntry[]): readonly AgentEntry[] {
  const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
  return checkpoint === undefined ? entries : entries.slice(entries.indexOf(checkpoint) + 1);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Reads the entry stream as model context: the frame a checkpoint carries, the state slot, and the facts and
 * traces of the current generation. Reads only; every write and every decision about waking lives elsewhere.
 */
export class ContextEngine {
  constructor(private readonly options: { profile: Profile }) {}

  /** One scene's rendered lines, in stream order. */
  lines(entries: readonly AgentEntry[], scene: Focus): RenderedLine[] {
    const key = sceneKey(scene);
    const out: RenderedLine[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.data;
      if (message.role !== "custom") continue;

      const resolved = readEvent(message);
      if (!resolved) continue;
      if (sceneKey(resolved.scene) !== key) continue;
      out.push({ ...resolved, timestamp: entry.timestamp });
    }
    return out;
  }

  /** The position a stream with no history opens with. */
  openingFrame(focus: Focus): string {
    return [`<frame ${frameHead(focus, formatClock(Date.now()))}>`, "（在此之前没有发生过任何事。）", "</frame>"].join("\n");
  }

  /**
   * Renders the frame text: every admitted scene gets a rolling window of recent facts pulled from the full
   * storage stream. No distinction between "worked in" and "only heard from" — all scenes use the same rule.
   *
   * Scene admission: focus always enters; any scene whose facts appeared in this generation's workspace also enters.
   */
  renderFrame(frameFocus: Focus, entries: readonly AgentEntry[], workspace: readonly AgentEntry[]): string {
    const now = Date.now();
    const here = sceneKey(frameFocus);
    const { historyEntries, sceneWindowMs } = this.options.profile.context;

    // Discover every scene that appeared in this generation (for non-focus admission).
    const scenes = new Map<string, Focus>();
    scenes.set(here, frameFocus);
    for (const entry of workspace) {
      if (entry.type !== "message") continue;
      const message = entry.data;
      if (message.role !== "custom") continue;
      if (eventRenders[message.type] === undefined) continue;
      const scene = sceneOf(message.data);
      const key = sceneKey(scene);
      if (!scenes.has(key)) scenes.set(key, scene);
    }

    // Build one segment per scene, all from storage with the same tail + time-window rule.
    const segments: Array<{ scene: Focus; lines: string[]; dropped: number; latest: number }> = [];
    for (const [key, scene] of scenes) {
      const fresh = this.lines(entries, scene).filter((read) => now - read.timestamp <= sceneWindowMs);
      const kept = fresh.slice(-historyEntries);
      const lines = kept.map((read) => read.line);
      const dropped = Math.max(0, fresh.length - historyEntries);
      const latest = kept.at(-1)?.timestamp ?? 0;
      if (lines.length === 0 && key !== here) continue;
      segments.push({ scene, lines, dropped, latest });
    }

    const parts = [`<frame ${frameHead(frameFocus, formatClock(now))}>`];

    // Focus segment first (always present, even if empty).
    const focus = segments.find((segment) => sceneKey(segment.scene) === here);
    parts.push(`<history sid="${frameFocus.sid}" channel="${frameFocus.channelId}" focus>`);
    if (focus && focus.dropped > 0) parts.push(`<!-- 更早 ${focus.dropped} 条已折叠 -->`);
    parts.push(...(focus?.lines ?? []));
    parts.push("</history>");

    // Other scenes sorted by recency.
    const rest = segments.filter((segment) => sceneKey(segment.scene) !== here).sort((a, b) => b.latest - a.latest);
    for (const segment of rest) {
      parts.push(`<history sid="${segment.scene.sid}" channel="${segment.scene.channelId}">`);
      if (segment.dropped > 0) parts.push(`<!-- 更早 ${segment.dropped} 条已折叠 -->`);
      parts.push(...segment.lines);
      parts.push("</history>");
    }

    parts.push("</frame>");
    return parts.join("\n");
  }

  /**
   * The whole model-visible projection, in the one hook that sees entries. Everything before the last checkpoint
   * already lives inside the frame text, so this walks the current generation only and its cost tracks the
   * generation, not the history. Output is native messages: no render types, no second hook to carry a cursor.
   */
  project(entries: readonly AgentEntry[]): readonly AgentEntry[] {
    const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
    const workspace = sliceWorkspace(entries);
    const out: AgentEntry[] = [];

    if (checkpoint !== undefined) {
      out.push(createEntry("message", createUserMessage(checkpoint.data.text), { id: checkpoint.id, timestamp: checkpoint.timestamp }));
    } else {
      // A generation that never had a frame still has a position: the element a frame opens with, derived from
      // the first entry and the configured focus, so every step of the turn renders the same string.
      const first = workspace[0];
      if (first !== undefined) {
        const head = `<frame ${frameHead(this.options.profile.initialFocus, formatClock(first.timestamp))}/>`;
        out.push(createEntry("message", createUserMessage(head), { id: `frame:${first.id}`, timestamp: first.timestamp }));
      }
    }

    // The generation's own scene. A switch is atomic and starts a new generation, so one generation reads
    // exactly one scene and never reinterprets what it has already rendered.
    const startFocus = checkpoint === undefined ? this.options.profile.initialFocus : checkpoint.data.frameFocus;
    const here = sceneKey(startFocus);

    // The slot sits between the frame and the workspace: re-derived on every step, never stored and never
    // folded. The clock is the one thing the projection reads from outside the stream, quantized to a daypart
    // so its bytes move at most four times a day. Pinned to the entry that opened the segment.
    const anchor = checkpoint ?? workspace[0];
    if (anchor !== undefined) {
      const now = new Date();
      const hour = now.getHours();
      const daypart = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
      const slot = ["<state>", `当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${daypart}`, "</state>"].join("\n");
      out.push(createEntry("message", createUserMessage(slot), { id: `slot:${anchor.id}`, timestamp: workspace.at(-1)?.timestamp ?? anchor.timestamp }));
    }

    // Lines from the open window are bare, so the first one after anything else opens with a header.
    let inWindow = false;
    for (const entry of workspace) {
      if (entry.type !== "message") continue;
      const message = entry.data;
      // Assistant and tool entries pass through untouched: the mind's own behavior is a real message here.
      if (message.role !== "custom") {
        out.push(entry);
        inWindow = false;
        continue;
      }
      // What the mind said is marked by the tool call that sent it, so its own message is projected into a frame
      // and never read back here as somebody else's line in the workspace.
      if (message.type === "ishiki.self.message") continue;
      // Anything that did not happen in the generation's own scene is not read at all.
      const resolved = readEvent(message);
      if (!resolved || sceneKey(resolved.scene) !== here) continue;
      // Fact: bare line, with a header on the first one after anything else.
      const text = !inWindow ? `<focus sid="${resolved.scene.sid}" channel="${resolved.scene.channelId}">\n${resolved.line}` : resolved.line;
      inWindow = true;
      out.push(createEntry("message", createUserMessage(text), { id: message.id, timestamp: message.timestamp }));
    }
    return out;
  }
}
