import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizePackName } from "./config.js";
import type {
  BlacklistRecord,
  CategoryCount,
  PackSummary,
  ReviewDecision,
  ReviewFacts,
  ReviewQueueSnapshot,
  StickerListQuery,
  StickerListResult,
  StickerRecord,
  StickerSearchHit,
  StickerSourceInfo,
  StickerStatus,
  StickerUpdatePatch,
} from "./types.js";

interface RawStickerRow {
  rowid: number;
  id: string;
  sha256: string;
  pack: string;
  status: string;
  mime: string;
  ext: string;
  size: number;
  width: number;
  height: number;
  category: string;
  tags: string;
  description: string;
  ocr_text: string;
  character_name: string;
  work_name: string;
  emotions: string;
  scenes: string;
  source: string;
  usage_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  embedding_model: string | null;
  embedding: Uint8Array | null;
}

export interface SaveStickerParams {
  sha256: string;
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  pack: string;
  status: StickerStatus;
  category: string;
  tags: string[];
  description: string;
  ocrText: string;
  characterName: string;
  workName: string;
  emotions: string[];
  scenes: string[];
  source: StickerSourceInfo;
  embeddingModel?: string | null;
  embedding?: Float32Array | null;
}

export type SaveStickerOutcome = { status: "created"; sticker: StickerRecord } | { status: "duplicate"; sticker: StickerRecord };

export interface SearchStickersParams {
  packs: string[];
  query?: string;
  category?: string;
  character?: string;
  limit?: number;
  queryEmbedding?: Float32Array;
  embeddingModel?: string;
}

export class StickerStore {
  public readonly db: DatabaseSync;
  public readonly filesDir: string;
  private savepointSeq = 0;

