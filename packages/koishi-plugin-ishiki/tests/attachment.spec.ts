import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCustomMessage,
  createToolMessage,
  jsonSchema,
  tool,
  type Agent,
  type AgentMessage,
  type JSONValue,
  type ToolResultOutput,
  type ToolSet,
} from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCodemode } from "../src/builtin-tools/codemode.js";
import { createFinish } from "../src/builtin-tools/finish.js";
import { createReadTool } from "../src/builtin-tools/read.js";
import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { collapse } from "../src/context/standard.engine.js";
import { FailoverModel } from "../src/failover.js";
import { CodemodeConfig, ToolsearchConfig, TypingConfig } from "../src/profile/config.js";
import { supportsImageInput } from "../src/resource/capabilities.js";
import { captureResources } from "../src/resource/capture.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AttachmentConfig } from "../src/resource/config.js";
import { processOutput } from "../src/resource/output.js";
import { attachmentMessages, projectAttachments, type AttachmentLedger } from "../src/resource/projection.js";
import { TEXT_BUDGET } from "../src/resource/text.js";
import { AgentRuntime } from "../src/runtime.js";
import { StandardWakeupInstance } from "../src/wakeup/index.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=";
const PNG_BUFFER = Buffer.from(PNG, "base64");
const logger = { warn() {}, error() {}, info() {}, debug() {}, level: 1 } as never;
let home: string;
let center: ResourceCenter;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-attachment-"));
  center = new ResourceCenter("rt", home);
});
const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { force: true, recursive: true });
});

async function process(value: unknown, converted: ToolResultOutput = { type: "json", value: value as JSONValue }, name = "probe") {
  return processOutput(center, name, converted);
}

/** Bytes behind a stored media URL; fails when the URL is not a file payload. */
async function fileBytes(center: ResourceCenter, url: string): Promise<Uint8Array> {
  const payload = await center.resolve(url);
  if (payload.type !== "file") throw new Error(`expected media at ${url}`);
  return payload.bytes;
}

function jsonValue(output: ToolResultOutput): JSONValue {
  if (output.type !== "json") throw new Error("expected json output");
  return output.value;
}

function textOf(output: ToolResultOutput): string {
  if (output.type !== "text") throw new Error("expected text output");
  return output.value;
}

/** The externalized entries of an `attachments` array. */
function attachmentsOf(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || !("attachments" in value) || !Array.isArray(value.attachments)) throw new Error("expected attachments");
  const entries: unknown[] = value.attachments;
  return entries.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");
}

function toolMessage(toolName = "probe", toolCallId = "call-1", output: ToolResultOutput = { type: "text", value: "ok" }) {
  return createToolMessage([{ type: "tool-result", toolName, toolCallId, output }]);
}

/** Inlined image parts of a projected request. */
function imageParts(messages: readonly AgentMessage[]) {
  return messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : [],
  );
}

async function attachmentFor(name: string, callId: string) {
  const item = (await process({ attachments: [imageBlock()] }, undefined, name)).items[0]!;
  return createCustomMessage("ishiki.attachment", { source: "tool", toolName: name, toolCallId: callId, items: [item] });
}

function imageBlock(data = PNG) {
  return { type: "image", mimeType: "image/png", data };
}

describe("platform capture", () => {
  it("preserves document order when lazy registrations complete out of order", async () => {
    const register = center.store.registerAsset.bind(center.store);
    const fileRegistered = Promise.withResolvers<void>();
    center.store.registerAsset = async (src, meta) => {
      const image = src.startsWith("data:image/png");
      if (image) await fileRegistered.promise;
      const url = await register(src, meta);
      if (!image) fileRegistered.resolve();
      return url;
    };
    const captured = await captureResources(
      center,
      `<img src="data:image/png;base64,${PNG}"/><file src="https://cdn.invalid/doc.pdf" file="doc.pdf" size="12"/>`,
    );
    expect(captured.items).toHaveLength(2);
    expect(captured.items[0]).toMatchObject({ mediaType: "image/*" });
    expect(captured.items[1]).toMatchObject({ mediaType: "application/octet-stream", filename: "doc.pdf" });
    expect(captured.content).not.toContain("data:image/png");
    expect(captured.content).toContain(`src="${captured.items[0]!.url}"`);
    expect(captured.content).toContain(`src="${captured.items[1]!.url}"`);
    const meta = await center.store.getMeta("asset", "", captured.items[0]!.url.slice("asset://".length));
    expect(meta).toMatchObject({ mediaType: "image/*", src: `data:image/png;base64,${PNG}` });
    expect(meta?.fetchedAt).toBeUndefined();
  });
});

