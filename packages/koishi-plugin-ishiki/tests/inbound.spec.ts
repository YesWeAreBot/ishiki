import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { rewriteInboundMedia } from "../src/resources/inbound.js";
import { ResourceStore } from "../src/resources/store.js";

async function makeStore() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-inbound-"));
  return { home, store: new ResourceStore(home) };
}

describe("rewriteInboundMedia", () => {
  it("rewrites CDN sources to asset URLs and preserves surrounding content", async () => {
    const { home, store } = await makeStore();
    try {
      const src = "https://multimedia.example.com/img/abc.jpg";
      const content = `看看这张 <img src="${src}"/> 和文字`;
      const rewritten = await rewriteInboundMedia(content, [{ kind: "image", src, mediaType: "image/*" }], store);
      const id = ResourceStore.deriveId(src);
      expect(rewritten).toBe(`看看这张 <img src="asset://${id}"/> 和文字`);
      const meta = await store.getMeta("asset", "", id);
      expect(meta?.src).toBe(src);
      expect(meta?.mediaType).toBe("image/*");
      expect(meta?.fetchedAt).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("persists platform sourceInfo verbatim", async () => {
    const { home, store } = await makeStore();
    try {
      const src = "https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=xxx";
      const rewritten = await rewriteInboundMedia(
        `<img src="${src}"/>`,
        [{ kind: "image", src, filename: "1D62BD1F.jpg", sourceInfo: { file: "1D62BD1F.jpg", subType: 0, fileSize: "169667" } }],
        store,
      );
      expect(rewritten).toContain(`asset://${ResourceStore.deriveId(src)}`);
      const meta = await store.getMeta("asset", "", ResourceStore.deriveId(src));
      expect(meta?.sourceInfo).toEqual({ file: "1D62BD1F.jpg", subType: 0, fileSize: "169667" });
      expect(meta?.filename).toBe("1D62BD1F.jpg");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rewrites the same source identically across messages (dedupe)", async () => {
    const { home, store } = await makeStore();
    try {
      const src = "https://multimedia.example.com/img/same.png";
      const first = await rewriteInboundMedia(`<img src="${src}"/>`, [{ kind: "image", src }], store);
      const second = await rewriteInboundMedia(`again <img src="${src}"/>`, [{ kind: "image", src }], store);
      expect(first).toContain(`asset://${ResourceStore.deriveId(src)}`);
      expect(second).toContain(`asset://${ResourceStore.deriveId(src)}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("returns content unchanged when there is no media", async () => {
    const { home, store } = await makeStore();
    try {
      const content = "纯文本消息";
      expect(await rewriteInboundMedia(content, [], store)).toBe(content);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("handles multiple media elements in one message", async () => {
    const { home, store } = await makeStore();
    try {
      const srcA = "https://example.com/a.png";
      const srcB = "https://example.com/b.mp3";
      const content = `<img src="${srcA}"/><audio src="${srcB}"/>`;
      const rewritten = await rewriteInboundMedia(
        content,
        [
          { kind: "image", src: srcA, mediaType: "image/*" },
          { kind: "audio", src: srcB, mediaType: "audio/*" },
        ],
        store,
      );
      expect(rewritten).toBe(`<img src="asset://${ResourceStore.deriveId(srcA)}"/><audio src="asset://${ResourceStore.deriveId(srcB)}"/>`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