  public constructor(public readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    this.filesDir = path.join(rootDir, "files");
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(rootDir, "stickers.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        pack TEXT NOT NULL,
        status TEXT NOT NULL,
        mime TEXT NOT NULL,
        ext TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        category TEXT NOT NULL,
        tags TEXT NOT NULL,
        description TEXT NOT NULL,
        ocr_text TEXT NOT NULL,
        character_name TEXT NOT NULL,
        work_name TEXT NOT NULL,
        emotions TEXT NOT NULL,
        scenes TEXT NOT NULL,
        source TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        embedding_model TEXT,
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_stickers_pack_status ON stickers(pack, status);
      CREATE INDEX IF NOT EXISTS idx_stickers_category ON stickers(category);
      CREATE INDEX IF NOT EXISTS idx_stickers_updated ON stickers(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS stickers_fts USING fts5(
        id UNINDEXED,
        search_text,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        sha256 TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_cache (
        cache_key TEXT PRIMARY KEY,
        approved INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    this.migrateLegacyFtsIfNeeded();
  }

  private migrateLegacyFtsIfNeeded(): void {
    const ftsDef = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stickers_fts'").get() as { sql?: string } | undefined;
    if (!ftsDef?.sql) return;
    const hasLegacyContent = /content\s*=\s*['"]?stickers['"]?/i.test(ftsDef.sql);
    const hasIdColumn = /\bid\s+UNINDEXED\b/i.test(ftsDef.sql);
    if (!hasLegacyContent && hasIdColumn) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS stickers_fts;
        CREATE VIRTUAL TABLE stickers_fts USING fts5(
          id UNINDEXED,
          search_text,
          tokenize='trigram'
        );
      `);
      const rows = this.db.prepare("SELECT rowid, * FROM stickers").all() as unknown as RawStickerRow[];
      const insertStmt = this.db.prepare("INSERT INTO stickers_fts(id, search_text) VALUES (?, ?)");
      for (const row of rows) {
        insertStmt.run(row.id, buildSearchText(toRecord(row)));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void {
    this.db.close();
  }

  public filePathFor(sha256: string, ext: string): string {
    return path.join(this.filesDir, `${sha256}.${ext}`);
  }

  public readBytes(sticker: Pick<StickerRecord, "sha256" | "ext">): Uint8Array {
    return new Uint8Array(fs.readFileSync(this.filePathFor(sticker.sha256, sticker.ext)));
  }

  public readBytesBySha(sha256: string): { bytes: Uint8Array; mime: string } | undefined {
    const row = this.db.prepare("SELECT sha256, ext, mime FROM stickers WHERE sha256 = ?").get(sha256) as
      | { sha256: string; ext: string; mime: string }
      | undefined;
    if (!row) return undefined;
    const filePath = this.filePathFor(row.sha256, row.ext);
    if (!fs.existsSync(filePath)) return undefined;
    return { bytes: new Uint8Array(fs.readFileSync(filePath)), mime: row.mime };
  }

  public isBlacklisted(sha256: string): BlacklistRecord | undefined {
    const row = this.db.prepare("SELECT sha256, reason, created_at FROM blacklist WHERE sha256 = ?").get(sha256) as
      | { sha256: string; reason: string; created_at: number }
      | undefined;
    if (!row) return undefined;
    return { sha256: row.sha256, reason: row.reason, createdAt: row.created_at };
  }

  public listBlacklist(limit = 200): BlacklistRecord[] {
    const rows = this.db.prepare("SELECT sha256, reason, created_at FROM blacklist ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{
      sha256: string;
      reason: string;
      created_at: number;
    }>;
    return rows.map((row) => ({ sha256: row.sha256, reason: row.reason, createdAt: row.created_at }));
  }

  public unban(sha256: string): boolean {
    const result = this.db.prepare("DELETE FROM blacklist WHERE sha256 = ?").run(sha256);
    return Number(result.changes) > 0;
  }

  public getCachedReview(sha256: string, facts?: ReviewFacts): ReviewDecision | undefined {
    const key = reviewCacheKey(sha256, facts);
    const row = this.db.prepare("SELECT result_json FROM review_cache WHERE cache_key = ?").get(key) as { result_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.result_json) as ReviewDecision;
      return { ...parsed, cached: true };
    } catch {
      return undefined;
    }
  }

  public putCachedReview(sha256: string, facts: ReviewFacts | undefined, decision: ReviewDecision): void {
    const key = reviewCacheKey(sha256, facts);
    this.db
      .prepare("INSERT OR REPLACE INTO review_cache (cache_key, approved, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(key, decision.approved ? 1 : 0, JSON.stringify({ ...decision, cached: false }), Date.now());
  }

  public getByIdOrPrefix(idOrPrefix: string, packs?: string[]): StickerRecord | undefined {
    const needle = idOrPrefix.trim().toLowerCase();
    if (!needle) return undefined;
    const exact = this.db.prepare("SELECT rowid, * FROM stickers WHERE id = ? OR sha256 = ?").get(needle, needle) as RawStickerRow | undefined;
    if (exact && (!packs || packs.includes(exact.pack))) return toRecord(exact);
    if (needle.length >= 4) {
      const escaped = `${escapeLike(needle)}%`;
      const rows = this.db
        .prepare("SELECT rowid, * FROM stickers WHERE id LIKE ? ESCAPE '\\' OR sha256 LIKE ? ESCAPE '\\' LIMIT 5")
        .all(escaped, escaped) as unknown as RawStickerRow[];
      const filtered = packs ? rows.filter((row) => packs.includes(row.pack)) : rows;
      if (filtered.length === 1) return toRecord(filtered[0]!);
    }
    return undefined;
  }

  public getBySha256(sha256: string): StickerRecord | undefined {
    const row = this.db.prepare("SELECT rowid, * FROM stickers WHERE sha256 = ?").get(sha256) as RawStickerRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  public countTotal(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM stickers").get() as { count: number };
    return Number(row.count);
  }

  public save(params: SaveStickerParams): SaveStickerOutcome {
    const existing = this.db.prepare("SELECT rowid, * FROM stickers WHERE sha256 = ?").get(params.sha256) as RawStickerRow | undefined;
    const pack = normalizePackName(params.pack, "default");
    const now = Date.now();

    if (existing) {
      const mergedTags = normalizeList([...parseJsonList(existing.tags), ...params.tags], 16);
      const mergedEmotions = normalizeList([...parseJsonList(existing.emotions), ...params.emotions], 8);
      const mergedScenes = normalizeList([...parseJsonList(existing.scenes), ...params.scenes], 8);
      const nextCategory = existing.category && existing.category !== "未分类" ? existing.category : normalizeText(params.category, 48) || "未分类";
      const nextCharacter = existing.character_name || normalizeText(params.characterName, 64);
      const nextWork = existing.work_name || normalizeText(params.workName, 64);
      const nextOcr = existing.ocr_text || normalizeText(params.ocrText, 160);
      const nextDesc = existing.description || normalizeText(params.description, 240);

      this.withSavepoint(() => {
        this.db
          .prepare(
            `UPDATE stickers
             SET category = ?, tags = ?, description = ?, ocr_text = ?, character_name = ?, work_name = ?, emotions = ?, scenes = ?, updated_at = ?
             WHERE rowid = ?`,
          )
          .run(
            nextCategory,
            JSON.stringify(mergedTags),
            nextDesc,
            nextOcr,
            nextCharacter,
            nextWork,
            JSON.stringify(mergedEmotions),
            JSON.stringify(mergedScenes),
            now,
            existing.rowid,
          );
        this.syncFts(existing.id);
      });
      const updated = this.getByIdOrPrefix(existing.id)!;
      return { status: "duplicate", sticker: updated };
    }

    const fileExistedBefore = fs.existsSync(this.filePathFor(params.sha256, params.ext));
    this.writeFileAtomic(params.sha256, params.ext, params.bytes);
    const id = this.allocateId(params.sha256);
    const category = normalizeText(params.category, 48) || "未分类";
    const tags = normalizeList(params.tags, 16);
    const emotions = normalizeList(params.emotions, 8);
    const scenes = normalizeList(params.scenes, 8);
    const description = normalizeText(params.description, 240);
    const ocrText = normalizeText(params.ocrText, 160);
    const characterName = normalizeText(params.characterName, 64);
    const workName = normalizeText(params.workName, 64);
    const embeddingBlob = params.embedding ? float32ToBuffer(params.embedding) : null;

    try {
      this.withSavepoint(() => {
        this.db
          .prepare(
            `INSERT INTO stickers (
              id, sha256, pack, status, mime, ext, size, width, height,
              category, tags, description, ocr_text, character_name, work_name,
              emotions, scenes, source, usage_count, last_used_at, created_at, updated_at,
              embedding_model, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
          )
          .run(
            id,
            params.sha256,
            pack,
            params.status,
            params.mime,
            params.ext,
            params.bytes.byteLength,
            params.width,
            params.height,
            category,
            JSON.stringify(tags),
            description,
            ocrText,
            characterName,
            workName,
            JSON.stringify(emotions),
            JSON.stringify(scenes),
            JSON.stringify(params.source),
            now,
            now,
            params.embeddingModel ?? null,
            embeddingBlob,
          );
        this.syncFts(id);
      });
    } catch (error) {
      if (!fileExistedBefore) this.removeFileIfExists(params.sha256, params.ext);
      throw error;
    }

    return { status: "created", sticker: this.getByIdOrPrefix(id)! };
  }

  public update(id: string, patch: StickerUpdatePatch, embeddingUpdate?: { model: string | null; vector: Float32Array | null }): StickerRecord | undefined {
    const existing = this.db.prepare("SELECT rowid, * FROM stickers WHERE id = ?").get(id) as RawStickerRow | undefined;
    if (!existing) return undefined;

    const pack = patch.pack !== undefined ? normalizePackName(String(patch.pack), existing.pack) : existing.pack;
    const status: StickerStatus = patch.status === "active" || patch.status === "pending" ? patch.status : existing.status === "pending" ? "pending" : "active";
    const category = patch.category !== undefined ? normalizeText(String(patch.category), 48) || "未分类" : existing.category;
    const tags = patch.tags !== undefined ? normalizeList(patch.tags, 16) : parseJsonList(existing.tags);
    const description = patch.description !== undefined ? normalizeText(String(patch.description), 240) : existing.description;
    const ocrText = patch.ocrText !== undefined ? normalizeText(String(patch.ocrText), 160) : existing.ocr_text;
    const characterName = patch.characterName !== undefined ? normalizeText(String(patch.characterName), 64) : existing.character_name;
    const workName = patch.workName !== undefined ? normalizeText(String(patch.workName), 64) : existing.work_name;
    const emotions = patch.emotions !== undefined ? normalizeList(patch.emotions, 8) : parseJsonList(existing.emotions);
    const scenes = patch.scenes !== undefined ? normalizeList(patch.scenes, 8) : parseJsonList(existing.scenes);
    const now = Date.now();
    const nextEmbeddingModel = embeddingUpdate === undefined ? existing.embedding_model : embeddingUpdate.model;
    const nextEmbedding = embeddingUpdate === undefined ? existing.embedding : embeddingUpdate.vector ? float32ToBuffer(embeddingUpdate.vector) : null;

    this.withSavepoint(() => {
      this.db
        .prepare(
          `UPDATE stickers
           SET pack = ?, status = ?, category = ?, tags = ?, description = ?, ocr_text = ?,
               character_name = ?, work_name = ?, emotions = ?, scenes = ?, updated_at = ?,
               embedding_model = ?, embedding = ?
           WHERE rowid = ?`,
        )
        .run(
          pack,
          status,
          category,
          JSON.stringify(tags),
          description,
          ocrText,
          characterName,
          workName,
          JSON.stringify(emotions),
          JSON.stringify(scenes),
          now,
          nextEmbeddingModel,
          nextEmbedding,
          existing.rowid,
        );

      this.syncFts(existing.id);
    });
    return this.getByIdOrPrefix(id);
  }

  public setEmbedding(id: string, model: string, vector: Float32Array): void {
    this.db.prepare("UPDATE stickers SET embedding_model = ?, embedding = ?, updated_at = ? WHERE id = ?").run(model, float32ToBuffer(vector), Date.now(), id);
  }

  public markUsed(id: string): void {
    const now = Date.now();
    this.db.prepare("UPDATE stickers SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  }

  private deleteRowOnly(id: string): { sha256: string; ext: string } | undefined {
    const existing = this.db.prepare("SELECT rowid, id, sha256, ext FROM stickers WHERE id = ?").get(id) as
      | { rowid: number; id: string; sha256: string; ext: string }
      | undefined;
    if (!existing) return undefined;
    this.withSavepoint(() => {
      this.deleteFts(existing.id);
      this.db.prepare("DELETE FROM stickers WHERE rowid = ?").run(existing.rowid);
    });
    return { sha256: existing.sha256, ext: existing.ext };
  }

  public delete(id: string): boolean {
    const removed = this.deleteRowOnly(id);
    if (!removed) return false;
    this.removeFileIfExists(removed.sha256, removed.ext);
    return true;
  }

  private banRowOnly(idOrSha: string, reason = "manual_ban"): { sha256: string; ext: string } | undefined {
    const existing = this.db.prepare("SELECT rowid, id, sha256, ext FROM stickers WHERE id = ? OR sha256 = ?").get(idOrSha, idOrSha) as
      | { rowid: number; id: string; sha256: string; ext: string }
      | undefined;
    if (!existing) return undefined;
    const now = Date.now();
    this.withSavepoint(() => {
      this.db.prepare("INSERT OR REPLACE INTO blacklist (sha256, reason, created_at) VALUES (?, ?, ?)").run(existing.sha256, reason, now);
      this.deleteFts(existing.id);
      this.db.prepare("DELETE FROM stickers WHERE rowid = ?").run(existing.rowid);
    });
    return { sha256: existing.sha256, ext: existing.ext };
  }

  public ban(idOrSha: string, reason = "manual_ban"): boolean {
    const removed = this.banRowOnly(idOrSha, reason);
    if (!removed) return false;
    this.removeFileIfExists(removed.sha256, removed.ext);
    return true;
  }

  public batch(action: "approve" | "delete" | "ban" | "movePack" | "setCategory", ids: string[], value?: string): { affected: number } {
    const cleanIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 500) : [];
    if (cleanIds.length === 0) return { affected: 0 };

    let affected = 0;
    const filesToDelete: Array<{ sha256: string; ext: string }> = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of cleanIds) {
        switch (action) {
          case "approve": {
            if (this.update(id, { status: "active" })) affected += 1;
            break;
          }
          case "delete": {
            const removed = this.deleteRowOnly(id);
            if (removed) {
              filesToDelete.push(removed);
              affected += 1;
            }
            break;
          }
          case "ban": {
            const removed = this.banRowOnly(id, value || "batch_ban");
            if (removed) {
              filesToDelete.push(removed);
              affected += 1;
            }
            break;
          }
          case "movePack": {
            const target = normalizePackName(value, "");
            if (target && this.update(id, { pack: target })) affected += 1;
            break;
          }
          case "setCategory": {
            const category = normalizeText(value ?? "", 48);
            if (category && this.update(id, { category })) affected += 1;
            break;
          }
          default:
            break;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const file of filesToDelete) {
      this.removeFileIfExists(file.sha256, file.ext);
    }
    return { affected };
  }

  public listCategories(packs?: string[], status: StickerStatus | "all" = "active"): CategoryCount[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (status !== "all") {
      clauses.push("status = ?");
      params.push(status);
    }
    if (packs && packs.length > 0) {
      clauses.push(`pack IN (${packs.map(() => "?").join(", ")})`);
      params.push(...packs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT category, COUNT(*) AS count FROM stickers ${where} GROUP BY category ORDER BY count DESC, category ASC`)
      .all(...params) as Array<{ category: string; count: number }>;
    return rows.map((row) => ({ category: row.category, count: Number(row.count) }));
  }

  public listPacks(): PackSummary[] {
    const rows = this.db
      .prepare(
        `SELECT pack,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
                COUNT(*) AS totalCount
         FROM stickers
         GROUP BY pack
         ORDER BY totalCount DESC, pack ASC`,
      )
      .all() as Array<{ pack: string; activeCount: number; pendingCount: number; totalCount: number }>;
    return rows.map((row) => ({
      pack: row.pack,
      activeCount: Number(row.activeCount),
      pendingCount: Number(row.pendingCount),
      totalCount: Number(row.totalCount),
    }));
  }

  public overview(mediaBasePath: string | null, queue: ReviewQueueSnapshot) {
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount
         FROM stickers`,
      )
      .get() as { activeCount: number | null; pendingCount: number | null };
    const banned = this.db.prepare("SELECT COUNT(*) AS count FROM blacklist").get() as { count: number };
    const packs = this.listPacks();
    return {
      totalActive: Number(counts.activeCount ?? 0),
      totalPending: Number(counts.pendingCount ?? 0),
      totalBanned: Number(banned.count ?? 0),
      packs,
      categories: this.listCategories(undefined, "all"),
      queue,
      mediaBasePath,
      defaultPack: packs[0]?.pack ?? "default",
    };
  }

  public list(query: StickerListQuery): StickerListResult {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(120, Math.trunc(query.pageSize ?? 48)));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.pack && query.pack.trim().length > 0 && query.pack !== "all") {
      clauses.push("pack = ?");
      params.push(normalizePackName(query.pack, query.pack));
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.category && query.category.trim().length > 0 && query.category !== "all") {
      clauses.push("category = ?");
      params.push(query.category.trim());
    }
    if (query.character && query.character.trim().length > 0) {
      clauses.push("LOWER(character_name) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.character.trim().toLowerCase())}%`);
    }

    const normalizedPackFilter = query.pack && query.pack.trim().length > 0 && query.pack !== "all" ? normalizePackName(query.pack, query.pack) : undefined;
    const needle = query.query?.trim().toLowerCase() ?? "";
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderSql =
      query.sort === "most_used"
        ? "ORDER BY usage_count DESC, created_at DESC"
        : query.sort === "updated"
          ? "ORDER BY updated_at DESC"
          : "ORDER BY created_at DESC";

    if (needle.length === 0) {
      const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM stickers ${where}`).get(...params) as { count: number };
      const rows = this.db
        .prepare(`SELECT rowid, * FROM stickers ${where} ${orderSql} LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize) as unknown as RawStickerRow[];
      return {
        items: rows.map(toRecord),
        total: Number(totalRow.count),
        page,
        pageSize,
        packs: this.listPacks(),
        categories: this.listCategories(normalizedPackFilter ? [normalizedPackFilter] : undefined, query.status ?? "all"),
      };
    }

    const candidates = this.db.prepare(`SELECT rowid, * FROM stickers ${where} ${orderSql}`).all(...params) as unknown as RawStickerRow[];
    const terms = tokenizeQuery(needle);
    const matched = candidates.filter((row) => {
      const rec = toRecord(row);
      const haystack = buildSearchText(rec).toLowerCase();
      return haystack.includes(needle) || terms.every((term) => haystack.includes(term));
    });

    const start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize).map(toRecord),
      total: matched.length,
      page,
      pageSize,
      packs: this.listPacks(),
      categories: this.listCategories(normalizedPackFilter ? [normalizedPackFilter] : undefined, query.status ?? "all"),
    };
  }

