import path from "node:path";

import { createEntry, createJsonlStorage, type AgentEntry } from "@yesimagent/core";

import type { AttachmentItem, ImageLifetime, IshikiTaskRecord, TerminalTaskState } from "../../../types/messages.js";

const TERMINAL: Record<TerminalTaskState, true> = { succeeded: true, failed: true, cancelled: true, interrupted: true };
const LIFETIME: Record<ImageLifetime, true> = { once: true, recent: true, retain: true };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(line: number, detail: string): never {
  throw new TypeError(`codemode task ledger line ${line}: ${detail}`);
}

function readItems(value: unknown, line: number): AttachmentItem[] {
  if (!Array.isArray(value)) malformed(line, "items must be an array");
  return value.map((item, index) => {
    if (!isObject(item) || typeof item.url !== "string" || typeof item.mediaType !== "string") {
      malformed(line, `items[${index}] needs a url and a media type`);
    }
    const { url, mediaType, filename, byteLength, lifetime } = item;
    if (filename !== undefined && typeof filename !== "string") malformed(line, `items[${index}].filename must be a string`);
    if (byteLength !== undefined && typeof byteLength !== "number") malformed(line, `items[${index}].byteLength must be a number`);
    if (lifetime !== undefined && (typeof lifetime !== "string" || LIFETIME[lifetime as ImageLifetime] !== true)) {
      malformed(line, `items[${index}].lifetime must be once, recent, or retain`);
    }
    return {
      url,
      mediaType,
      ...(filename === undefined ? {} : { filename }),
      ...(byteLength === undefined ? {} : { byteLength }),
      ...(lifetime === undefined ? {} : { lifetime: lifetime as ImageLifetime }),
    };
  });
}

/** Rebuild a record from disk with every field checked; a damaged ledger fails loudly instead of half-loading. */
function readRecord(entry: AgentEntry, line: number): IshikiTaskRecord {
  if (entry.type !== "ishiki.task.record") malformed(line, `unexpected entry type ${JSON.stringify(entry.type)}`);
  const data: unknown = entry.data;
  if (!isObject(data)) malformed(line, "record must be an object");
  if (typeof data.id !== "string" || data.id.length === 0) malformed(line, "record needs an id");
  if (data.kind === "start") {
    if (typeof data.toolName !== "string" || typeof data.startedAt !== "number") malformed(line, "start record needs a tool name and a start time");
    return { kind: "start", id: data.id, toolName: data.toolName, startedAt: data.startedAt };
  }
  if (data.kind !== "terminal") malformed(line, "record kind must be start or terminal");
  if (typeof data.state !== "string" || TERMINAL[data.state as TerminalTaskState] !== true) malformed(line, "terminal record needs a terminal state");
  if (typeof data.finishedAt !== "number") malformed(line, "terminal record needs a finish time");
  if (data.text !== undefined && typeof data.text !== "string") malformed(line, "text must be a string");
  if (data.error !== undefined && typeof data.error !== "string") malformed(line, "error must be a string");
  return {
    kind: "terminal",
    id: data.id,
    state: data.state as TerminalTaskState,
    finishedAt: data.finishedAt,
    ...(data.text === undefined ? {} : { text: data.text }),
    ...(data.error === undefined ? {} : { error: data.error }),
    ...(data.items === undefined ? {} : { items: readItems(data.items, line) }),
  };
}

export interface TaskStore {
  /** All records in file order: every start precedes the terminal record with the same id. */
  read(): Promise<IshikiTaskRecord[]>;
  /** Appends are serialized, so the start of a task is always written before its terminal record. */
  append(record: IshikiTaskRecord): Promise<void>;
}

export function createTaskStore(home: string): TaskStore {
  const storage = createJsonlStorage(path.join(home, "codemode-tasks.jsonl"));
  let tail: Promise<void> = Promise.resolve();
  return {
    async read() {
      return (await storage.read()).map((entry, index) => readRecord(entry, index + 1));
    },
    append(record) {
      const write = tail.then(async () => {
        await storage.append(createEntry("ishiki.task.record", record));
      });
      tail = write.catch(() => {});
      return write;
    },
  };
}
