import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type Ishiki from "../index.js";
import { ManagementError } from "./errors.js";
import type { ManagementEventBus } from "./events.js";
import { baseReference, domainLabel } from "./reference.js";
import type {
  CorruptLine,
  LogEntry,
  RuntimeMeta,
  RuntimeState,
  SessionEntries,
  SessionEntryFilters,
  SessionFilters,
  SessionSummary,
  UsageRecord,
} from "./types.js";

interface SessionRecord {
  id: string;
  profileId: string;
  home: string;
  file: string;
  meta: RuntimeMeta;
  active: boolean;
}

interface FileStats {
  size: number;
  mtimeMs: number;
  entries: number;
  messages: number;
  turns: number;
  tokens: number;
  corrupt: number;
  lastActivity?: number;
}

interface UsageScan {
  size: number;
  mtimeMs: number;
  records: UsageRecord[];
}

const CHUNK = 64 * 1024;

/** 逐行读取 JSONL；只处理回调需要的那段，游标是字节偏移加行号。 */
async function scanLines(
  file: string,
  startOffset: number,
  startLine: number,
  visit: (text: string, offset: number, line: number, nextOffset: number) => boolean | void,
): Promise<void> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    let position = startOffset;
    let line = startLine;
    let lineStart = startOffset;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    while (position < info.size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, info.size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      buffer += decoder.write(chunk.subarray(0, bytesRead));
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const text = raw.replace(/\r$/, "");
        const offset = lineStart;
        lineStart += Buffer.byteLength(raw, "utf8") + 1;
        const stop = visit(text, offset, line, lineStart);
        line++;
        if (stop) return;
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.end();
    if (buffer.length > 0) visit(buffer.replace(/\r$/, ""), lineStart, line, lineStart + Buffer.byteLength(buffer, "utf8"));
  } finally {
    await handle.close();
  }
}

function parseCursor(cursor: string | null | undefined): { offset: number; line: number } {
  if (cursor === undefined || cursor === null || cursor.length === 0) return { offset: 0, line: 1 };
  const [offset, line] = cursor.split(":");
  const parsedOffset = Number(offset);
  const parsedLine = Number(line);
  if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || !Number.isSafeInteger(parsedLine) || parsedLine < 1) {
    throw new ManagementError("invalid", `会话游标无效: ${cursor}`);
  }
  return { offset: parsedOffset, line: parsedLine };
}

function fields(value: unknown): Record<string, unknown> | undefined {
  // JSON 解析结果在边界处没有类型，先确认是普通对象再逐字段检查。
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function textField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface ReadUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cacheReported: boolean;
}

function readUsage(source: unknown): ReadUsage | undefined {
  const usage = fields(source);
  if (usage === undefined) return undefined;
  const inputDetails = fields(usage.inputTokenDetails);
  const outputDetails = fields(usage.outputTokenDetails);
  const input = numberField(usage, "inputTokens");
  const output = numberField(usage, "outputTokens");
  const total = numberField(usage, "totalTokens");
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: numberField(inputDetails, "cacheReadTokens") ?? 0,
    cacheWrite: numberField(inputDetails, "cacheWriteTokens") ?? 0,
    reasoning: numberField(outputDetails, "reasoningTokens") ?? 0,
    total: total ?? (input ?? 0) + (output ?? 0),
    cacheReported: inputDetails?.cacheReadTokens !== undefined || inputDetails?.cacheWriteTokens !== undefined,
  };
}

function entryCost(entry: LogEntry): number {
  if (entry.type !== "message") return 0;
  const message = fields(entry.data);
  if (textField(message, "role") !== "assistant") return 0;
  return readUsage(message?.usage)?.total ?? 0;
}

export class SessionsManager {
  private readonly statsCache = new Map<string, FileStats>();
  private readonly usageCache = new Map<string, UsageScan>();

  constructor(
    private readonly host: Ishiki,
    private readonly events: ManagementEventBus,
  ) {}

  public notifyAppended(record: { id: string; profileId: string }, timestamp = Date.now()): void {
    this.events.emit("sessions.appended", {
      sessionId: record.id,
      profileId: record.profileId,
      runtimeId: record.id,
      timestamp,
    });
  }

  public async list(filters: SessionFilters = {}): Promise<SessionSummary[]> {
    const records = await this.records();
    const limit = filters.limit ?? 200;
    const summaries: SessionSummary[] = [];
    for (const record of records) {
      if (filters.profileId !== undefined && record.profileId !== filters.profileId) continue;
      const stats = await this.statsOf(record.file);
      const summary = this.summaryOf(record, stats);
      if (filters.keyword !== undefined) {
        const haystack = `${summary.id} ${summary.profileId} ${summary.domainLabel}`.toLowerCase();
        if (!haystack.includes(filters.keyword.toLowerCase())) continue;
      }
      if (filters.from !== undefined && (summary.lastActivity ?? 0) < filters.from) continue;
      if (filters.to !== undefined && (summary.lastActivity ?? 0) > filters.to) continue;
      summaries.push(summary);
      if (summaries.length >= limit) break;
    }
    return summaries.sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
  }