  public search(params: SearchStickersParams): StickerSearchHit[] {
    const packs = params.packs.map((item) => normalizePackName(item, "")).filter((item) => item.length > 0);
    if (packs.length === 0) return [];

    const limit = Math.max(1, Math.min(30, Math.trunc(params.limit ?? 8)));
    const clauses = ["status = 'active'", `pack IN (${packs.map(() => "?").join(", ")})`];
    const sqlParams: Array<string | number> = [...packs];

    if (params.category && params.category.trim().length > 0) {
      clauses.push("LOWER(category) = ?");
      sqlParams.push(params.category.trim().toLowerCase());
    }
    if (params.character && params.character.trim().length > 0) {
      clauses.push("LOWER(character_name) LIKE ? ESCAPE '\\'");
      sqlParams.push(`%${escapeLike(params.character.trim().toLowerCase())}%`);
    }

    const rows = this.db.prepare(`SELECT rowid, * FROM stickers WHERE ${clauses.join(" AND ")}`).all(...sqlParams) as unknown as RawStickerRow[];
    if (rows.length === 0) return [];

    const queryText = params.query?.trim() ?? "";
    const terms = tokenizeQuery(queryText);

    const ftsBonus = new Map<string, number>();
    const trigramTerms = terms.filter((term) => [...term].length >= 3);
    if (trigramTerms.length > 0) {
      const expression = trigramTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT s.id AS id, bm25(stickers_fts) AS rank
             FROM stickers_fts
             JOIN stickers s ON s.id = stickers_fts.id
             WHERE stickers_fts MATCH ? AND ${clauses.map((c) => c.replace(/\b(status|pack|category|character_name)\b/g, "s.$1")).join(" AND ")}
             LIMIT 100`,
          )
          .all(expression, ...sqlParams) as Array<{ id: string; rank: number }>;
        for (const hit of ftsRows) {
          // bm25 returns negative numbers in SQLite FTS5 (smaller = better match)
          ftsBonus.set(String(hit.id), Math.max(0.5, 4 - Number(hit.rank)));
        }
      } catch {
        // Ignore malformed FTS expression and rely on direct field scoring below.
      }
    }

    const lexicalRanked: Array<{ row: RawStickerRow; record: StickerRecord; score: number }> = [];
    for (const row of rows) {
      const record = toRecord(row);
      let lexicalScore = 0;
      if (queryText.length === 0) {
        lexicalScore = 1;
      } else {
        lexicalScore = scoreRecordFields(record, queryText.toLowerCase(), terms) + (ftsBonus.get(record.id) ?? 0);
      }
      if (lexicalScore > 0 || (params.queryEmbedding && row.embedding && row.embedding_model === params.embeddingModel)) {
        lexicalRanked.push({ row, record, score: lexicalScore });
      }
    }

    const vectorScoreById = new Map<string, number>();
    const vectorRankedIds: string[] = [];
    if (params.queryEmbedding && params.embeddingModel) {
      const scoredVectors: Array<{ id: string; sim: number }> = [];
      for (const item of lexicalRanked) {
        if (!item.row.embedding || item.row.embedding_model !== params.embeddingModel) continue;
        const vec = bufferToFloat32(item.row.embedding);
        const sim = cosineSimilarity(params.queryEmbedding, vec);
        if (sim > 0.15) {
          vectorScoreById.set(item.record.id, sim);
          scoredVectors.push({ id: item.record.id, sim });
        }
      }
      scoredVectors.sort((a, b) => b.sim - a.sim);
      for (const entry of scoredVectors) vectorRankedIds.push(entry.id);
    }

    const hasLexicalHits = lexicalRanked.some((item) => item.score > 0);
    if (!hasLexicalHits && vectorRankedIds.length === 0) return [];

    const lexOnlySorted = [...lexicalRanked]
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.usageCount - a.record.usageCount || b.record.createdAt - a.record.createdAt);

    const lexRank = new Map<string, number>();
    lexOnlySorted.forEach((item, index) => lexRank.set(item.record.id, index + 1));

    const vecRank = new Map<string, number>();
    vectorRankedIds.forEach((id, index) => vecRank.set(id, index + 1));

    const k = 40;
    const hits: StickerSearchHit[] = [];
    for (const item of lexicalRanked) {
      const lScore = item.score;
      const vScore = vectorScoreById.get(item.record.id) ?? 0;
      if (lScore <= 0 && vScore <= 0) continue;
      let combined = lScore;
      if (vectorRankedIds.length > 0) {
        const lRank = lexRank.get(item.record.id);
        const vRank = vecRank.get(item.record.id);
        const rrf = (lRank !== undefined ? 1 / (k + lRank) : 0) + (vRank !== undefined ? 1.15 / (k + vRank) : 0);
        combined = rrf * 100 + lScore * 0.05 + vScore * 2;
      }
      hits.push({
        sticker: item.record,
        score: Number(combined.toFixed(4)),
        lexicalScore: Number(lScore.toFixed(4)),
        vectorScore: Number(vScore.toFixed(4)),
      });
    }

    hits.sort((a, b) => b.score - a.score || a.sticker.usageCount - b.sticker.usageCount || b.sticker.createdAt - a.sticker.createdAt);
    return hits.slice(0, limit);
  }

  public pickForSend(params: SearchStickersParams): StickerRecord | undefined {
    const hasFilter = Boolean(params.query?.trim() || params.category?.trim() || params.character?.trim());
    if (!hasFilter) {
      const packs = params.packs.map((item) => normalizePackName(item, "")).filter((item) => item.length > 0);
      if (packs.length === 0) return undefined;
      const rows = this.db
        .prepare(
          `SELECT rowid, * FROM stickers
           WHERE status = 'active' AND pack IN (${packs.map(() => "?").join(", ")})
           ORDER BY usage_count ASC, RANDOM()
           LIMIT 12`,
        )
        .all(...packs) as unknown as RawStickerRow[];
      if (rows.length === 0) return undefined;
      const picked = rows[Math.floor(Math.random() * rows.length)]!;
      return toRecord(picked);
    }

    const hits = this.search({ ...params, limit: 10 });
    if (hits.length === 0) return undefined;
    const topScore = hits[0]!.score;
    const shortlist = hits.filter((hit) => hit.score >= topScore * 0.72).slice(0, 5);
    // Prefer candidates with lower usage count while keeping randomness.
    const weighted = shortlist.map((hit) => ({
      sticker: hit.sticker,
      weight: (hit.score / Math.max(0.01, topScore)) * (1 / (1 + Math.log1p(hit.sticker.usageCount) * 0.35)),
    }));
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * totalWeight;
    for (const item of weighted) {
      cursor -= item.weight;
      if (cursor <= 0) return item.sticker;
    }
    return weighted[0]!.sticker;
  }

  private allocateId(sha256: string): string {
    for (let length = 12; length <= sha256.length; length += 4) {
      const candidate = sha256.slice(0, length);
      const conflict = this.db.prepare("SELECT 1 FROM stickers WHERE id = ?").get(candidate);
      if (!conflict) return candidate;
    }
    return sha256;
  }

  private writeFileAtomic(sha256: string, ext: string, bytes: Uint8Array): void {
    const target = this.filePathFor(sha256, ext);
    if (fs.existsSync(target)) return;
    const tmp = path.join(this.filesDir, `.${sha256}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, bytes, { flag: "wx" });
      fs.renameSync(tmp, target);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      if (fs.existsSync(target)) return;
      throw error;
    }
  }

  private removeFileIfExists(sha256: string, ext: string): void {
    try {
      fs.rmSync(this.filePathFor(sha256, ext), { force: true });
    } catch {
      // Ignore cleanup errors when file is already absent.
    }
  }

  private withSavepoint<T>(fn: () => T): T {
    const sp = `sp_sticker_${++this.savepointSeq}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      this.db.exec(`RELEASE SAVEPOINT ${sp}`);
      throw error;
    }
  }

  private syncFts(id: string): void {
    const row = this.db.prepare("SELECT rowid, * FROM stickers WHERE id = ?").get(id) as RawStickerRow | undefined;
    if (!row) return;
    this.deleteFts(id);
    const searchText = buildSearchText(toRecord(row));
    this.db.prepare("INSERT INTO stickers_fts(id, search_text) VALUES (?, ?)").run(id, searchText);
  }

  private deleteFts(id: string): void {
    this.db.prepare("DELETE FROM stickers_fts WHERE id = ?").run(id);
  }
}

export function buildSearchText(
  record: Pick<StickerRecord, "category" | "tags" | "description" | "ocrText" | "characterName" | "workName" | "emotions" | "scenes">,
): string {
  return [
    record.category,
    record.characterName,
    record.workName,
    record.emotions.join(" "),
    record.tags.join(" "),
    record.scenes.join(" "),
    record.ocrText,
    record.description,
  ]
    .filter((part) => part.trim().length > 0)
    .join(" | ");
}

function scoreRecordFields(record: StickerRecord, fullNeedle: string, terms: string[]): number {
  const fields: Array<{ value: string; weight: number }> = [
    { value: record.characterName.toLowerCase(), weight: 12 },
    { value: record.category.toLowerCase(), weight: 10 },
    { value: record.emotions.join(" ").toLowerCase(), weight: 9 },
    { value: record.tags.join(" ").toLowerCase(), weight: 8 },
    { value: record.ocrText.toLowerCase(), weight: 8 },
    { value: record.workName.toLowerCase(), weight: 7 },
    { value: record.scenes.join(" ").toLowerCase(), weight: 6 },
    { value: record.description.toLowerCase(), weight: 4 },
  ];

  let score = 0;
  for (const field of fields) {
    if (!field.value) continue;
    if (field.value === fullNeedle) score += field.weight * 2.5;
    else if (field.value.includes(fullNeedle)) score += field.weight * 1.4;
    for (const term of terms) {
      if (field.value.includes(term)) score += field.weight;
    }
  }
  return score;
}

export function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s,，、/|;；]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(tokens)];
}

function toRecord(row: RawStickerRow): StickerRecord {
  let source: StickerSourceInfo = { kind: "upload" };
  try {
    source = JSON.parse(row.source) as StickerSourceInfo;
  } catch {
    source = { kind: "upload" };
  }
  return {
    id: row.id,
    sha256: row.sha256,
    pack: row.pack,
    status: row.status === "pending" ? "pending" : "active",
    mime: row.mime,
    ext: row.ext,
    size: Number(row.size),
    width: Number(row.width),
    height: Number(row.height),
    category: row.category,
    tags: parseJsonList(row.tags),
    description: row.description,
    ocrText: row.ocr_text,
    characterName: row.character_name,
    workName: row.work_name,
    emotions: parseJsonList(row.emotions),
    scenes: parseJsonList(row.scenes),
    source,
    usageCount: Number(row.usage_count),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    embeddingModel: row.embedding_model,
  };
}

function parseJsonList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

function normalizeList(values: readonly string[] | unknown, maxItems: number): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const item = normalizeText(raw, 32);
    if (item) seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

function reviewCacheKey(sha256: string, facts?: ReviewFacts): string {
  const normalizedFacts = {
    character: facts?.character?.trim() ?? "",
    work: facts?.work?.trim() ?? "",
    overlayText: facts?.overlayText?.trim() ?? "",
    note: facts?.note?.trim() ?? "",
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(normalizedFacts)).digest("hex").slice(0, 16);
  return `${sha256}:${digest}`;
}

function float32ToBuffer(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function bufferToFloat32(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
