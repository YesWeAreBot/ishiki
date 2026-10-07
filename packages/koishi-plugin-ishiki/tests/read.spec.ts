import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createReadTool } from "../src/builtin-tools/read.js";
import { ArtifactStore } from "../src/resources/artifact.js";
import type { AssetDatabase, AssetRecord } from "../src/resources/asset.js";
import { AssetRegistry } from "../src/resources/asset.js";
import { ResourceCenter } from "../src/resources/center.js";
import { AssetHandler, ArtifactHandler } from "../src/resources/handlers.js";
import { splitSelectors } from "../src/resources/selectors.js";

class MemoryAssetDb implements AssetDatabase {
  readonly rows = new Map<string, AssetRecord>();

  async get(runtimeId: string, id: string) {
    return this.rows.get(`${runtimeId}/${id}`);
  }

  async prefixSearch(runtimeId: string, prefix: string) {
    return [...this.rows.values()].filter((row) => row.runtimeId === runtimeId && row.id.startsWith(prefix));
  }

  async listIds(runtimeId: string) {
    return [...this.rows.values()].filter((row) => row.runtimeId === runtimeId).map((row) => row.id);
  }

  async create(row: AssetRecord) {
    this.rows.set(`${row.runtimeId}/${row.id}`, row);
  }

  async markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }) {
    const row = this.rows.get(`${runtimeId}/${id}`);
    if (row) Object.assign(row, data, { fetchedAt: Date.now() });
  }
}

async function makeCenter(imageInput: boolean) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-read-"));
  const center = new ResourceCenter("rt1", home);
  const assets = new AssetRegistry("rt1", home, new MemoryAssetDb());
  const artifacts = new ArtifactStore(home);
  const assetHandler = new AssetHandler(assets);
  center.useCore(assetHandler);
  center.useCore(new ArtifactHandler(artifacts));
  const tool = createReadTool({ center, imageInput, assetReader: assetHandler });
  return { home, center, assets, artifacts, tool };
}

describe("splitSelectors", () => {
  it("peels line, raw, and dot-path selectors", () => {
    expect(splitSelectors("artifact://bash/a.log")).toEqual({ url: "artifact://bash/a.log", selectors: [] });
    expect(splitSelectors("artifact://bash/a.log:1-200")).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "lines", start: 1, end: 200 }],
    });
    expect(splitSelectors("artifact://bash/a.log:50+30")).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "lines", start: 50, end: 79 }],
    });
    expect(splitSelectors("artifact://bash/a.log:raw")).toEqual({ url: "artifact://bash/a.log", selectors: [{ kind: "raw" }] });
    expect(splitSelectors("artifact://bash/a.log:.result.items.0.path")).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "path", segments: ["result", "items", "0", "path"] }],
    });
  });

  it("keeps scheme colons intact", () => {
    expect(splitSelectors("mcp://urn:example:doc").selectors).toEqual([]);
  });

  it("rejects malformed selectors", () => {
    for (const bad of ["artifact://bash/a.log:abc", "artifact://bash/a.log:", "artifact://bash/a.log:.x:1-2"]) {
      expect(() => splitSelectors(bad)).toThrow(/invalid selector|cannot chain/);
    }
  });
});

describe("read tool", () => {
  it("returns text content for artifacts", async () => {
    const { artifacts, tool } = await makeCenter(false);
    await artifacts.put("bash", "out.txt", new TextEncoder().encode("l1\nl2\nl3\nl4"));
    const result = await tool.execute!({ url: "artifact://bash/out.txt" }, {} as never);
    expect(result).toEqual({ type: "text", value: "l1\nl2\nl3\nl4" });
  });

  it("applies line slices with a gutter", async () => {
    const { artifacts, tool } = await makeCenter(false);
    await artifacts.put("bash", "out.txt", new TextEncoder().encode("alpha\nbeta\ngamma"));
    const result = (await tool.execute!({ url: "artifact://bash/out.txt:2-3" }, {} as never)) as { type: string; value: string };
    expect(result.value).toBe("2| beta\n3| gamma");
  });

  it("extracts JSON dot paths", async () => {
    const { artifacts, tool } = await makeCenter(false);
    await artifacts.put("agent", "out.json", new TextEncoder().encode(JSON.stringify({ result: { items: [{ path: "src/a.ts" }] } })));
    const result = await tool.execute!({ url: "artifact://agent/out.json:.result.items.0.path" }, {} as never);
    expect(result).toEqual({ type: "json", value: "src/a.ts" });
  });

  it("falls back to a metadata card for images when imageInput is off", async () => {
    const { assets, tool } = await makeCenter(false);
    const url = await assets.register("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const result = (await tool.execute!({ url }, {} as never)) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("cannot view images");
  });

  it("returns an image file part when imageInput is on", async () => {
    const { assets, tool } = await makeCenter(true);
    const url = await assets.register("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const result = (await tool.execute!({ url }, {} as never)) as { type: string; value: Array<{ type: string; mediaType: string }> };
    expect(result.type).toBe("content");
    expect(result.value[0].mediaType).toBe("image/png");
  });

  it("describes non-image binaries without emitting bytes", async () => {
    const { artifacts, tool } = await makeCenter(true);
    await artifacts.put("bash", "clip.bin", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 1]));
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
