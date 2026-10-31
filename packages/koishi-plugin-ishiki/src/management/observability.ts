import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type Ishiki from "../index.js";
import { ResourceStore } from "../resource/store.js";
import { writeAtomic } from "./atomic.js";
import { baseReference } from "./reference.js";
import type { SessionsManager } from "./sessions.js";
import type { CacheSnapshot, PromptCacheRow, ResourceCacheRow, UsageFilters, UsageRecord, UsageSnapshot, UsageTotals } from "./types.js";

/** 会话标识可能来自目录名或运行时标识，用条目本身的主键去重。 */
function usageKey(record: UsageRecord): string {
  const tail = record.id.slice(record.id.lastIndexOf(":") + 1);
  return `${record.source}:${tail}`;
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

    const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, calls: records.length };
    const models = new Map<string, { reference: string; input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }>();
    const days = new Map<string, { day: string; input: number; output: number; total: number; calls: number }>();
    const quality = new Map<string, number>();
    const bump = (reason: string): void => void quality.set(reason, (quality.get(reason) ?? 0) + 1);

    for (const record of records) {
      totals.input += record.input;
      totals.output += record.output;
      totals.cacheRead += record.cacheRead;
      totals.cacheWrite += record.cacheWrite;
      totals.reasoning += record.reasoning;
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

      if (record.source === "missing") bump("响应缺少用量字段");
      if (record.source === "turn") bump("由轮次汇总推导");
      if (!record.cacheReported) bump("缺少缓存字段");
      if (record.total === 0) bump("用量为零");
    }

    return {
      records: records.sort((left, right) => right.timestamp - left.timestamp),
      totals,
      byModel: [...models.values()].sort((left, right) => right.input + right.output - (left.input + left.output)),
      byDay: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
      quality: [...quality.entries()].map(([reason, count]) => ({ reason, count })),
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

export class CacheReporter {
  constructor(
    private readonly host: Ishiki,
    private readonly sessions: SessionsManager,
    private readonly usage: UsageLedger,
  ) {}

  public async read(): Promise<CacheSnapshot> {
    const sessions = await this.sessions.list({ limit: 1000 });
    const resources: ResourceCacheRow[] = [];
    for (const session of sessions) {
      const runtime = this.host.runtimes.get(session.id);
      const store = runtime?.resources.store ?? new ResourceStore(path.dirname(session.file));
      try {
        const assets = await store.list("asset");
        const artifacts = await store.list("artifact");
        const bytes = [...assets, ...artifacts].reduce((sum, meta) => sum + (meta.byteLength ?? 0), 0);
        resources.push({
          runtimeId: session.id,
          profileId: session.profileId,
          status: assets.length + artifacts.length === 0 ? "empty" : "ok",
          assets: assets.length,
          artifacts: artifacts.length,
          bytes,
        });
      } catch (error) {
        resources.push({
          runtimeId: session.id,
          profileId: session.profileId,
          status: "error",
          assets: 0,
          artifacts: 0,
          bytes: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const usage = await this.usage.snapshot();
    const prompt: PromptCacheRow[] = usage.byModel.map((row) => {
      const records = usage.records.filter((record) => record.reference === row.reference);
      return {
        reference: row.reference,
        modelId: records[0]?.modelId ?? "unknown",
        calls: row.calls,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        cacheReported: records.some((record) => record.cacheReported),
      };
    });

    if (sessions.length === 0) {
      return { status: "empty", collectedAt: Date.now(), prompt, resources, reason: "还没有会话，尚未采集缓存数据" };
    }
    if (resources.every((row) => row.status === "error")) {
      return { status: "unavailable", collectedAt: Date.now(), prompt, resources, reason: "资源缓存读取失败" };
    }
    return {
      status: resources.some((row) => row.status === "ok") || prompt.length > 0 ? "ok" : "empty",
      collectedAt: Date.now(),
      prompt,
      resources,
    };
  }
}