describe("json branch: the attachments field", () => {
  it("extracts attachment entries and strips their payloads in place", async () => {
    const result = await process({ summary: "screenshot", attachments: [imageBlock()] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ mediaType: "image/png", byteLength: PNG_BUFFER.byteLength });
    expect(JSON.stringify(result.output)).not.toContain(PNG);
    expect(result.output).toMatchObject({ type: "json", value: { summary: "screenshot" } });
    const [entry] = attachmentsOf(jsonValue(result.output));
    expect(String(entry!.url)).toMatch(/^artifact:\/\/probe\//);
    expect(entry!.byteLength).toBe(PNG_BUFFER.byteLength);
    expect(entry!.data).toBeUndefined();
    expect(Buffer.from(await fileBytes(center, result.items[0]!.url)).equals(PNG_BUFFER)).toBe(true);
  });

  it("accepts read file results and an embedded MCP resource", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const readNode = { type: "file", url, mediaType: "image/png", data: PNG, byteLength: PNG_BUFFER.byteLength, immutable: true };
    const resourceEntry = { type: "resource", resource: { uri: "mcp://srv/doc", mimeType: "image/png", blob: PNG } };
    const result = await process({ attachments: [readNode, resourceEntry] });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.url).toBe(url); // hash match reuses the source
    expect(result.items[1]!.url).toMatch(/^artifact:\/\/probe\//);
    const [first, second] = attachmentsOf(jsonValue(result.output));
    expect(first!.url).toBe(url);
    expect(first!.data).toBeUndefined();
    expect(second!.resource).toEqual({ uri: "mcp://srv/doc", mimeType: "image/png" });
    expect(await center.store.names("artifact", "probe")).toHaveLength(1);
  });

  it("archives changed bytes instead of trusting the accompanying source URL", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const changed = {
      type: "file",
      url,
      mediaType: "image/png",
      data: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64"),
      byteLength: 7,
      immutable: true,
    };
    const result = await process({ attachments: [changed] });
    expect(result.items[0]!.url).toMatch(/^artifact:\/\/probe\//);
    expect(result.items[0]!.url).not.toBe(url);
    expect([...(await fileBytes(center, url))]).toEqual([...PNG_BUFFER]);
  });

  it("reuses an immutable store URL without a payload", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const result = await process({ ok: true, attachments: [{ type: "file", mediaType: "image/png", url }] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.url).toBe(url);
    expect(result.output).toMatchObject({ type: "json", value: { ok: true } });
    expect(await center.store.names("artifact", "probe")).toEqual([]);
  });

  it("materializes a lazy asset reference without copying it", async () => {
    const url = await center.store.registerAsset(`data:image/png;base64,${PNG}`);
    const result = await process({ attachments: [{ type: "file", mediaType: "image/png", url }] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.url).toBe(url);
    expect(Buffer.from(await fileBytes(center, url)).equals(PNG_BUFFER)).toBe(true);
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });

  it("snapshots live URL media before the attachment is submitted", async () => {
    const live = path.join(home, "media", "live.png");
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, PNG_BUFFER);
    const result = await process({ attachments: [{ type: "file", url: "local://media/live.png", mediaType: "image/png" }] });
    expect(result.items).toHaveLength(1);
    const snapshot = result.items[0]!.url;
    expect(snapshot).toMatch(/^artifact:\/\/probe\//);
    expect(result.items[0]!.byteLength).toBe(PNG_BUFFER.byteLength);

    // overwriting the live file must not change the submitted media
    await fs.writeFile(live, Buffer.from([1, 2, 3]));
    expect(Buffer.from(await fileBytes(center, snapshot)).equals(PNG_BUFFER)).toBe(true);
    expect(await center.store.names("artifact", "probe")).toHaveLength(1);
  });

  it("reports an unusable URL instead of fabricating a reference", async () => {
    const url = "artifact://missing/none.bin";
    const result = await process({ attachments: [{ type: "file", mediaType: "image/png", url }] });
    expect(result.items).toEqual([]);
    const [failed] = attachmentsOf(jsonValue(result.output));
    expect(failed!.url).toBe(url);
    expect(failed!.error).toContain(url);
  });

  it("never guesses media outside the attachments field", async () => {
    for (const value of [
      [imageBlock()], // bare MCP blocks array: ordinary JSON
      { note: "screenshot", result: imageBlock() },
      { attachment: [imageBlock()] }, // the superseded singular field is not read
      { data: PNG },
      { ok: true, ids: ["m1"] },
      "json string",
      null,
      false,
    ]) {
      const result = await process(value);
      expect(result.output).toEqual({ type: "json", value });
      expect(result.items).toEqual([]);
    }
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });

  it("normalizes SDK default JSON values like Dates", async () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect((await process({ date, unused: undefined })).output).toEqual({ type: "json", value: { date: date.toISOString() } });
    expect((await process(undefined)).output).toEqual({ type: "json", value: null });
  });

  it("leaves denied and error outputs untouched", async () => {
    for (const output of [
      { type: "error-text", value: "failed" },
      { type: "error-json", value: { failed: true } },
      { type: "execution-denied", reason: "denied" },
    ] as ToolResultOutput[])
      expect((await process(imageBlock(), output)).output).toBe(output);
  });
});

