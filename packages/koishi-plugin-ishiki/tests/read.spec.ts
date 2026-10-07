import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createReadTool } from "../src/builtin-tools/read.js";
import { ResourceCenter } from "../src/resources/center.js";
import { splitSelectors } from "../src/resources/selectors.js";
import { ResourceStore } from "../src/resources/store.js";

async function makeCenter(imageInput: boolean) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-read-"));
  const store = new ResourceStore(home);
  const center = new ResourceCenter("rt1", home, store);
  const tool = createReadTool({ center, imageInput });
  return { home, center, store, tool };
}

const acceptAll = () => true;

describe("splitSelectors", () => {
  it("peels line and raw selectors", () => {
    expect(splitSelectors("artifact://bash/a.log", acceptAll)).toEqual({ url: "artifact://bash/a.log", selectors: [] });
    expect(splitSelectors("artifact://bash/a.log:1-200", acceptAll)).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "lines", start: 1, end: 200 }],
    });
    expect(splitSelectors("artifact://bash/a.log:50+30", acceptAll)).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "lines", start: 50, end: 79 }],
    });
    expect(splitSelectors("artifact://bash/a.log:raw", acceptAll)).toEqual({ url: "artifact://bash/a.log", selectors: [{ kind: "raw" }] });
    expect(splitSelectors("artifact://bash/a.log:raw:1-50", acceptAll).selectors).toEqual([{ kind: "raw" }, { kind: "lines", start: 1, end: 50 }]);
  });

  it("never peels schemes that opt out of selectors", () => {
    expect(splitSelectors("mcp://server/urn:example:doc", () => false)).toEqual({ url: "mcp://server/urn:example:doc", selectors: [] });
    expect(splitSelectors("mcp://server/file.txt:1-50", () => false).selectors).toEqual([]);
  });

  it("rejects malformed selectors", () => {
    for (const bad of ["artifact://bash/a.log:abc", "artifact://bash/a.log:"]) {
      expect(() => splitSelectors(bad, acceptAll)).toThrow(/invalid selector/);
    }
  });
});

describe("read tool", () => {
  it("returns text content for artifacts", async () => {
    const { store, tool } = await makeCenter(false);
    await store.putArtifact("bash", "out.txt", new TextEncoder().encode("l1\nl2\nl3\nl4"));
    const result = await tool.execute!({ url: "artifact://bash/out.txt" }, {} as never);
    expect(result).toEqual({ type: "text", value: "l1\nl2\nl3\nl4" });
  });

  it("applies line slices with a gutter", async () => {
    const { store, tool } = await makeCenter(false);
    await store.putArtifact("bash", "out.txt", new TextEncoder().encode("alpha\nbeta\ngamma"));
    const result = (await tool.execute!({ url: "artifact://bash/out.txt:2-3" }, {} as never)) as { type: string; value: string };
    expect(result.value).toBe("2| beta\n3| gamma");
  });

  it("returns the meta view without loading bytes", async () => {
    const { store, tool } = await makeCenter(false);
    const url = await store.registerAsset("https://example.com/photo.jpg", { mediaType: "image/*", sourceInfo: { fileSize: "169667" } });
    const result = (await tool.execute!({ url: `${url}?view=meta` }, {} as never)) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("169667");
    expect(result.value).toContain("not fetched yet");
  });

  it("falls back to a text description for images when imageInput is off", async () => {
    const { store, tool } = await makeCenter(false);
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const result = (await tool.execute!({ url }, {} as never)) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("cannot view images");
  });

  it("returns an image file part even when the record has no declared type", async () => {
    const { store, tool } = await makeCenter(true);
    // 回归：入站注册曾丢掉类型，read 在拿字节前就判定非图片，字节永远到不了模型。
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    const result = (await tool.execute!({ url }, {} as never)) as { type: string; value: Array<{ type: string; mediaType: string }> };
    expect(result.type).toBe("content");
    expect(result.value[0].mediaType).toBe("image/png");
  });

  it("returns an image file part when imageInput is on", async () => {
    const { store, tool } = await makeCenter(true);
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const result = (await tool.execute!({ url }, {} as never)) as { type: string; value: Array<{ type: string; mediaType: string }> };
    expect(result.type).toBe("content");
    expect(result.value[0].mediaType).toBe("image/png");
  });

  it("describes non-image binaries without emitting bytes", async () => {
    const { store, tool } = await makeCenter(true);
    await store.putArtifact("bash", "clip.bin", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 1]));
    const result = (await tool.execute!({ url: "artifact://bash/clip.bin" }, {} as never)) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("binary");
  });

  it("propagates typed resource errors", async () => {
    const { tool } = await makeCenter(false);
    await expect(tool.execute!({ url: "artifact://bash/missing.txt" }, {} as never)).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(tool.execute!({ url: "wat://x" }, {} as never)).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});