  public async read(sessionId: string, cursor: string | null | undefined, limit: number, filters: SessionEntryFilters = {}): Promise<SessionEntries> {
    const record = (await this.records()).find((entry) => entry.id === sessionId);
    if (record === undefined) throw new ManagementError("not-found", `会话不存在: ${sessionId}`);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ManagementError("invalid", "单次读取条数需要在 1 到 500 之间");
    }
    if (!existsSync(record.file)) {
      return {
        sessionId,
        entries: [],
        corrupt: [],
        stats: { entries: 0, messages: 0, turns: 0, tokens: 0, corrupt: 0 },
      };
    }

    const start = parseCursor(cursor);
    const entries: LogEntry[] = [];
    const corrupt: CorruptLine[] = [];
    let nextCursor: string | undefined;
    let lastOffset = start.offset;
    let lastLine = start.line;

    const size = (await stat(record.file)).size;

    await scanLines(record.file, start.offset, start.line, (text, offset, line, nextOffset) => {
      lastOffset = nextOffset;
      lastLine = line + 1;
      if (text.length === 0) return false;
      let entry: LogEntry;
      try {
        entry = JSON.parse(text) as LogEntry;
      } catch (error) {
        corrupt.push({ line, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
      if (!matches(entry, filters)) return false;
      entries.push(entry);
      if (entries.length < limit) return false;
      nextCursor = `${nextOffset}:${line + 1}`;
      return true;
    });

    const stats = await this.statsOf(record.file);
    return {
      sessionId,
      entries,
      corrupt,
      nextCursor: nextCursor ?? (lastOffset < size ? `${lastOffset}:${lastLine}` : undefined),
      stats: {
        entries: stats.entries,
        messages: stats.messages,
        turns: stats.turns,
        tokens: stats.tokens,
        corrupt: stats.corrupt,
      },
    };
  }

  public async stats(sessionId: string): Promise<SessionEntries["stats"]> {
    const record = (await this.records()).find((entry) => entry.id === sessionId);
    if (record === undefined) throw new ManagementError("not-found", `会话不存在: ${sessionId}`);
    const stats = await this.statsOf(record.file);
    return { entries: stats.entries, messages: stats.messages, turns: stats.turns, tokens: stats.tokens, corrupt: stats.corrupt };
  }

  /** 汇总所有会话里可推导出的用量，供用量账本增量记账。 */
  public async usageRecords(): Promise<UsageRecord[]> {
    const records = await this.records();
    const collected: UsageRecord[] = [];
    for (const record of records) {
      collected.push(...(await this.usageOf(record)));
    }
    return collected;
  }

  public async stateOf(sessionId: string, runtimeState: (id: string) => RuntimeState | undefined): Promise<RuntimeState> {
    const record = (await this.records()).find((entry) => entry.id === sessionId);
    if (record === undefined) return "stopped";
    return runtimeState(record.id) ?? (record.active ? "idle" : "stopped");
  }

  private summaryOf(record: SessionRecord, stats: FileStats): SessionSummary {
    return {
      id: record.id,
      profileId: record.profileId,
      runtimeId: record.id,
      domainLabel: domainLabel(record.meta.domain),
      mode: record.meta.domain.mode,
      state: record.active ? "idle" : "stopped",
      entries: stats.entries,
      messages: stats.messages,
      turns: stats.turns,
      tokens: stats.tokens,
      lastActivity: stats.lastActivity,
      file: record.file,
      corrupt: stats.corrupt,
    };
  }

  private async records(): Promise<SessionRecord[]> {
    const records = new Map<string, SessionRecord>();
    for (const [id, runtime] of this.host.runtimes) {
      const meta = await this.readMeta(runtime.home, id);
      records.set(runtime.home, {
        id: meta.id,
        profileId: meta.profileId,
        home: runtime.home,
        file: path.join(runtime.home, "events.jsonl"),
        meta,
        active: true,
      });
    }

    const profilesRoot = path.join(this.host.dataPath, "profiles");
    if (existsSync(profilesRoot)) {
      for (const profileEntry of await readdir(profilesRoot, { withFileTypes: true })) {
        if (!profileEntry.isDirectory()) continue;
        const runtimesRoot = path.join(profilesRoot, profileEntry.name, "runtimes");
        if (!existsSync(runtimesRoot)) continue;
        for (const runtimeEntry of await readdir(runtimesRoot, { withFileTypes: true })) {
          if (!runtimeEntry.isDirectory()) continue;
          const home = path.join(runtimesRoot, runtimeEntry.name);
          if (records.has(home)) continue;
          if (!existsSync(path.join(home, "events.jsonl"))) continue;
          const meta = await this.readMeta(home, `${profileEntry.name}/${runtimeEntry.name}`);
          records.set(home, { id: meta.id, profileId: meta.profileId, home, file: path.join(home, "events.jsonl"), meta, active: false });
        }
      }
    }
    return [...records.values()];
  }

  private async readMeta(home: string, fallbackId: string): Promise<RuntimeMeta> {
    const file = path.join(home, "runtime.json");
    if (existsSync(file)) {
      try {
        const meta = JSON.parse(await readFile(file, "utf8")) as RuntimeMeta;
        if (typeof meta.id === "string" && typeof meta.profileId === "string") return meta;
      } catch {
        // 元数据损坏时用目录结构推断，日志本身仍然可读。
      }
    }
    const profileId = fallbackId.split("/")[0];
    return { id: fallbackId, profileId, domain: { mode: "cross" }, createdAt: 0 };
  }

  private async statsOf(file: string): Promise<FileStats> {
    if (!existsSync(file)) {
      return { size: 0, mtimeMs: 0, entries: 0, messages: 0, turns: 0, tokens: 0, corrupt: 0 };
    }
    const info = await stat(file);
    const cached = this.statsCache.get(file);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
    const stats: FileStats = { size: info.size, mtimeMs: info.mtimeMs, entries: 0, messages: 0, turns: 0, tokens: 0, corrupt: 0 };
    await scanLines(file, 0, 1, (text) => {
      if (text.length === 0) return false;
      let entry: LogEntry;
      try {
        entry = JSON.parse(text) as LogEntry;
      } catch {
        stats.corrupt++;
        return false;
      }
      stats.entries++;
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      if (timestamp !== undefined && (stats.lastActivity === undefined || timestamp > stats.lastActivity)) stats.lastActivity = timestamp;
      if (entry.type === "message") {
        stats.messages++;
        stats.tokens += entryCost(entry);
      }
      if (entry.type === "event" && textField(fields(entry.data), "type") === "turn.done") stats.turns++;
      return false;
    });
    this.statsCache.set(file, stats);
    return stats;
  }

  private async usageOf(record: SessionRecord): Promise<UsageRecord[]> {
    if (!existsSync(record.file)) return [];
    const info = await stat(record.file);
    const cached = this.usageCache.get(record.file);
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.records;

    const collected: UsageRecord[] = [];
    const turnsWithUsage = new Set<string>();
    await scanLines(record.file, 0, 1, (text) => {
      if (text.length === 0) return false;
      let entry: LogEntry;
      try {
        entry = JSON.parse(text) as LogEntry;
      } catch {
        return false;
      }
      const data = fields(entry.data);
      if (entry.type === "message") {
        if (textField(data, "role") !== "assistant") return false;
        if (entry.turnId !== undefined) turnsWithUsage.add(entry.turnId);
        collected.push(
          this.usageRecord(record, entry, { provider: textField(data, "provider"), modelId: textField(data, "modelId"), usage: readUsage(data?.usage) }),
        );
      } else if (entry.type === "event") {
        if (textField(data, "type") !== "turn.done") return false;
        const usage = readUsage(data?.totalUsage);
        if (usage === undefined) return false;
        const turnId = textField(data, "turnId") ?? entry.turnId ?? "turn";
        if (turnsWithUsage.has(turnId)) return false;
        collected.push(this.usageRecord(record, entry, { usage }, `turn:${turnId}`, "turn"));
      }
      return false;
    });
    this.usageCache.set(record.file, { size: info.size, mtimeMs: info.mtimeMs, records: collected });
    return collected;
  }

  private usageRecord(
    record: SessionRecord,
    entry: LogEntry,
    details: { provider?: string; modelId?: string; usage?: ReadUsage },
    suffix?: string,
    source: UsageRecord["source"] = "message",
  ): UsageRecord {
    const usage = details.usage;
    const reference = baseReference(details.modelId ?? record.meta.model ?? "unknown");
    const [provider, modelId] = reference.split(":");
    return {
      id: `${record.id}:${entry.id}${suffix === undefined ? "" : `:${suffix}`}`,
      timestamp: entry.timestamp,
      profileId: record.profileId,
      runtimeId: record.id,
      sessionId: record.id,
      provider: details.provider ?? provider ?? "unknown",
      modelId: details.modelId ?? modelId ?? "unknown",
      reference,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      reasoning: usage?.reasoning ?? 0,
      total: usage?.total ?? 0,
      source,
      cacheReported: usage?.cacheReported ?? false,
    };
  }
}

function matches(entry: LogEntry, filters: SessionEntryFilters): boolean {
  if (filters.from !== undefined && entry.timestamp < filters.from) return false;
  if (filters.to !== undefined && entry.timestamp > filters.to) return false;
  if (filters.role !== undefined) {
    const role = entry.type === "message" ? textField(fields(entry.data), "role") : entry.type;
    if (role !== filters.role) return false;
  }
  if (filters.keyword !== undefined && filters.keyword.length > 0) {
    const haystack = JSON.stringify(entry.data).toLowerCase();
    if (!haystack.includes(filters.keyword.toLowerCase())) return false;
  }
  return true;
}