describe("content branch: file parts from native conversions", () => {
  it("archives file parts, reuses immutable URLs, and keeps text parts", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const converted: ToolResultOutput = {
      type: "content",
      value: [
        { type: "text", text: "screenshot" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
        { type: "file", mediaType: "image/png", data: { type: "url", url: new URL(url), originalUrl: url } },
        { type: "file", mediaType: "image/png", data: { type: "url", url: new URL("https://example.com/a.png") } },
      ],
    };
    const result = await process({ note: true }, converted, "mcp");
    expect(result.items).toHaveLength(2);
    expect(result.items[1]!.url).toBe(url);
    expect(JSON.stringify(result.output)).not.toContain(PNG);
    expect(result.output).toMatchObject({
      type: "content",
      value: [{ type: "text", text: "screenshot" }, { type: "text" }, { type: "text" }, { type: "text" }],
    });
    expect(JSON.stringify(result.output)).toContain("[attachment:");
    expect(JSON.stringify(result.output)).toContain("[unloaded media: https://example.com/a.png");
    expect(await center.store.names("artifact", "mcp")).toHaveLength(1);
  });

  it("reuses an immutable read image instead of archiving it twice", async () => {
    const url = await center.store.writeArtifact("media", PNG_BUFFER, { mediaType: "image/png" });
    const read = createReadTool({ center });
    const node = await read.execute!({ url }, { toolCallId: "r", messages: [] });
    expect(node.type).toBe("file");
    const converted = read.toModelOutput!({ toolCallId: "r", input: { url }, output: node });
    const result = await processOutput(center, "read", converted, node);
    expect(result.items[0]!.url).toBe(url);
    expect(await center.store.names("artifact", "read")).toEqual([]);
  });

  it("snapshots a live read image so a later overwrite cannot change it", async () => {
    const live = path.join(home, "media", "shot.png");
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, PNG_BUFFER);
    const read = createReadTool({ center });
    const node = await read.execute!({ url: "local://media/shot.png" }, { toolCallId: "r", messages: [] });
    if (node.type !== "file") throw new Error("expected file result");
    expect(node.immutable).toBe(false);
    const converted = read.toModelOutput!({ toolCallId: "r", input: { url: "local://media/shot.png" }, output: node });
    const result = await processOutput(center, "read", converted, node);
    expect(result.items[0]!.url).toMatch(/^artifact:\/\/read\//);
    await fs.writeFile(live, Buffer.from([1, 2, 3]));
    expect(Buffer.from(await fileBytes(center, result.items[0]!.url)).equals(PNG_BUFFER)).toBe(true);
  });

  it("preserves native conversions without media and passes errors through", async () => {
    const converted = { type: "text", value: "native preview", providerOptions: { example: { hint: "keep" } } } as const;
    expect((await process({ secret: "internal" }, converted)).output).toEqual(converted);
    const content: ToolResultOutput = {
      type: "content",
      value: [{ type: "text", text: "native", providerOptions: { example: { hint: "keep" } } }],
    };
    expect((await process(content, content)).output).toEqual(content);
  });

  it("reports invalid base64 payloads instead of archiving garbage", async () => {
    await expect(process({ attachments: [{ type: "image", mimeType: "image/png", data: "not base64!" }] })).rejects.toThrow(/base64/);
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });
});

