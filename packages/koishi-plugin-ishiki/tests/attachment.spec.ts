import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, createToolMessage, type ToolResultOutput } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { supportsImageInput } from "../src/attachment/capabilities.js";
import { processOutput } from "../src/attachment/output.js";
import { attachmentMessages, projectAttachments } from "../src/attachment/projection.js";
import { createReadTool, type ReadResult } from "../src/builtin-tools/read.js";
import { collapse } from "../src/context/standard.engine.js";
import { V3ContextInstance } from "../src/context/v3.engine.js";
import { ResourceCenter } from "../src/resources/center.js";
import { textPage } from "../src/resources/text.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=";
let home: string;
let center: ResourceCenter;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-attachment-"));
  center = new ResourceCenter("rt", home);
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function process(value: unknown, converted: ToolResultOutput = { type: "json", value: value as never }, name = "probe") {
  return processOutput(center, name, "call-1", value, converted);
}

function toolMessage(toolName = "probe", toolCallId = "call-1", output: ToolResultOutput = { type: "text", value: "ok" }) {
  return createToolMessage([{ type: "tool-result", toolName, toolCallId, output }]);
}

describe("attachment output", () => {
  it("extracts explicit MCP, content, and nested media without mutating internal values", async () => {
    for (const value of [
      [
        { type: "text", text: "screenshot" },
        { type: "image", mimeType: "image/png", data: PNG },
      ],
      {
        type: "content",
        value: [
          { type: "text", text: "screenshot" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
        ],
      },
      { note: "screenshot", result: { type: "image", mediaType: "image/png", data: PNG } },
    ]) {
      const saved = JSON.stringify(value);
      const result = await process(value);
      expect(JSON.stringify(value)).toBe(saved);
      expect(JSON.stringify(result.output)).not.toContain(PNG);
      expect(JSON.stringify(result.output)).toContain("screenshot");
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ mediaType: "image/png", width: 1, height: 1 });
      expect([...((await center.resolve(result.items[0]!.url)).bytes ?? [])]).toEqual([...Buffer.from(PNG, "base64")]);
    }
    expect(await center.store.names("artifact", "probe")).toHaveLength(1);
  });
  it("does not guess ordinary fields or serialized strings and preserves short JSON types", async () => {
    for (const value of [{ ok: true, ids: ["m1"] }, { data: PNG }, [{ type: "event", data: PNG }], "json string", null, false]) {
      const result = await process(value);
      expect(result.output).toEqual({ type: "json", value });
      expect(result.items).toEqual([]);
    }
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });
  it("reuses tagged artifact URLs and archives mutable local media", async () => {
    const url = await center.store.writeArtifact("source", Buffer.from(PNG, "base64"), { mediaType: "image/png" });
    const result = await process({ type: "content", value: [{ type: "file", mediaType: "image/png", data: { type: "url", url } }] });
    expect(result.items[0]?.url).toBe(url);
    expect(await center.store.namespaces("artifact")).toEqual(["source"]);
    await fs.writeFile(path.join(home, "image.png"), Buffer.from(PNG, "base64"));
    const local = await process({ type: "media", mediaType: "image/png", url: "local://image.png" });
    expect(local.items[0]?.url).toMatch(/^artifact:\/\/probe\//);
  });
  it("normalizes default JSON values like the SDK", async () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect((await process({ date, unused: undefined })).output).toEqual({ type: "json", value: { date: date.toISOString() } });
    expect((await process(undefined)).output).toEqual({ type: "json", value: null });
  });
  it("preserves native conversion, content metadata, and denied/error semantics", async () => {
    const value = { secret: "internal", ok: true };
    const converted = { type: "text", value: "native preview", providerOptions: { example: { hint: "keep" } } } as const;
    expect((await process(value, converted)).output).toEqual(converted);
    const content = { type: "content", value: [{ type: "text", text: "native", providerOptions: { example: { hint: "keep" } } }] } as const;
    expect((await process(value, content as unknown as ToolResultOutput)).output).toEqual(content);
    for (const output of [
      { type: "error-text", value: "failed" },
      { type: "error-json", value: { failed: true } },
      { type: "execution-denied", reason: "denied" },
    ] as ToolResultOutput[])
      expect((await process(value, output)).output).toBe(output);
  });
  it("archives full JSON and a stable media-free readable view, with precise continuation", async () => {
    const value = { stdout: "x".repeat(60000), screenshot: { type: "image", mimeType: "image/png", data: PNG }, exitCode: 0 };
    const result = await process(value);
    expect(result.output.type).toBe("text");
    const output = result.output as { type: "text"; value: string };
    expect(output.value).toContain('"stdout": "xxxx');
    expect(output.value).toContain("#offset=30000");
    expect(output.value).not.toContain(PNG);
    const url = /Full result: (artifact:\/\/\S+)/.exec(output.value)![1]!;
    const parsed = ResourceCenter.parse(url);
    const raw = await center.store.readBytes("artifact", parsed.authority, parsed.segments.at(-1)!);
    expect(JSON.parse(Buffer.from(raw).toString())).toEqual(value);
    const read = createReadTool({ center });
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const page = (await read.execute!({ url: `${url}#offset=${offset}` }, { toolCallId: "r", messages: [] })) as ReadResult;
      if (page.kind !== "text") throw new Error("expected text");
      pages.push(page.page.text);
      const converted = await read.toModelOutput!({ toolCallId: "r", input: { url }, output: page });
      await processOutput(center, "read", "r", page, converted);
      if (page.page.nextOffset === undefined) break;
      offset = page.page.nextOffset;
    }
    expect(pages.join("")).not.toContain(PNG);
    expect(JSON.parse(pages.join("")).exitCode).toBe(0);
    expect(await center.store.names("artifact", "probe")).toHaveLength(2);
    expect(await center.store.namespaces("artifact")).toEqual(["probe"]);
    const original = (await read.execute!({ url: `${url}?view=original#offset=60000` }, { toolCallId: "r", messages: [] })) as ReadResult;
    expect(original.kind === "text" && original.page.text).toContain(PNG);
  });
  it("reports archival failure without a fabricated URL", async () => {
    const broken = new ResourceCenter("broken", path.join(home, "file"));
    await fs.writeFile(broken.home, "not a directory");
    await expect(
      processOutput(broken, "probe", "c", [{ type: "image", mimeType: "image/png", data: PNG }], {
        type: "json",
        value: [{ type: "image", mimeType: "image/png", data: PNG }],
      }),
    ).rejects.toThrow(/ENOTDIR|EEXIST|directory/);
  });
});

