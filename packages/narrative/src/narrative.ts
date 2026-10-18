import type { JSONValue } from "@yesimagent/core";

export type NarrativeNext =
  | { kind: "action" }
  | { kind: "stop" }
  | { kind: "reply"; target?: { sid: string; channelId: string }; mode?: "element" | "raw"; continue?: boolean };

export type NarrativeInput = {
  kind: "input";
  inputEntryIds: string[];
  compact?: { throughOriginMessageId: string; targetChars: number };
};

export type NarrativeDelta = { kind: "delta"; inputEntryIds: string[]; next: NarrativeNext };
export type NarrativeSummary = { kind: "summary"; throughOriginMessageId: string };
export type NarrativeMarker = NarrativeInput | NarrativeDelta | NarrativeSummary;
export type NarrativeEntryData = { originMessageId: string; script: string } & (NarrativeDelta | NarrativeSummary);

// The marked assistant part is the durable source; these entries are its
// idempotent narrative projection in the same session ledger.
declare module "@yesimagent/core" {
  interface AgentCustomEntry {
    "ishiki.narrative": NarrativeEntryData;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseNarrativeNext(value: unknown): NarrativeNext {
  if (!record(value)) throw new Error("narrative next must be an object");
  if (value.kind === "action" || value.kind === "stop") return { kind: value.kind };
  if (value.kind !== "reply") throw new Error("narrative next.kind must be action, reply, or stop");

  const next: Extract<NarrativeNext, { kind: "reply" }> = { kind: "reply" };
  if (value.target !== undefined) {
    if (
      !record(value.target) ||
      typeof value.target.sid !== "string" ||
      value.target.sid.length === 0 ||
      typeof value.target.channelId !== "string" ||
      value.target.channelId.length === 0
    ) {
      throw new Error("narrative reply target requires sid and channelId");
    }
    next.target = { sid: value.target.sid, channelId: value.target.channelId };
  }
  if (value.mode !== undefined) {
    if (value.mode !== "element" && value.mode !== "raw") throw new Error("narrative reply mode must be element or raw");
    next.mode = value.mode;
  }
  if (value.continue !== undefined) {
    if (typeof value.continue !== "boolean") throw new Error("narrative reply continue must be boolean");
    next.continue = value.continue;
  }
  return next;
}

export function narrativeOptions(marker: NarrativeMarker): Record<string, Record<string, JSONValue>> {
  return { ishiki: { narrative: marker as unknown as JSONValue } };
}

export function readNarrativeMarker(options: unknown): NarrativeMarker | undefined {
  if (!record(options) || !record(options.ishiki) || options.ishiki.narrative === undefined) return undefined;
  const marker = options.ishiki.narrative;
  if (!record(marker)) throw new Error("invalid narrative metadata");
  if (marker.kind === "summary") {
    if (typeof marker.throughOriginMessageId !== "string" || marker.throughOriginMessageId.length === 0) throw new Error("narrative summary has no origin");
    return { kind: "summary", throughOriginMessageId: marker.throughOriginMessageId };
  }
  if (marker.kind !== "input" && marker.kind !== "delta") throw new Error("invalid narrative metadata kind");
  if (!Array.isArray(marker.inputEntryIds) || !marker.inputEntryIds.every((id: unknown) => typeof id === "string"))
    throw new Error("narrative metadata requires input entry ids");
  const inputEntryIds = marker.inputEntryIds as string[];
  if (marker.kind === "delta") return { kind: "delta", inputEntryIds, next: parseNarrativeNext(marker.next) };
  const input: NarrativeInput = { kind: "input", inputEntryIds };
  if (marker.compact !== undefined) {
    const compact = marker.compact;
    if (
      !record(compact) ||
      typeof compact.throughOriginMessageId !== "string" ||
      compact.throughOriginMessageId.length === 0 ||
      typeof compact.targetChars !== "number" ||
      !Number.isFinite(compact.targetChars) ||
      compact.targetChars <= 0
    ) {
      throw new Error("invalid narrative compaction request");
    }
    input.compact = { throughOriginMessageId: compact.throughOriginMessageId, targetChars: compact.targetChars };
  }
  return input;
}