describe("text budget", () => {
  it("archives a long result once and reconstructs it through the continuation URL", async () => {
    const value = { attachments: [imageBlock()], stdout: "x".repeat(20000), stderr: "y".repeat(20000) };
    const result = await process(value);
    const output = textOf(result.output);
    const url = /Full result: (artifact:\/\/\S+)/.exec(output)?.[1];
    expect(url).toBeDefined();
    const current = url!;
    expect(output).toContain("Continue: read(");

    const stored = await center.resolve(current);
    if (stored.type !== "text") throw new Error("expected text artifact");
    const roundTrip: unknown = JSON.parse(stored.text);
    expect(roundTrip).toMatchObject({ stdout: "x".repeat(20000) }); // the full view is intact
    const [media] = attachmentsOf(roundTrip);
    expect(media!.data).toBeUndefined(); // payload stripped in the view
    expect(media!.url).toMatch(/^artifact:\/\/probe\//);
    expect(await center.store.names("artifact", "probe")).toHaveLength(2); // media + text view

    // the continuation URL reads the archive without re-running the tool
    const target: unknown = JSON.parse(/Continue: read\((\{"url":"[^"]+"\})\)/.exec(output)?.[1] ?? "null");
    if (target === null || typeof target !== "object" || !("url" in target) || typeof target.url !== "string") throw new Error("expected continuation");
    expect(target.url.startsWith(`${current}?offset=`)).toBe(true);
    const read = createReadTool({ center });
    const page = await read.execute!({ url: target.url }, { toolCallId: "r", messages: [] });
    if (page.type !== "text") throw new Error("expected text page");
    const consumed = Number(new URL(target.url).searchParams.get("offset"));
    expect(page.text).toBe(stored.text.slice(consumed));
  });

  it("keeps short JSON typed as json so consumers like send_message keep working", async () => {
    const result = await process({ ok: true, ids: ["m1"] });
    expect(result.output).toEqual({ type: "json", value: { ok: true, ids: ["m1"] } });
  });

  it("does not re-archive an already-converted read page", async () => {
    const text = "line\n".repeat(9000);
    const url = await center.store.writeArtifact("big", Buffer.from(text), { mediaType: "text/plain" });
    const read = createReadTool({ center });
    const raw = await read.execute!({ url }, { toolCallId: "r", messages: [] });
    if (raw.type !== "text") throw new Error("expected text result");
    const converted = read.toModelOutput!({ toolCallId: "r", input: { url }, output: raw });
    if (converted.type !== "text") throw new Error("expected text conversion");
    const result = await processOutput(center, "read", converted, raw);
    expect(result.output).toBe(converted);
    expect(converted.value).toContain(`Continue: read({"url":"${url}?offset=`);
    expect(await center.store.names("artifact", "read")).toEqual([]);
  });

  it("never archives a source-aware page, even when the conversion exceeds the budget", async () => {
    const huge = "x".repeat(50_000);
    const source = { url: "artifact://probe/huge.bin", offset: 0, line: 1, column: 1 };
    const raw = { type: "text", url: source.url, text: huge, size: huge.length, source };
    const result = await processOutput(center, "probe", { type: "text", value: huge }, raw);
    const value = textOf(result.output);
    expect(value).toContain(`Continue: read({"url":"${source.url}?offset=`);
    expect(value.length).toBeLessThanOrEqual(TEXT_BUDGET.maxChars);
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });
});

describe("request projection", () => {
  it("ignores orphaned, denied and failed tools, and respects platform retraction", async () => {
    const orphan = await attachmentFor("probe", "call-1");
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
      content: `<img src="asset://${"a".repeat(32)}"/>`,
    });
    const platformAttachment = createCustomMessage("ishiki.attachment", {
      source: "platform",
      platform: "test",
      selfId: "bot",
      channelId: "channel",
      messageId: "m",
      items: [{ url: `asset://${"a".repeat(32)}`, mediaType: "image/*" }],
    });
    expect(attachmentMessages([event, platformAttachment])).toContain(platformAttachment);
    const deleted = createCustomMessage("ishiki.message.deleted", { timestamp: 2, platform: "test", selfId: "bot", channelId: "channel", messageId: "m" });
    expect(attachmentMessages([event, platformAttachment, deleted])).not.toContain(platformAttachment);
  });

  it("drains capacity oldest-first, leaves the rest waiting, and renders each item once", async () => {
    const first = (await process({ attachments: [imageBlock()] }, undefined, "a")).items[0]!;
    const second = (await process({ attachments: [imageBlock()] }, undefined, "b")).items[0]!;
    const messages = [
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "a", toolCallId: "1", items: [first] }),
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "b", toolCallId: "2", items: [second] }),
    ];
    const ledger: AttachmentLedger = { slots: new Map() };
    const result = await projectAttachments(messages, center, { imageInput: true, maxImageCount: 1 }, ledger);
    // The older item takes the only slot; the newer one waits without a message.
    expect(result).toHaveLength(1);
    expect(imageParts(result)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PNG);

    // The next request has capacity again: the waiting item is delivered, the spent one is gone.
    const next = await projectAttachments(messages, center, { imageInput: true, maxImageCount: 1 }, ledger);
    expect(next).toHaveLength(1);
    expect(JSON.stringify(next)).toContain("tool b, call 2");
    expect(imageParts(next)).toHaveLength(1);

    // Third request: nothing is left to say.
    expect(await projectAttachments(messages, center, { imageInput: true, maxImageCount: 1 }, ledger)).toEqual([]);
  });

  it("renders an item at most maxImageRenders times", async () => {
    const item = (await process({ attachments: [imageBlock()] }, undefined, "a")).items[0]!;
    const messages = [createCustomMessage("ishiki.attachment", { source: "tool", toolName: "a", toolCallId: "1", items: [item] })];
    const ledger: AttachmentLedger = { slots: new Map() };
    const policy = { imageInput: true, maxImageRenders: 2 };
    expect(imageParts(await projectAttachments(messages, center, policy, ledger))).toHaveLength(1);
    expect(imageParts(await projectAttachments(messages, center, policy, ledger))).toHaveLength(1);
    expect(await projectAttachments(messages, center, policy, ledger)).toEqual([]);
  });

  it("states a terminal rejection once and never repeats it", async () => {
    const item = (await process({ attachments: [imageBlock()] }, undefined, "x")).items[0]!;
    const messages = [createCustomMessage("ishiki.attachment", { source: "tool", toolName: "x", toolCallId: "1", items: [item] })];
    for (const policy of [{ imageInput: false }, { imageInput: true, maxImageBytes: 1 }, { imageInput: true, maxTotalImageBytes: 1 }]) {
      const ledger: AttachmentLedger = { slots: new Map() };
      const result = await projectAttachments(messages, center, policy, ledger);
      expect(imageParts(result)).toHaveLength(0);
      expect(JSON.stringify(result)).toContain(item.url);
      expect(JSON.stringify(result)).toContain("not supplied");
      expect(await projectAttachments(messages, center, policy, ledger)).toEqual([]);
    }
    const missing = createCustomMessage("ishiki.attachment", {
      source: "tool",
      toolName: "x",
      toolCallId: "2",
      items: [{ url: "artifact://x/missing", mediaType: "image/png" }],
    });
    const ledger: AttachmentLedger = { slots: new Map() };
    expect(JSON.stringify(await projectAttachments([missing], center, { imageInput: true }, ledger))).toContain("resource unavailable");
  });

  it("keeps attachments in the standard context engine", async () => {
    const message = createCustomMessage("ishiki.attachment", { source: "tool", toolName: "probe", toolCallId: "call-1", items: [] });
    expect(collapse([toolMessage(), message])).toContain(message);
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
              { id: "high", type: "language", input: ["text"] },
            ],
          },
        },
        groups: { mixed: { models: ["mock:vision", "mock:text"] }, vision: { models: ["mock:vision"] } },
      },
    });
    expect(supportsImageInput(gateway, "mock:vision")).toBe(true);
    expect(supportsImageInput(gateway, "mock:vision:high")).toBe(true);
    expect(supportsImageInput(gateway, "mock:text")).toBe(false);
    expect(supportsImageInput(gateway, "mixed")).toBe(false);
    expect(supportsImageInput(gateway, "vision")).toBe(true);
    expect(supportsImageInput(gateway, "mock:unknown")).toBe(false);
    // a model id that is itself a think level name must not be stripped
    expect(supportsImageInput(gateway, "mock:high")).toBe(false);
  });
});

