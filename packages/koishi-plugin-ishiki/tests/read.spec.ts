import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processOutput } from "../src/attachment/output.js";
import { createReadTool, type ReadResult } from "../src/builtin-tools/read.js";
import { ResourceCenter } from "../src/resources/center.js";
import { splitSelectors } from "../src/resources/selectors.js";
import { ResourceStore } from "../src/resources/store.js";

let home: string;
let center: ResourceCenter;
let store: ResourceStore;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-read-"));
  store = new ResourceStore(home);
  center = new ResourceCenter("rt1", home, store);
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function read(url: string): Promise<ReadResult> {
  return (await createReadTool({ center }).execute!({ url }, { toolCallId: "read-1", messages: [] })) as ReadResult;
}

describe("splitSelectors", () => {
  it("peels line ranges and character continuations", () => {
    expect(splitSelectors("artifact://bash/a.log:1-200", () => true)).toEqual({
      url: "artifact://bash/a.log",
      selectors: [{ kind: "lines", start: 1, end: 200 }],
    });
    expect(splitSelectors("artifact://bash/a.log:50+30", () => true).selectors).toEqual([{ kind: "lines", start: 50, end: 79 }]);
    expect(splitSelectors("artifact://bash/a.log?view=original#offset=30000&end=20", () => true)).toEqual({
      url: "artifact://bash/a.log?view=original",
      selectors: [{ kind: "offset", offset: 30000, end: 20 }],
    });
  });
  it("does not peel opaque schemes", () => {
    expect(splitSelectors("mcp://server/urn:example:doc#offset=1", () => false)).toEqual({ url: "mcp://server/urn:example:doc#offset=1", selectors: [] });
  });
  it("rejects removed raw and malformed ranges", () => {
    for (const suffix of [":raw", ":abc", ":", ":0", ":-1", ":1+0", ":2-1", "#offset=9007199254740992"])
      expect(() => splitSelectors(`artifact://bash/a.log${suffix}`, () => true)).toThrow(/invalid|reversed|range/);
  });
});

describe("read tool", () => {
  it("returns a JSON-safe page and pure native text conversion", async () => {
    const url = await store.writeArtifact("bash", Buffer.from("alpha\nbeta\ngamma"), { mediaType: "text/plain" });
    const result = await read(`${url}:2-3`);
    expect(result).toMatchObject({ type: "ishiki.read", kind: "text", text: "beta\ngamma", url, page: { startLine: 2, endLine: 3, offset: 6 } });
    expect(await read(`${url}:2-3:2-2`)).toMatchObject({ text: "gamma" });
    const tool = createReadTool({ center });
    expect(tool.outputSchema).toBeDefined();
    const native = await tool.toModelOutput!({ toolCallId: "r", input: { url }, output: result });
    expect(native).toEqual({ type: "text", value: "beta\ngamma" });
    const processed = await processOutput(center, "read", "r", result, native);
    expect(processed.output).toMatchObject({ type: "text", value: "beta\ngamma" });
    expect(await store.namespaces("artifact")).toEqual(["bash"]);
  });
  it("returns metadata without fetching", async () => {
    const url = await store.registerAsset("https://example.com/photo.jpg", { mediaType: "image/*", sourceInfo: { fileSize: "169667" } });
    const result = await read(`${url}?view=meta`);
    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain("169667");
    expect(result.text).toContain("not fetched yet");
    expect((await store.getMeta("asset", "", url.slice(8)))?.fetchedAt).toBeUndefined();
  });
  it("keeps image bytes JSON-safe independent of model modality and reuses source", async () => {
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    const result = await read(url);
    expect(result).toMatchObject({ kind: "file", mediaType: "image/png", data: "iVBORw0KGgo=" });
    const native = await createReadTool({ center }).toModelOutput!({ toolCallId: "r", input: { url }, output: result });
    expect(native.type).toBe("content");
    const processed = await processOutput(center, "read", "r", JSON.parse(JSON.stringify(result)), native);
    expect(processed.items[0]?.url).toBe(url);
    expect(await store.namespaces("artifact")).toEqual([]);
    if (result.kind !== "file") throw new Error("expected image");
    const changed = { ...result, data: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64") };
    const updated = await processOutput(center, "codemode", "c", changed, { type: "json", value: changed });
    expect(updated.items[0]?.url).toMatch(/^artifact:\/\/codemode\//);
    expect((await center.resolve(url)).bytes).toEqual(new Uint8Array(Buffer.from(result.data, "base64")));
  });
  it("returns other binary bytes to internal consumers", async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1]);
    const url = await store.writeArtifact("clip", bytes, { mediaType: "video/webm" });
    expect(await read(url)).toMatchObject({ kind: "file", data: bytes.toString("base64"), mediaType: "video/webm" });
  });
  it("pages a local file larger than 1 MiB and can reconstruct every character", async () => {
    const text = "abcdefghijklmnop".repeat(70000);
    await fs.writeFile(path.join(home, "large.txt"), text);
    let offset = 0;
    const pages: string[] = [];
    for (;;) {
      const result = await read(`local://large.txt#offset=${offset}`);
      if (result.kind !== "text") throw new Error("expected text");
      expect(result.page.text.length).toBeLessThanOrEqual(30000);
      pages.push(result.page.text);
      if (result.page.nextOffset === undefined) break;
      expect(result.text).toContain(`#offset=${result.page.nextOffset}`);
      offset = result.page.nextOffset;
    }
    expect(pages.join("")).toBe(text);
    expect(await store.namespaces("artifact")).toEqual([]);
  });
  it("really limits line count and resumes without skipping or repeating lines", async () => {
    const text = Array.from({ length: 4500 }, (_, i) => String(i)).join("\n");
    const url = await store.writeArtifact("lines", Buffer.from(text), { mediaType: "text/plain" });
    const first = await read(url);
    if (first.kind !== "text") throw new Error("expected text");
    expect(first.page.endLine).toBe(2000);
    const second = await read(`${url}#offset=${first.page.nextOffset}`);
    if (second.kind !== "text") throw new Error("expected text");
    const third = await read(`${url}#offset=${second.page.nextOffset}`);
    if (third.kind !== "text") throw new Error("expected text");
    expect(first.page.text + second.page.text + third.page.text).toBe(text);
    expect(await store.names("artifact", "lines")).toHaveLength(1);
  });
  it("propagates typed errors", async () => {
    await expect(read("artifact://bash/missing.txt")).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(read("wat://x")).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});