describe("text budget", () => {
  it("handles exact boundaries, newline continuations and surrogate pairs", async () => {
    expect((await textPage("a".repeat(30000))).nextOffset).toBeUndefined();
    expect((await textPage("a".repeat(30001))).nextOffset).toBe(30000);
    const original = "a".repeat(29999) + String.fromCodePoint(0x1f600) + "z";
    const first = await textPage(original);
    expect(first.nextOffset).toBe(29999);
    const next = await textPage(original, { offset: first.nextOffset });
    expect(first.text + next.text).toBe(original);
    const lines = await textPage("a\n".repeat(2000));
    expect(lines.nextOffset).toBeUndefined();
  });
});

describe("request projection", () => {
  it("ignores orphaned, denied and failed tools, and respects platform retraction", async () => {
    const item = (await process([{ type: "image", mimeType: "image/png", data: PNG }])).items[0]!;
    const orphan = createCustomMessage("ishiki.attachment", { source: "tool", toolName: "probe", toolCallId: "call-1", items: [item] });
    expect(attachmentMessages([orphan])).toEqual([]);
    for (const output of [{ type: "error-text", value: "failed" }, { type: "execution-denied" }] as ToolResultOutput[])
      expect(attachmentMessages([toolMessage("probe", "call-1", output), orphan])).not.toContain(orphan);
    expect(attachmentMessages([toolMessage(), orphan])).toContain(orphan);
    const event = createCustomMessage("ishiki.message.created", {
      timestamp: 1,
      platform: "test",
      selfId: "bot",
      channelId: "channel",
      messageId: "m",
      isDirect: true,
      user: { id: "u" },
      content: `<img src="${item.url.replace("artifact://", "asset://")}"/>`,
    });
    expect(attachmentMessages([event]).filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(1);
    const deleted = createCustomMessage("ishiki.message.deleted", { timestamp: 2, platform: "test", selfId: "bot", channelId: "channel", messageId: "m" });
    expect(attachmentMessages([event, deleted]).filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(0);
  });
  it("shares quotas across messages, avoids duplicates and resets on replay", async () => {
    const first = (await process([{ type: "image", mimeType: "image/png", data: PNG }], undefined, "a")).items[0]!;
    const second = (await process([{ type: "image", mimeType: "image/png", data: PNG }], undefined, "b")).items[0]!;
    const messages = [
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "a", toolCallId: "1", items: [first, first] }),
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "b", toolCallId: "2", items: [second] }),
    ];
    for (let replay = 0; replay < 2; replay++) {
      const result = await projectAttachments(messages, center, { imageInput: true, maxImageCount: 1 });
      expect(JSON.stringify(result)).toContain("already represented");
      expect(JSON.stringify(result)).toContain("count limit");
      expect(result.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "file") : []))).toHaveLength(1);
    }
    for (const policy of [{ imageInput: false }, { imageInput: true, maxImageBytes: 1 }, { imageInput: true, maxTotalImageBytes: 1 }]) {
      const result = await projectAttachments(messages, center, policy);
      expect(result.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "file") : []))).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(PNG);
      expect(JSON.stringify(result)).toContain(first.url);
    }
    const largePng = Buffer.from(PNG, "base64");
    largePng.writeUInt32BE(10000, 16);
    largePng.writeUInt32BE(10000, 20);
    const oversized = await center.store.writeArtifact("oversized", largePng, { mediaType: "image/png" });
    const hugeDimensions = createCustomMessage("ishiki.attachment", {
      source: "tool",
      toolName: "probe",
      toolCallId: "large",
      items: [{ url: oversized, mediaType: "image/png", width: 10000, height: 10000 }],
    });
    const missing = createCustomMessage("ishiki.attachment", {
      source: "tool",
      toolName: "probe",
      toolCallId: "missing",
      items: [{ url: "artifact://probe/missing", mediaType: "image/png" }],
    });
    const absent = await projectAttachments([missing], center, { imageInput: true });
    expect(JSON.stringify(absent)).toContain("resource unavailable");
    expect(JSON.stringify(absent)).not.toContain(PNG);
    const knownDimensions = await projectAttachments([hugeDimensions], center, { imageInput: true, maxImageDimension: 1 });
    expect(JSON.stringify(knownDimensions)).toContain("dimension limit");
  });
  it("keeps attachments in standard and v3 context engines", async () => {
    const message = createCustomMessage("ishiki.attachment", { source: "tool", toolName: "probe", toolCallId: "call-1", items: [] });
    expect(collapse([toolMessage(), message])).toContain(message);
    const v3 = new V3ContextInstance({}, { root: home, logger: { error() {} } } as never);
    expect(v3.renderMessages([toolMessage(), message])).toContain(message);
  });
  it("requires image capability on every failover member, including unavailable members", () => {
    const gateway = createGateway({
      config: {
        providers: {
          mock: {
            api: "openai-completions",
            apiKey: "unused",
            models: [
              { id: "vision", type: "language", input: ["text", "image"] },
              { id: "text", type: "language", input: ["text"] },
            ],
          },
        },
        groups: { mixed: { models: ["mock:vision", "mock:text"] }, vision: { models: ["mock:vision"] } },
      },
    });
    expect(supportsImageInput(gateway, "mock:vision")).toBe(true);
    expect(supportsImageInput(gateway, "mock:text")).toBe(false);
    expect(supportsImageInput(gateway, "mixed")).toBe(false);
    expect(supportsImageInput(gateway, "vision")).toBe(true);
    expect(supportsImageInput(gateway, "mock:unknown")).toBe(false);
  });
});
