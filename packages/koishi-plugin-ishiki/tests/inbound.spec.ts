import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AssetDatabase, AssetRecord } from "../src/resources/asset.js";
import { AssetRegistry } from "../src/resources/asset.js";
import { rewriteInboundMedia } from "../src/resources/inbound.js";

class MemoryAssetDb implements AssetDatabase {
  readonly rows = new Map<string, AssetRecord>();

  async get(runtimeId: string, id: string) {
    return this.rows.get(`${runtimeId}/${id}`);
  }

  async prefixSearch(runtimeId: string, prefix: string) {
    return [...this.rows.values()].filter((row) => row.runtimeId === runtimeId && row.id.startsWith(prefix));
  }

  async create(row: AssetRecord) {
    this.rows.set(`${row.runtimeId}/${row.id}`, row);
  }

  async markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }) {
    const row = this.rows.get(`${runtimeId}/${id}`);
    if (row) Object.assign(row, data, { fetchedAt: Date.now() });
  }
}

describe("rewriteInboundMedia", () => {
  it("rewrites CDN sources to asset URLs and preserves surrounding content", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-inbound-"));
    try {
      const assets = new AssetRegistry("rt1", home, new MemoryAssetDb());
      const src = "https://multimedia.example.com/img/abc.jpg";
      const content = `看看这张 <img src="${src}"/> 和文字`;
      const rewritten = await rewriteInboundMedia(content, [{ kind: "image", src }], assets);
      const id = AssetRegistry.deriveId(src);
      expect(rewritten).toBe(`看看这张 <img src="asset://${id}"/> 和文字`);
      const record = await assets.get(id);
      expect(record?.src).toBe(src);
      expect(record?.fetchedAt).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rewrites the same source identically across messages (dedupe)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-inbound-"));
    try {
      const assets = new AssetRegistry("rt1", home, new MemoryAssetDb());
      const src = "https://multimedia.example.com/img/same.png";
      const first = await rewriteInboundMedia(`<img src="${src}"/>`, [{ kind: "image", src }], assets);
      const second = await rewriteInboundMedia(`again <img src="${src}"/>`, [{ kind: "image", src }], assets);
      expect(first).toContain(`asset://${AssetRegistry.deriveId(src)}`);
      expect(second).toContain(`asset://${AssetRegistry.deriveId(src)}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("returns content unchanged when there is no media", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-inbound-"));
    try {
      const assets = new AssetRegistry("rt1", home, new MemoryAssetDb());
      const content = "纯文本消息";
      expect(await rewriteInboundMedia(content, [], assets)).toBe(content);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("handles multiple media elements in one message", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-inbound-"));
    try {
      const assets = new AssetRegistry("rt1", home, new MemoryAssetDb());
      const srcA = "https://example.com/a.png";
      const srcB = "https://example.com/b.mp3";
      const content = `<img src="${srcA}"/><audio src="${srcB}"/>`;
      const rewritten = await rewriteInboundMedia(
        content,
        [
          { kind: "image", src: srcA },
          { kind: "audio", src: srcB },
        ],
        assets,
      );
      expect(rewritten).toBe(`<img src="asset://${AssetRegistry.deriveId(srcA)}"/><audio src="asset://${AssetRegistry.deriveId(srcB)}"/>`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
