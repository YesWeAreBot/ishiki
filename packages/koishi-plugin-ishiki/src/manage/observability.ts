import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeAtomic } from "./atomic.js";
import { baseReference } from "./reference.js";
import type { SessionsManager } from "./sessions.js";
import type { UsageFilters, UsageRecord, UsageSnapshot, UsageTotals } from "./types.js";

/** 运行时前缀可能写法不同，用条目尾部标识去重；轮次汇总保留 turn 前缀避免与普通条目冲突。 */
function usageKey(record: UsageRecord): string {
  const turn = record.id.lastIndexOf(":turn:");
  if (turn >= 0) return record.id.slice(turn + 1);
  return record.id.slice(record.id.lastIndexOf(":") + 1);
}

export class UsageLedger {
  private readonly file: string;
  private cache: { size: number; mtimeMs: number; records: UsageRecord[] } | undefined;
  private pending: Promise<number> | undefined;
  private syncedAt = 0;

  constructor(
    dataPath: string,
    private readonly sessions: SessionsManager,
  ) {
    this.file = path.join(dataPath, "usage.jsonl");
  }

  public sync(): Promise<number> {
    this.pending ??= this.syncOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async syncOnce(): Promise<number> {
    const scanned = await this.sessions.usageRecords();
    const current = new Map<string, UsageRecord>();
    for (const record of await this.load()) current.set(usageKey(record), record);
    let fresh = 0;
    let dirty = false;
    for (const record of scanned) {
      const key = usageKey(record);
      const previous = current.get(key);
      if (previous === undefined) fresh++;
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(record)) {
        current.set(key, record);
        dirty = true;
      }
    }
    if (dirty) {
      const rows = [...current.values()].sort((left, right) => left.timestamp - right.timestamp);
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomic(this.file, rows.map((record) => `${JSON.stringify(record)}\n`).join(""));
      this.cache = undefined;
    }
    this.syncedAt = Date.now();
    return fresh;
  }

  public async snapshot(filters: UsageFilters = {}): Promise<UsageSnapshot> {
    const wanted = filters.model === undefined ? undefined : baseReference(filters.model);
    const records = (await this.load()).filter((record) => {
      if (filters.profileId !== undefined && record.profileId !== filters.profileId) return false;
      if (wanted !== undefined && baseReference(record.reference) !== wanted && baseReference(record.modelId) !== wanted) return false;
      if (filters.from !== undefined && record.timestamp < filters.from) return false;
      if (filters.to !== undefined && record.timestamp > filters.to) return false;
      return true;
    });

    const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: records.length };
    const models = new Map<string, { reference: string; input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }>();
    const days = new Map<string, { day: string; input: number; output: number; total: number; calls: number }>();

    for (const record of records) {
      totals.input += record.input;
      totals.output += record.output;
      totals.cacheRead += record.cacheRead;
      totals.cacheWrite += record.cacheWrite;
      totals.total += record.total;

      const model = models.get(record.reference) ?? { reference: record.reference, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      model.input += record.input;
      model.output += record.output;
      model.cacheRead += record.cacheRead;
      model.cacheWrite += record.cacheWrite;
      model.calls++;
      models.set(record.reference, model);

      const day = new Date(record.timestamp).toISOString().slice(0, 10);
      const daily = days.get(day) ?? { day, input: 0, output: 0, total: 0, calls: 0 };
      daily.input += record.input;
      daily.output += record.output;
      daily.total += record.total;
      daily.calls++;
      days.set(day, daily);
    }

    return {
      records: records.sort((left, right) => right.timestamp - left.timestamp),
      totals,
      byModel: [...models.values()].sort((left, right) => right.input + right.output - (left.input + left.output)),
      byDay: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
      syncedAt: this.syncedAt,
    };
  }

  private async load(): Promise<UsageRecord[]> {
    if (!existsSync(this.file)) return [];
    const info = await stat(this.file);
    if (this.cache !== undefined && this.cache.size === info.size && this.cache.mtimeMs === info.mtimeMs) return this.cache.records;
    const text = await readFile(this.file, "utf8");
    const records: UsageRecord[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line) as UsageRecord;
        record.reference = baseReference(record.reference);
        const key = usageKey(record);
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      } catch {
        // 损坏行跳过，其余用量仍然可用。
      }
    }
    this.cache = { size: info.size, mtimeMs: info.mtimeMs, records };
    return records;
  }
}
