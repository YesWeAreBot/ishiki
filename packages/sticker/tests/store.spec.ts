import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/media.js";
import { StickerStore } from "../src/store.js";

function makePng(width: number, height: number, color: [number, number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

const tempDirs: string[] = [];

function createStore(): StickerStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-sticker-store-"));
  tempDirs.push(dir);
  return new StickerStore(dir);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("StickerStore", () => {
  it("saves atomically, deduplicates by sha256, and merges tags/emotions", () => {
    const store = createStore();
    try {
      const bytes = makePng(64, 64, [255, 100, 100, 255]);
      const sha = sha256Hex(bytes);

      const first = store.save({
        sha256: sha,
        bytes,
        mime: "image/png",
        ext: "png",
        width: 64,
        height: 64,
        pack: "memes",
        status: "active",
        category: "开心",
        tags: ["笑", "贴贴"],
        description: "开心地笑",
        ocrText: "",
        characterName: "小桃",
        workName: "示例作品",
        emotions: ["开心"],
        scenes: ["打招呼"],
        source: { kind: "upload" },
      });
      expect(first.status).toBe("created");
      expect(fs.existsSync(store.filePathFor(sha, "png"))).toBe(true);

      const dup = store.save({
        sha256: sha,
        bytes,
        mime: "image/png",
        ext: "png",
        width: 64,
        height: 64,
        pack: "memes",
        status: "active",
        category: "开心",
        tags: ["可可爱爱"],
        description: "duplicate",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: ["兴奋"],
        scenes: [],
        source: { kind: "llm" },
      });
      expect(dup.status).toBe("duplicate");
      expect(dup.sticker.id).toBe(first.sticker.id);
      expect(dup.sticker.tags).toEqual(["笑", "贴贴", "可可爱爱"]);
      expect(dup.sticker.emotions).toEqual(["开心", "兴奋"]);
    } finally {
      store.close();
    }
  });

  it("supports pack isolation, 2-char CJK queries, FTS5 trigram queries, and hybrid vector RRF", () => {
    const store = createStore();
    try {
      const aBytes = makePng(64, 64, [10, 200, 10, 255]);
      const bBytes = makePng(64, 64, [10, 10, 200, 255]);
      const cBytes = makePng(64, 64, [200, 200, 10, 255]);

      const a = store.save({
        sha256: sha256Hex(aBytes),
        bytes: aBytes,
        mime: "image/png",
        ext: "png",
        width: 64,
        height: 64,
        pack: "memes",
        status: "active",
        category: "开心",
        tags: ["比心"],
        description: "小桃开心比心",
        ocrText: "好耶",
        characterName: "小桃",
        workName: "示例作品",
        emotions: ["开心"],
        scenes: ["庆祝"],
        source: { kind: "upload" },
        embeddingModel: "mock:embed",
        embedding: Float32Array.from([0.9, 0.1, 0]),
      }).sticker;

      const b = store.save({
        sha256: sha256Hex(bBytes),
        bytes: bBytes,
        mime: "image/png",
        ext: "png",
        width: 64,
        height: 64,
        pack: "memes",
        status: "active",
        category: "委屈",
        tags: ["抱头尖叫"],
        description: "小明抱头尖叫",
        ocrText: "不要啊",
        characterName: "小明",
        workName: "校园日常",
        emotions: ["无语", "崩溃"],
        scenes: ["社死"],
        source: { kind: "upload" },
        embeddingModel: "mock:embed",
        embedding: Float32Array.from([0, 0.9, 0.1]),
      }).sticker;

      store.save({
        sha256: sha256Hex(cBytes),
        bytes: cBytes,
        mime: "image/png",
        ext: "png",
        width: 64,
        height: 64,
        pack: "other-pack",
        status: "active",
        category: "开心",
        tags: ["其他包"],
        description: "其他包开心表情",
        ocrText: "",
        characterName: "小蓝",
        workName: "",
        emotions: ["开心"],
        scenes: [],
        source: { kind: "upload" },
      });

      // Pack isolation + 2-char Chinese queries
      const happyHits = store.search({ packs: ["memes"], query: "开心" });
      expect(happyHits.map((h) => h.sticker.id)).toEqual([a.id]);

      const speechlessHits = store.search({ packs: ["memes"], query: "无语" });
      expect(speechlessHits.map((h) => h.sticker.id)).toEqual([b.id]);

      // >=3-char FTS5 trigram query
      const trigramHits = store.search({ packs: ["memes"], query: "抱头尖叫" });
      expect(trigramHits.map((h) => h.sticker.id)).toEqual([b.id]);

      // Hybrid vector RRF boosts vector match even for semantic query without literal overlap
      const vectorHits = store.search({
        packs: ["memes"],
        query: "羞耻社死",
        queryEmbedding: Float32Array.from([0, 0.95, 0.05]),
        embeddingModel: "mock:embed",
      });
      expect(vectorHits[0]?.sticker.id).toBe(b.id);
      expect(vectorHits[0]?.vectorScore).toBeGreaterThan(0.8);

      // Usage tracking
      store.markUsed(a.id);
      expect(store.getByIdOrPrefix(a.id)?.usageCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it("removes stale FTS tokens on update/delete and migrates legacy content-linked FTS tables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-sticker-fts-"));
    tempDirs.push(dir);
    const store = new StickerStore(dir);
    try {
      const aBytes = makePng(56, 56, [30, 140, 210, 255]);
      const a = store.save({
        sha256: sha256Hex(aBytes),
        bytes: aBytes,
        mime: "image/png",
        ext: "png",
        width: 56,
        height: 56,
        pack: "memes",
        status: "active",
        category: "吐槽",
        tags: ["绝对独一无二旧词"],
        description: "旧描述文本",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        source: { kind: "upload" },
      }).sticker;

      expect(store.search({ packs: ["memes"], query: "绝对独一无二旧词" }).map((h) => h.sticker.id)).toEqual([a.id]);

      store.update(a.id, { tags: ["全新替换热词"], description: "更新后描述" });
      expect(store.db.prepare("SELECT rowid FROM stickers_fts WHERE stickers_fts MATCH '\"绝对独一无二旧词\"'").all()).toHaveLength(0);
      expect(store.search({ packs: ["memes"], query: "绝对独一无二旧词" })).toHaveLength(0);
      expect(store.search({ packs: ["memes"], query: "全新替换热词" }).map((h) => h.sticker.id)).toEqual([a.id]);

      expect(store.delete(a.id)).toBe(true);
      expect(store.db.prepare("SELECT rowid FROM stickers_fts WHERE stickers_fts MATCH '\"全新替换热词\"'").all()).toHaveLength(0);

      // Simulate legacy content='stickers' FTS5 table and reopen StickerStore -> auto-migrates cleanly
      store.save({
        sha256: sha256Hex(aBytes),
        bytes: aBytes,
        mime: "image/png",
        ext: "png",
        width: 56,
        height: 56,
        pack: "memes",
        status: "active",
        category: "吐槽",
        tags: ["历史迁移检验词"],
        description: "待迁移记录",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        source: { kind: "upload" },
      });
    } finally {
      store.close();
    }

    const legacyDb = new DatabaseSync(path.join(dir, "stickers.sqlite"));
    legacyDb.exec(`
      DROP TABLE stickers_fts;
      CREATE VIRTUAL TABLE stickers_fts USING fts5(search_text, content='stickers', content_rowid='rowid', tokenize='trigram');
    `);
    legacyDb.close();

    const migrated = new StickerStore(dir);
    try {
      const ftsSql = (migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stickers_fts'").get() as { sql: string }).sql;
      expect(ftsSql).not.toMatch(/content\s*=/i);
      expect(ftsSql).toMatch(/\bid\s+UNINDEXED\b/i);
      const hits = migrated.search({ packs: ["memes"], query: "历史迁移检验词" });
      expect(hits).toHaveLength(1);
      expect(migrated.delete(hits[0]!.sticker.id)).toBe(true);
      expect(migrated.db.prepare("SELECT rowid FROM stickers_fts WHERE stickers_fts MATCH '\"历史迁移检验词\"'").all()).toHaveLength(0);
    } finally {
      migrated.close();
    }
  });

  it("keeps DB and disk atomic when save() fails FTS or batch() aborts mid-transaction", () => {
    const store = createStore();
    try {
      const aBytes = makePng(44, 44, [10, 20, 30, 255]);
      const bBytes = makePng(46, 46, [40, 50, 60, 255]);
      const a = store.save({
        sha256: sha256Hex(aBytes),
        bytes: aBytes,
        mime: "image/png",
        ext: "png",
        width: 44,
        height: 44,
        pack: "memes",
        status: "active",
        category: "日常",
        tags: ["保留图"],
        description: "a",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        source: { kind: "upload" },
      }).sticker;

      // Batch delete aborted on second step rolls back DB row AND keeps disk file intact
      const origUpdate = store.update.bind(store);
      const badBytes = makePng(48, 48, [70, 80, 90, 255]);
      const badSha = sha256Hex(badBytes);
      // Poison stickers_fts via rename/drop to simulate syncFts failure inside save() and batch()
      store.db.exec("DROP TABLE stickers_fts");
      expect(() =>
        store.save({
          sha256: badSha,
          bytes: badBytes,
          mime: "image/png",
          ext: "png",
          width: 48,
          height: 48,
          pack: "memes",
          status: "active",
          category: "日常",
          tags: ["失败回滚"],
          description: "bad",
          ocrText: "",
          characterName: "",
          workName: "",
          emotions: [],
          scenes: [],
          source: { kind: "upload" },
        }),
      ).toThrow(/stickers_fts/);
      expect(store.getBySha256(badSha)).toBeUndefined();
      expect(fs.existsSync(store.filePathFor(badSha, "png"))).toBe(false);

      // Recreate FTS and verify batch("delete") preserves files on disk if an error aborts the batch before COMMIT
      store.db.exec("CREATE VIRTUAL TABLE stickers_fts USING fts5(id UNINDEXED, search_text, tokenize='trigram')");
      const b = store.save({
        sha256: sha256Hex(bBytes),
        bytes: bBytes,
        mime: "image/png",
        ext: "png",
        width: 46,
        height: 46,
        pack: "memes",
        status: "active",
        category: "日常",
        tags: ["触发异常"],
        description: "b",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        source: { kind: "upload" },
      }).sticker;
      void origUpdate;
      store.db.exec(`
        CREATE TRIGGER block_second_delete BEFORE DELETE ON stickers
        WHEN OLD.id = '${b.id}'
        BEGIN
          SELECT RAISE(ABORT, 'simulated batch failure');
        END;
      `);
      expect(() => store.batch("delete", [a.id, b.id])).toThrow(/simulated batch failure/);
      expect(store.getByIdOrPrefix(a.id)).toBeDefined();
      expect(store.getByIdOrPrefix(b.id)).toBeDefined();
      expect(fs.existsSync(store.filePathFor(a.sha256, a.ext))).toBe(true);
      expect(fs.existsSync(store.filePathFor(b.sha256, b.ext))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("enforces blacklist on ban and allows unban", () => {
    const store = createStore();
    try {
      const bytes = makePng(48, 48, [120, 120, 120, 255]);
      const sha = sha256Hex(bytes);
      const saved = store.save({
        sha256: sha,
        bytes,
        mime: "image/png",
        ext: "png",
        width: 48,
        height: 48,
        pack: "default",
        status: "active",
        category: "日常",
        tags: [],
        description: "test",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        source: { kind: "upload" },
      });

      expect(store.ban(saved.sticker.id, "ads")).toBe(true);
      expect(store.isBlacklisted(sha)?.reason).toBe("ads");
      expect(store.getByIdOrPrefix(saved.sticker.id)).toBeUndefined();
      expect(fs.existsSync(store.filePathFor(sha, "png"))).toBe(false);
      expect(store.unban(sha)).toBe(true);
      expect(store.isBlacklisted(sha)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
