import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReadTool, ReadTool } from "../src/builtin-tools/read.js";
import { ResourceCenter } from "../src/resources/center.js";
import { splitSelectors } from "../src/resources/selectors.js";
import { ResourceStore } from "../src/resources/store.js";
import { MAX_TEXT_CHARS, readBudget, TEXT_BUDGET, truncate } from "../src/resources/text.js";

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

async function read(url: string): Promise<ReadTool.Output> {
  return (await createReadTool({ center }).execute!({ url }, { toolCallId: "read-1", messages: [] })) as ReadTool.Output;
}

describe("splitSelectors", () => {
  it("peels line ranges and counts", () => {
    expect(splitSelectors("artifact://bash/a.log:1-200", () => true)).toEqual({
      url: "artifact://bash/a.log",
      range: { start: 1, end: 200 },
    });
    expect(splitSelectors("artifact://bash/a.log:50+30", () => true).range).toEqual({ start: 50, end: 79 });
    expect(splitSelectors("artifact://bash/a.log:12", () => true).range).toEqual({ start: 12 });
    expect(splitSelectors("artifact://bash/a.log", () => true).range).toBeUndefined();
    expect(splitSelectors("artifact://bash/a.log:2-3:2-2", () => true).range).toEqual({ start: 3, end: 3 });
  });
  it("does not peel opaque schemes", () => {
    expect(splitSelectors("mcp://server/urn:example:doc#frag", () => false)).toEqual({ url: "mcp://server/urn:example:doc#frag" });
  });
  it("rejects malformed ranges", () => {
    for (const suffix of [":raw", ":abc", ":", ":0", ":-1", ":1+0", ":2-1"]) {
      expect(() => splitSelectors(`artifact://bash/a.log${suffix}`, () => true)).toThrow(/invalid|reversed|range/);
    }
    // a composed chain narrows: :2-3:2-2 resolves to line 3 only
    expect(splitSelectors("artifact://bash/a.log:2-3:2-2", () => true).range).toEqual({ start: 3, end: 3 });
  });
});