type Call = { name: string; input: unknown; id?: string };
function reply(calls: Call[]): Response {
  const chunks =
    calls.length > 0
      ? [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id ?? `call-${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "vision", ...chunk })}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

interface ProviderMessage {
  role?: string;
  content?: unknown;
}

interface ProviderBody {
  messages: ProviderMessage[];
}

/** Validate the fixture request body once; individual fields are read with typeof checks below. */
function providerBody(raw: unknown): ProviderBody {
  if (raw === null || typeof raw !== "object" || !("messages" in raw) || !Array.isArray(raw.messages)) throw new Error("unexpected provider body");
  return { messages: raw.messages };
}

/** Image URLs the provider actually received, in message order. */
function imageUrls(body: ProviderBody): string[] {
  const urls: string[] = [];
  for (const message of body.messages) {
    if (message.role !== "user") continue;
    const content: unknown[] = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part === null || typeof part !== "object" || !("type" in part) || part.type !== "image_url" || !("image_url" in part)) continue;
      const image = part.image_url;
      if (image !== null && typeof image === "object" && "url" in image && typeof image.url === "string") urls.push(image.url);
    }
  }
  return urls;
}

async function scenario(options: {
  codemode?: boolean;
  visual?: boolean;
  search?: boolean;
  failover?: boolean;
  maxImageBytes?: number;
  maxImageCount?: number;
  maxToolOutputBytes?: number;
  direct?: string[];
  steps: (index: number, bodies: ProviderBody[]) => Call[];
  tools?: ToolSet;
}) {
  await loadCodemode();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-smoke-"));
  homes.push(home);
  const resources = new ResourceCenter("smoke", home);
  const bodies: ProviderBody[] = [];
  const gateway = createGateway({
    config: {
      providers: {
        mock: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "test-only",
          models: [{ id: "vision", type: "language", input: options.visual === false ? ["text"] : ["text", "image"] }],
        },
      },
      groups: { vision: { models: ["mock:vision"] } },
    },
    fetch: async (_url, init) => {
      const body = providerBody(JSON.parse(String(init?.body)));
      bodies.push(body);
      return reply(options.steps(bodies.length - 1, bodies));
    },
  });
  const attached = Promise.withResolvers<Agent>();
  const runtime = new AgentRuntime({
    id: "smoke",
    home,
    resources,
    model: options.failover ? new FailoverModel(gateway, "vision", { backoffMs: 0, failoverOn: "unavailable" }, logger) : gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { read: createReadTool({ center: resources }), finish: createFinish(), ...options.tools },
    extensions: [],
    context: {
      attach: (agent) => {
        attached.resolve(agent);
        return () => {};
      },
      renderMessages: (messages) => collapse(messages),
    },
    // 真实 standard 引擎：run() 投递的 created 事实都是私聊，逐条开轮。
    wakeup: new StandardWakeupInstance(),
    codemode: CodemodeConfig({ enable: options.codemode ?? true, direct: options.direct ?? [], maxToolOutputBytes: options.maxToolOutputBytes } as never),
    toolsearch: ToolsearchConfig({ enable: options.search ?? false, resident: options.search ? Object.keys(options.tools ?? {}) : [] } as never),
    debugStream: false,
    logger,
    attachment: AttachmentConfig({
      imageInput: options.visual ?? true,
      ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
      ...(options.maxImageCount === undefined ? {} : { maxImageCount: options.maxImageCount }),
    } as never),
  });
  runtimes.push(runtime);
  let expectedTurns = 0;
  const run = async (content = "hello", messageId = "m1", expectedFailure = false) => {
    const expected = (expectedTurns += 1);
    await runtime.deliver(
      createCustomMessage("ishiki.message.created", {
        platform: "test",
        selfId: "bot",
        channelId: "channel",
        messageId,
        timestamp: 1,
        content,
        isDirect: true,
        user: { id: "u" },
      }),
    );
    await attached.promise;
    // 唤醒在事实提交后异步发生：等到第 expected 个终态轮事件出现再断言。
    for (;;) {
      const entries = await runtime.storage.read();
      const terminal = entries.filter(
        (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
      );
      if (terminal.length >= expected) break;
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 5);
      await tick.promise;
    }
    const entries = await runtime.storage.read();
    const failed = entries.filter((entry) => entry.type === "event" && (entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"));
    expect(failed).toHaveLength(expectedFailure ? 1 : 0);

    return entries.flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
  };
  return { runtime, home, resources, bodies, run, agent: attached.promise };
}

function results(messages: AgentMessage[]) {
  return messages.flatMap((message) => (message.role === "tool" ? message.content : []));
}

type ScreenshotBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

/** An MCP-style tool: raw blocks from execute, standard content parts for direct calls. */
function screenshotTool(blocks: () => ScreenshotBlock[]) {
  return tool({
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => blocks(),
    toModelOutput: ({ output }): ToolResultOutput => ({
      type: "content",
      value: output.map((block) =>
        block.type === "image"
          ? { type: "file" as const, mediaType: block.mimeType, data: { type: "data" as const, data: block.data } }
          : { type: "text" as const, text: block.text },
      ),
    }),
  });
}

const emptyInput = jsonSchema({ type: "object", properties: {} });

describe("real Agent / codemode / provider smoke", () => {
  it("keeps a field inspection return as plain JSON with no media side effects", async () => {
    const blocks: ScreenshotBlock[] = [
      { type: "text", text: "fixture" },
      { type: "image", mimeType: "image/png", data: PNG },
    ];
    const metadata = blocks.map((x) => ({ type: x.type, keys: Object.keys(x), mimeType: x.type === "image" ? x.mimeType : undefined }));
    const probe = await scenario({
      direct: ["inspect"],
      tools: {
        Screenshot: tool({ inputSchema: emptyInput, execute: async () => blocks }),
        inspect: tool({ inputSchema: emptyInput, execute: async () => metadata }),
      },
      steps: (index) => (index === 0 ? [{ name: "inspect", id: "inspection", input: {} }] : [{ name: "finish", input: {} }]),
    });
    const messages = await probe.run();
    expect(results(messages)[0]?.output).toEqual({ type: "json", value: metadata });
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(probe.bodies).toHaveLength(2);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(0);
  });

  it("passes a result over 1 MiB to a second host tool, archives only the outer return, then sends a user image", async () => {
    const bytes = Buffer.concat([PNG_BUFFER, Buffer.alloc(900000)]);
    const base64 = bytes.toString("base64");
    let nativeCalls = 0;
    let received = "";
    const probe = await scenario({
      search: true,
      tools: {
        Screenshot: tool({
          inputSchema: emptyInput,
          execute: async () => [
            { type: "text", text: "screenshot fixture" },
            { type: "image", mimeType: "image/png", data: base64 },
          ],
          toModelOutput: () => {
            nativeCalls++;
            throw new Error("internal native conversion must not run");
          },
        }),
        process_image: tool({
          inputSchema: jsonSchema<{ data: string }>({ type: "object", properties: { data: { type: "string" } }, required: ["data"] }),
          execute: async (input) => {
            received = input.data;
            return { ok: true, size: input.data.length };
          },
        }),
      },
      steps: (index) =>
        index === 0
          ? [
              {
                name: "codemode",
                id: "outer",
                input: {
                  js: "const shot = await tools.Screenshot({}); const processed = await tools.process_image({data: shot[1].data}); return {text: shot[0].text, attachments: [shot[1]], processed};",
                },
              },
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    expect(nativeCalls).toBe(0);
    expect(received === base64, "second host tool receives full base64").toBe(true);
    expect(probe.bodies).toHaveLength(2);
    const attachments = messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment");
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0]!;
    if (attachment.role !== "custom" || attachment.type !== "ishiki.attachment") throw new Error("expected attachment");
    expect(attachment.data).toMatchObject({ source: "tool", toolName: "codemode", toolCallId: "outer" });
    expect(Buffer.from(await fileBytes(probe.resources, attachment.data.items[0]!.url)).equals(bytes)).toBe(true);
    expect(messages.findIndex((m) => m === attachment)).toBeGreaterThan(messages.findIndex((m) => m.role === "tool"));
    expect(results(messages).map((p) => p.toolName)).toEqual(["codemode", "finish"]);
    const events = await fs.readFile(path.join(probe.home, "events.jsonl"), "utf8");
    expect(events).not.toContain(base64.slice(0, 200));
    expect(imageUrls(probe.bodies[0]!)).toHaveLength(0);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)[0]).toBe(`data:image/png;base64,${base64}`);
    expect(JSON.stringify(probe.bodies[1]!.messages.filter((m) => m.role === "tool"))).not.toContain(base64.slice(0, 200));
  }, 20000);

  it("preserves SDK host-output limits without an automatic resource fallback", async () => {
    let nativeCalls = 0;
    const probe = await scenario({
      maxToolOutputBytes: 1024,
      tools: {
        large: tool({
          inputSchema: emptyInput,
          execute: async () => "x".repeat(8000),
          toModelOutput: () => {
            nativeCalls++;
            throw new Error("internal conversion ran");
          },
        }),
      },
      steps: (index) => (index === 0 ? [{ name: "codemode", input: { js: "await tools.large({}); return {ok:true};" } }] : [{ name: "finish", input: {} }]),
    });
    const messages = await probe.run();
    const result = results(messages).find((part) => part.toolName === "codemode");
    expect(["error-text", "error-json"]).toContain(result?.output.type);
    expect(nativeCalls).toBe(0);
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(messages.filter((message) => message.role === "custom" && message.type === "ishiki.attachment")).toEqual([]);
  });

  it("does not archive or project internal media when the outer return contains only status", async () => {
    const probe = await scenario({
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG }] }) },
      steps: (index) =>
        index === 0
          ? [{ name: "codemode", input: { js: "const shot = await tools.Screenshot({}); return {ok:true, length:shot[0].data.length};" } }]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(0);
  });

  it.each([{ visual: false }, { maxImageBytes: 1 }, { failover: true }])("projects direct MCP-style calls through a real provider with %j", async (options) => {
    const probe = await scenario({
      ...options,
      codemode: false,
      tools: {
        Screenshot: screenshotTool(() => [
          { type: "text", text: "fixture" },
          { type: "image", mimeType: "image/png", data: PNG },
        ]),
      },
      steps: (index) => (index === 0 ? [{ name: "Screenshot", id: "direct", input: {} }] : [{ name: "finish", input: {} }]),
    });
    const messages = await probe.run();
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(options.visual === false || options.maxImageBytes === 1 ? 0 : 1);
    expect(JSON.stringify(probe.bodies[1])).toContain("artifact://Screenshot/");
    const denied = options.visual === false || options.maxImageBytes === 1;
    expect(denied && JSON.stringify(probe.bodies[1]).includes(PNG)).toBe(false);
  });

  it("associates concurrent native outputs with their outer call ids and stable item order", async () => {
    const probe = await scenario({
      codemode: false,
      tools: {
        Screenshot: tool({
          inputSchema: emptyInput,
          execute: async () => ({ ok: true }),
          toModelOutput: (): ToolResultOutput => ({
            type: "content",
            value: [
              { type: "text", text: "native" },
              { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
              { type: "file", mediaType: "image/png", filename: "second", data: { type: "data", data: PNG } },
            ],
          }),
        }),
      },
      steps: (index) =>
        index === 0
          ? [
              { name: "Screenshot", id: "a", input: {} },
              { name: "Screenshot", id: "b", input: {} },
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    const attachments = messages.flatMap((m) => (m.role === "custom" && m.type === "ishiki.attachment" ? [m.data] : []));
    expect(attachments.map((a) => a.source === "tool" && a.toolCallId).sort()).toEqual(["a", "b"]);
    expect(attachments.every((a) => a.items[1]?.filename === "second")).toBe(true);
    expect(await probe.resources.store.names("artifact", "Screenshot")).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(1);
    const replayed = await probe.run("replay", "m2");
    expect(replayed.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(2);
    expect(await probe.resources.store.names("artifact", "Screenshot")).toHaveLength(1);
    // Both attachments already spent their single render in the first turn.
    expect(imageUrls(probe.bodies[2]!)).toHaveLength(0);
    // Context trimming cannot revive an attachment whose successful result was removed.
    const agent = await probe.agent;
    const snapshot = await agent.storage.read();
    await agent.storage.clear();
    await agent.storage.append(...snapshot.filter((entry) => entry.type !== "message" || (entry.data.role !== "tool" && entry.data.role !== "assistant")));
    await probe.run("after trimming", "m3");
    expect(imageUrls(probe.bodies[3]!)).toHaveLength(0);
  });

  it("lets read reuse platform media through the attachments array without artifact chains", async () => {
    const probe = await scenario({
      steps: (index, bodies) => {
        if (index > 0) return [{ name: "finish", input: {} }];
        const match = /asset:\/\/[a-f0-9]{32}/.exec(JSON.stringify(bodies[0]));
        return [{ name: "codemode", input: { js: `const image = await tools.read({url:${JSON.stringify(match![0])}}); return {attachments: [image]};` } }];
      },
    });
    const messages = await probe.run(`<img src="data:image/png;base64,${PNG}"/>`);
    expect(imageUrls(probe.bodies[0]!)).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(1);
    expect(await probe.resources.store.names("artifact", "codemode")).toEqual([]);
    expect(await probe.resources.store.names("artifact", "read")).toEqual([]);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(2); // platform + read
  });

  it("keeps send_message ok/ids and delivers artifact media to the adapter payload", async () => {
    const delivered: Array<{ channel: string; content: unknown }> = [];
    const probe = await scenario({
      codemode: false,
      steps: (index) => (index === 0 ? [{ name: "Screenshot", input: {} }] : [{ name: "finish", input: {} }]),
      tools: { Screenshot: screenshotTool(() => [{ type: "image", mimeType: "image/png", data: PNG }]) },
    });
    const url = await probe.resources.store.writeArtifact("image", PNG_BUFFER, { mediaType: "image/png" });
    const send = createSendMessage({
      ctx: {
        bots: {
          "test:bot": {
            sendMessage: async (channel: string, content: unknown) => {
              delivered.push({ channel, content });
              return ["sent-1"];
            },
          },
        },
      } as never,
      logger,
      domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
      typing: TypingConfig({ baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 }),
      resources: probe.resources,
    });
    const result = await send.execute!({ mode: "element", messages: [`<img src="${url}"/>`] }, { toolCallId: "send", messages: [] });
    expect(result).toEqual({ ok: true, ids: ["sent-1"] });
    expect(delivered[0]!.channel).toBe("channel");
    expect(String(delivered[0]!.content)).toContain(`data:image/png;base64,${PNG}`);
    const calls = await scenario({
      codemode: false,
      tools: { send_message: send },
      steps: (index) =>
        index === 0 ? [{ name: "send_message", input: { mode: "element", messages: [`<img src="${url}"/>`] } }] : [{ name: "finish", input: {} }],
    });
    const messages = await calls.run();
    expect(calls.bodies).toHaveLength(1);
    expect(results(messages)[0]?.output).toMatchObject({ type: "json", value: { ok: true, ids: ["sent-1"] } });
  });

  it("archives a long outer text result and replays a read page without another artifact", async () => {
    const raw = ["first line", ...Array.from({ length: 6000 }, (_, i) => "row" + i)].join("\n");
    const probe = await scenario({
      tools: { logs: tool({ inputSchema: emptyInput, execute: async () => raw }) },
      steps: (index, bodies) => {
        if (index === 0) return [{ name: "codemode", id: "logs", input: { js: "return await tools.logs({});" } }];
        if (index === 1) {
          const toolResult = bodies[1]!.messages.find((message) => message.role === "tool");
          const content = typeof toolResult?.content === "string" ? toolResult.content : "";
          const url = /Full result: (artifact:\/\/\S+)/.exec(content)?.[1] ?? "";
          return [
            {
              name: "codemode",
              id: "read",
              input: {
                js: `const page = await tools.read({url:${JSON.stringify(`${url}:2+2000`)}}); return { length: page.text.length, head: page.text.slice(0, 4) };`,
              },
            },
          ];
        }
        return [{ name: "finish", input: {} }];
      },
    });
    const messages = await probe.run();
    const outputs = results(messages);
    const first = outputs[0]!.output;
    expect(first).toMatchObject({ type: "text", value: expect.stringContaining("first line") });
    const url = /Full result: (artifact:\/\/\S+)/.exec(textOf(first))?.[1] ?? "";
    const stored = await probe.resources.resolve(url);
    expect(stored.type === "text" && stored.text === raw).toBe(true);
    expect(outputs[1]?.output).toMatchObject({ type: "json", value: { length: expect.any(Number), head: "row0" } });
    const second = jsonValue(outputs[1]!.output);
    if (second === null || typeof second !== "object" || !("length" in second) || typeof second.length !== "number") throw new Error("expected length");
    expect(second.length).toBeGreaterThan(1900);
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
    expect(probe.bodies).toHaveLength(3);
    // Reassemble tools for another turn: the wrapper does not stack or duplicate attachment messages.
    await probe.run("again", "m2");
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
  }, 20000);

  it("filters joined attachments after step output persistence fails", async () => {
    const probe = await scenario({
      codemode: false,
      tools: { Screenshot: screenshotTool(() => [{ type: "image", mimeType: "image/png", data: PNG }]) },
      steps: (index) => (index === 0 ? [{ name: "Screenshot", id: "orphan", input: {} }] : [{ name: "finish", input: {} }]),
    });
    const append = probe.runtime.storage.append;
    let failed = false;
    probe.runtime.storage.append = async (...entries) => {
      if (!failed && entries.some((entry) => entry.type === "message" && entry.data.role === "assistant")) {
        failed = true;
        throw new Error("fixture step append failed");
      }
      await append(...entries);
    };
    const messages = await probe.run("fail commit", "m1", true);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(1);
    expect(results(messages)).toEqual([]);
    expect(await probe.resources.store.names("artifact", "Screenshot")).toHaveLength(1);
    await probe.run("next turn", "m2", true);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(0);
  });

  it("preserves thrown errors and host diagnostics without attachment messages", async () => {
    const probe = await scenario({
      tools: {
        fail: tool({
          inputSchema: emptyInput,
          execute: async () => {
            throw new Error("fixture failure");
          },
        }),
      },
      steps: (index) => (index === 0 ? [{ name: "codemode", input: { js: "return await tools.fail({});" } }] : [{ name: "finish", input: {} }]),
    });
    const messages = await probe.run();
    expect(JSON.stringify(results(messages))).toContain("fixture failure");
    expect(JSON.stringify(results(messages))).toContain("error-text");
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
  });
});
