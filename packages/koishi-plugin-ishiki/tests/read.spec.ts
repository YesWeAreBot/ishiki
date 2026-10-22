import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { asSchema } from "@yesimagent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReadTool, type ReadTool } from "../src/builtin-tools/read.js";
import { ResourceCenter } from "../src/resource/center.js";
import { processOutput } from "../src/resource/output.js";
import { ResourceStore } from "../src/resource/store.js";
import { TEXT_BUDGET } from "../src/resource/text.js";

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

async function visibleRead(url: string) {
  const tool = createReadTool({ center });
  const raw = (await tool.execute!({ url }, { toolCallId: "read-1", messages: [] })) as ReadTool.Output;
  const converted = await tool.toModelOutput!({ toolCallId: "read-1", input: { url }, output: raw });
  const { output } = await processOutput(center, "read", converted, raw);
  if (raw.type !== "text" || output.type !== "text") throw new Error("expected a text read page");
  expect(output.value.length).toBeLessThanOrEqual(TEXT_BUDGET.maxChars);
  expect(output.value.split("\n").length).toBeLessThanOrEqual(TEXT_BUDGET.maxLines);
  const call = /read\((\{"url":.*\})\)$/.exec(output.value);
  let next: string | undefined;
  if (call !== null) {
    const decoded: unknown = JSON.parse(call[1]!);
    if (decoded === null || typeof decoded !== "object" || !("url" in decoded) || typeof decoded.url !== "string") throw new Error("invalid continuation call");
    next = decoded.url;
  }
  return { raw, shown: output.value, next };
}

async function reconstruct(url: string): Promise<string> {
  const pieces: string[] = [];
  let current: string | undefined = url;
  let previousOffset = -1;
  while (current !== undefined) {
    const page = await visibleRead(current);
    const offset = page.raw.source?.offset ?? 0;
    const nextOffset = page.next === undefined ? offset + page.raw.text.length : Number(new URL(page.next).searchParams.get("offset"));
    expect(nextOffset).toBeGreaterThanOrEqual(offset);
    expect(nextOffset).toBeGreaterThan(previousOffset);
    const body = page.raw.text.slice(0, nextOffset - offset);
    expect(page.shown.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
    pieces.push(body);
    previousOffset = nextOffset;
    current = page.next;
  }
  return pieces.join("");
}

describe("structured resource reads", () => {
  it("returns the complete selected text and composes ranges without widening them", async () => {
    const url = await store.writeArtifact("seed", Buffer.from("alpha\nbeta\ngamma\ndelta\n"), { mediaType: "text/plain" });
    expect(await read(`${url}:2-3`)).toMatchObject({ type: "text", text: "beta\ngamma\n" });
    expect(await read(`${url}:2-3:2-2`)).toMatchObject({ type: "text", text: "gamma\n" });
    expect(await read(`${url}:2-3:1-100`)).toMatchObject({ type: "text", text: "beta\ngamma\n" });
  });

  it("keeps raw text larger than the old read limit available to code", async () => {
    const text = "x".repeat(9 * 1024 * 1024);
    await fs.writeFile(path.join(home, "large.txt"), text);
    const result = await read("local://large.txt");
    if (result.type !== "text") throw new Error("expected raw text");
    expect(result.text).toBe(text);
    expect(JSON.parse(JSON.stringify(result)).source).toEqual(result.source);
  });

  it("returns JSON-safe media data and the original immutable reference", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const url = await store.writeArtifact("image", bytes, { mediaType: "image/png", filename: "screen.png" });
    const result = await read(url);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      type: "file",
      url,
      data: bytes.toString("base64"),
      mediaType: "image/png",
      byteLength: bytes.length,
      filename: "screen.png",
      immutable: true,
    });
  });

  it("reconstructs a long Unicode line without skips or duplicate artifacts", async () => {
    const text = "猫😀".repeat(28000);
    const url = await store.writeArtifact("seed", Buffer.from(text), { mediaType: "text/plain" });
    expect(await reconstruct(url)).toBe(text);
    expect(await store.namespaces("artifact")).toEqual(["seed"]);
    expect(await store.names("artifact", "seed")).toHaveLength(1);
  });

  it("paginates the line budget while preserving a finite selection", async () => {
    const lines = Array.from({ length: 6500 }, (_, i) => `line-${i + 1}\r\n`);
    const url = await store.writeArtifact("seed", Buffer.from(lines.join("")), { mediaType: "text/plain" });
    expect(await reconstruct(`${url}:501-5500`)).toBe(lines.slice(500, 5500).join(""));
    expect(await store.namespaces("artifact")).toEqual(["seed"]);
  });

  it("does not mistake a UTF-8 probe ending inside a character for binary data", async () => {
    const text = "a".repeat(8191) + "😀\nnext\nlast";
    await fs.writeFile(path.join(home, "unicode.txt"), text);
    expect(await read("local://unicode.txt:2-2")).toMatchObject({ type: "text", text: "next\n", source: { line: 2, column: 1 } });
  });

  it("rejects invalid ranges, queries, and an offset inside a surrogate pair", async () => {
    await fs.writeFile(path.join(home, "text.txt"), "😀abc");
    for (const suffix of [":0", ":2-1", ":1+0", ":raw", "?offset=-1", "?offset=1", "?view=meta&view=meta", "?unknown=1"]) {
      await expect(read(`local://text.txt${suffix}`)).rejects.toMatchObject({ code: "invalid_resource_uri" });
    }
  });

  it("snapshots an ordinary dynamic source once and continues without refetching it", async () => {
    const original = "response😀\n".repeat(6000);
    let calls = 0;
    center.attach({
      scheme: "example",
      resolve: (url) => {
        calls += 1;
        const text = calls === 1 ? original : "changed";
        return { type: "text", url, text, size: Buffer.byteLength(text) };
      },
    });
    expect(await reconstruct("example://large.text")).toBe(original);
    expect(calls).toBe(1);
    expect(await store.names("artifact", "read")).toHaveLength(1);
  });

  it("reports missing resources and unavailable schemes", async () => {
    await expect(read("local://missing.txt")).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(read("unknown://value")).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});

describe("attachment lifetime", () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const call = { toolCallId: "read-1", messages: [], context: undefined };

  it("exposes lifetime only when the call site allows choosing one", () => {
    const disabled = asSchema(createReadTool({ center }).inputSchema).jsonSchema as unknown as { properties: Record<string, unknown> };
    const enabled = asSchema(createReadTool({ center, lifetime: true }).inputSchema).jsonSchema as unknown as { properties: Record<string, unknown> };
    expect(disabled.properties).not.toHaveProperty("lifetime");
    expect(enabled.properties.lifetime).toMatchObject({ enum: ["once", "recent", "retain"] });
    const output = asSchema(createReadTool({ center, lifetime: true }).outputSchema!).jsonSchema as unknown as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    expect(output.oneOf[1]!.properties).toHaveProperty("lifetime");
  });

  it("rejects an unknown lifetime and the choice when the call site disables it", async () => {
    const url = await store.writeArtifact("image", bytes, { mediaType: "image/png", filename: "screen.png" });
    await expect(createReadTool({ center, lifetime: true }).execute!({ url, lifetime: "forever" as never }, call)).rejects.toMatchObject({
      code: "invalid_attachment_lifetime",
    });
    await expect(createReadTool({ center }).execute!({ url, lifetime: "recent" }, call)).rejects.toMatchObject({ code: "invalid_attachment_lifetime" });
  });
});