describe("read tool", () => {
  it("returns the full text of the selected line range", async () => {
    const url = await store.writeArtifact("bash", Buffer.from("alpha\nbeta\ngamma"), { mediaType: "text/plain" });
    expect(await read(`${url}:2-3`)).toBe("beta\ngamma");
    expect(await read(`${url}:2-3:2-2`)).toBe("gamma");
    expect(await read(url)).toBe("alpha\nbeta\ngamma");
  });
  it("returns metadata without fetching", async () => {
    const url = await store.registerAsset("https://example.com/photo.jpg", { mediaType: "image/*", sourceInfo: { fileSize: "169667" } });
    const result = await read(`${url}?view=meta`);
    expect(typeof result).toBe("string");
    expect(result).toContain("169667");
    expect(result).toContain("not fetched yet");
    expect((await store.getMeta("asset", "", url.slice(8)))?.fetchedAt).toBeUndefined();
  });
  it("returns image bytes JSON-safe with the source URL", async () => {
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    const result = await read(url);
    expect(result).toEqual({ type: "file", url, mediaType: "image/png", data: "iVBORw0KGgo=", byteLength: 8 });
    expect((await center.resolve(url)).bytes).toEqual(new Uint8Array(Buffer.from("iVBORw0KGgo=", "base64")));
  });
  it("returns other binary bytes to internal consumers", async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1]);
    const url = await store.writeArtifact("clip", bytes, { mediaType: "video/webm" });
    expect(await read(url)).toMatchObject({ type: "file", data: bytes.toString("base64"), mediaType: "video/webm" });
  });
  it("truncates only in toModelOutput, anchoring at the source url", async () => {
    const text = Array.from({ length: 4500 }, (_, i) => String(i)).join("\n");
    const url = await store.writeArtifact("lines", Buffer.from(text), { mediaType: "text/plain" });
    const full = (await read(url)) as string;
    expect(full.split("\n")).toHaveLength(4500);
    const tool = createReadTool({ center });
    const first = tool.toModelOutput!({ toolCallId: "r", input: { url }, output: full }) as { type: string; value: string };
    expect(first.type).toBe("text");
    const anchor = /Continue: read\(\{url: "([^"]+)"\}\)/.exec(first.value)![1]!;
    expect(anchor).toBe(`${url}:1997+2000`);
    // following the anchor reconstructs the text without skips or repeats
    const second = (await read(anchor)) as string;
    expect(second.split("\n")[0]).toBe("1996");
    const secondOut = tool.toModelOutput!({ toolCallId: "r", input: { url: anchor }, output: second }) as { type: string; value: string };
    expect(secondOut.value).toContain(`${url}:3993+2000`);
    expect((await read(`${url}:4001+500`)) as string).toBe(text.split("\n").slice(4000, 4500).join("\n"));
    expect(await store.names("artifact", "lines")).toHaveLength(1);
    expect(await store.namespaces("artifact")).toEqual(["lines"]);
  });
  it("keeps converted pages inside the unified budget, so the wrapper never re-archives them", async () => {
    const oneLine = "x".repeat(60000);
    const url = await store.writeArtifact("fat", Buffer.from(oneLine), { mediaType: "text/plain" });
    const tool = createReadTool({ center });
    const converted = tool.toModelOutput!({ toolCallId: "r", input: { url }, output: oneLine }) as { type: string; value: string };
    expect(converted.value.length).toBeLessThanOrEqual(30000);
    expect(converted.value).toContain("only reachable inside codemode or the sandbox");
    const anchor = /Continue: read\(\{url: "([^"]+)"\}\)/.exec(converted.value)![1]!;
    expect(anchor).toBe(`${url}:2+2000`);
  });
  it("streams local files larger than 1 MiB through a line selector", async () => {
    const text = "abcdefghijklmnop\n".repeat(70000);
    await fs.writeFile(path.join(home, "large.txt"), text);
    const slice = (await read("local://large.txt:5-10")) as string;
    expect(slice).toBe("abcdefghijklmnop\n".repeat(6));
  });
  it("rejects whole reads beyond the text cap with guidance", async () => {
    await fs.writeFile(path.join(home, "huge.txt"), "x".repeat(MAX_TEXT_CHARS + 1));
    await expect(read("local://huge.txt")).rejects.toMatchObject({ code: "resource_too_large" });
  });
  it("propagates typed errors", async () => {
    await expect(read("artifact://bash/missing.txt")).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(read("wat://x")).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});

describe("shared truncate", () => {
  it("handles exact boundaries, the line cap and mid-line cuts", () => {
    // A single line stops at the per-line cap, well before the character budget.
    expect(truncate("a".repeat(TEXT_BUDGET.maxLineChars))).toBeUndefined();
    const over = truncate("a".repeat(TEXT_BUDGET.maxLineChars + 1))!;
    expect(over.visible).toHaveLength(TEXT_BUDGET.maxLineChars);
    expect(over.partialLine).toBe(true);
    expect(over.nextLine).toBe(2);
    const lineCap = truncate("a\n".repeat(2500))!;
    expect(lineCap.visible.split("\n")).toHaveLength(2000);
    expect(lineCap.nextLine).toBe(2001);
    expect(lineCap.partialLine).toBeUndefined();
    const lines = truncate("a\n".repeat(1999));
    expect(lines).toBeUndefined();
  });
  it("read's reserved budget keeps the footer inside the shared cap", () => {
    const oneFatLine = "x".repeat(60000);
    const cut = truncate(oneFatLine, { ...readBudget() })!;
    expect(cut.visible).toHaveLength(TEXT_BUDGET.maxLineChars);
    expect(cut.partialLine).toBe(true);
    expect(cut.nextLine).toBe(2);
  });
});
