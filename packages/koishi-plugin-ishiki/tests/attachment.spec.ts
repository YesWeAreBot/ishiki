import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAssistantMessage,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
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
import { CodemodeConfig, resolveProfile, TypingConfig } from "../src/profile/config.js";
import { supportsImageInput } from "../src/resource/capabilities.js";
import { captureResources } from "../src/resource/capture.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AttachmentConfig } from "../src/resource/config.js";
import { processOutput } from "../src/resource/output.js";
import { attachmentMessages, AttachmentProjection } from "../src/resource/projection.js";
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

async function commitImages(projection: AttachmentProjection, messages: readonly AgentMessage[]) {
  const storage = createJsonlStorage(path.join(home, "projection.jsonl"));
  await storage.append(...projection.append([createEntry("message", createAssistantMessage("observed"), { turnId: "turn" })]));
  const entries = await storage.read();
  projection.restore(entries, messages);
  return entries;
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
  it("rejects the removed per-request render quota during profile loading", () => {
    expect(() => resolveProfile({ attachment: { maxImageRenders: 2 } }, "test", home)).toThrow("attachment.maxImageRenders was removed");
  });

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

  it("waits for a durable model response before consuming once and drains unseen images first", async () => {
    const first = await attachmentFor("a", "1");
    const second = await attachmentFor("b", "2");
    const messages = [toolMessage("a", "1"), first, toolMessage("b", "2"), second];
    const projection = new AttachmentProjection(center, { imageInput: true, maxImageCount: 1 });
    projection.restore([], messages);
    const result = await projection.project(messages, "turn");
    expect(imageParts(result)).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("waiting for capacity");
    expect(await projection.project(messages, "turn")).toEqual(result);
    await commitImages(projection, messages);
    const next = await projection.project(messages, "turn");
    expect(imageParts(next)).toHaveLength(1);
    expect(JSON.stringify(next)).toContain("tool b, call 2");
    expect(JSON.stringify(next)).not.toContain("tool a, call 1");
    await commitImages(projection, messages);
    expect(imageParts(await projection.project(messages, "turn"))).toEqual([]);
  });

  it("keeps retain images stable across committed steps and runtime reconstruction", async () => {
    const attachment = await attachmentFor("reference", "same-call");
    attachment.data.items[0]!.lifetime = "retain";
    const messages = [toolMessage("reference", "same-call"), attachment];
    const projection = new AttachmentProjection(center, { imageInput: true });
    projection.restore([], messages);
    const first = await projection.project(messages, "turn");
    await commitImages(projection, messages);
    expect(await projection.project(messages, "turn")).toEqual(first);
    const entries = await commitImages(projection, messages);
    const restored = new AttachmentProjection(center, { imageInput: true });
    restored.restore(entries, messages);
    expect(await restored.project(messages, "turn")).toEqual(first);
    const trimmed = attachmentMessages([attachment]);
    restored.restore(entries, trimmed);
    expect(await restored.project(trimmed, "turn")).toEqual([]);
    const expired = await commitImages(restored, trimmed);
    const afterExpiry = new AttachmentProjection(center, { imageInput: true });
    afterExpiry.restore(expired, messages);
    expect(imageParts(await afterExpiry.project(messages, "turn"))).toEqual([]);
  });

  it("recovers once after an unpersisted response, but never resurrects committed images", async () => {
    const attachment = await attachmentFor("probe", "call");
    const messages = [toolMessage("probe", "call"), attachment];
    const projection = new AttachmentProjection(center, { imageInput: true });
    projection.restore([], messages);
    await projection.project(messages, "turn");
    projection.append([createEntry("message", createAssistantMessage("not persisted"), { turnId: "turn" })]);
    const restarted = new AttachmentProjection(center, { imageInput: true });
    restarted.restore([], messages);
    expect(imageParts(await restarted.project(messages, "turn"))).toHaveLength(1);
    const entries = await commitImages(restarted, messages);
    restarted.restore(entries, []);
    restarted.restore(entries, messages);
    expect(imageParts(await restarted.project(messages, "turn"))).toEqual([]);
  });

  it("batches oldest viewed recent images and keeps retained references outside the window", async () => {
    const attachments = await Promise.all(["a", "b", "c", "d", "e", "reference"].map((name) => attachmentFor(name, name)));
    for (const attachment of attachments) attachment.data.items[0]!.lifetime = "recent";
    attachments[5]!.data.items[0]!.lifetime = "retain";
    const projection = new AttachmentProjection(center, { imageInput: true, maxImageCount: 8 });
    const messages: AgentMessage[] = [];
    for (const index of [5, 0, 1, 2]) {
      const attachment = attachments[index]!;
      if (attachment.data.source !== "tool") throw new Error("expected tool source");
      messages.push(toolMessage(attachment.data.toolName, attachment.data.toolCallId), attachment);
    }
    projection.restore([], messages);
    expect(imageParts(await projection.project(messages, "turn"))).toHaveLength(4);
    await commitImages(projection, messages);
    messages.push(toolMessage("d", "d"), attachments[3]!);
    projection.restore(await createJsonlStorage(path.join(home, "projection.jsonl")).read(), messages);
    expect(imageParts(await projection.project(messages, "turn"))).toHaveLength(5);
    await commitImages(projection, messages);
    messages.push(toolMessage("e", "e"), attachments[4]!);
    projection.restore(await createJsonlStorage(path.join(home, "projection.jsonl")).read(), messages);
    const pruned = await projection.project(messages, "turn");
    expect(imageParts(pruned)).toHaveLength(4);
    const text = JSON.stringify(pruned);
    expect(text).not.toContain("tool a, call a");
    expect(text).not.toContain("tool b, call b");
    for (const name of ["c", "d", "e", "reference"]) expect(text).toContain(`tool ${name}, call ${name}`);
    await commitImages(projection, messages);
    expect(await projection.project(messages, "turn")).toEqual(pruned);
  });

  it("never prunes unseen recent images from an oversized batch", async () => {
    const messages: AgentMessage[] = [];
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      const attachment = await attachmentFor(name, name);
      attachment.data.items[0]!.lifetime = "recent";
      messages.push(toolMessage(name, name), attachment);
    }
    const projection = new AttachmentProjection(center, { imageInput: true, maxImageCount: 1, recentImageCount: 1, imagePruneBatchSize: 2 });
    projection.restore([], messages);
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      const output = await projection.project(messages, "turn");
      expect(imageParts(output)).toHaveLength(1);
      const supplied = output.find(
        (message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
      );
      expect(JSON.stringify(supplied)).toContain(`tool ${name}, call ${name}`);
      await commitImages(projection, messages);
    }
  });

  it("separates repeated tool call ids and independent references to identical media", async () => {
    const original = await attachmentFor("probe", "reused");
    const retained = createCustomMessage("ishiki.attachment", {
      ...original.data,
      items: original.data.items.map((item) => ({ ...item, lifetime: "retain" as const })),
    });
    const messages = [toolMessage("probe", "reused"), original, retained];
    const projection = new AttachmentProjection(center, { imageInput: true });
    projection.restore([], messages);
    expect(imageParts(await projection.project(messages, "turn"))).toHaveLength(1);
    const entries = await commitImages(projection, messages);
    expect(imageParts(await projection.project(messages, "turn"))).toHaveLength(1);
    const next = await attachmentFor("probe", "reused");
    const subsequent = [toolMessage("probe", "reused"), next];
    projection.restore(entries, subsequent);
    expect(imageParts(await projection.project(subsequent, "turn"))).toHaveLength(1);
    const failed = toolMessage("probe", "reused", { type: "error-text", value: "failed" });
    expect(attachmentMessages([...messages, failed, next])).not.toContain(next);
  });

  it("commits terminal rejections without claiming visual delivery and retries unavailable resources", async () => {
    const attachment = await attachmentFor("x", "1");
    const messages = [toolMessage("x", "1"), attachment];
    for (const policy of [{ imageInput: false }, { imageInput: true, maxImageBytes: 1 }, { imageInput: true, maxTotalImageBytes: 1 }]) {
      const projection = new AttachmentProjection(center, policy);
      projection.restore([], messages);
      const result = await projection.project(messages, "turn");
      expect(imageParts(result)).toEqual([]);
      expect(JSON.stringify(result)).toContain("not supplied");
      const batch = projection.append([createEntry("message", createAssistantMessage("reason received"), { turnId: "turn" })]);
      const delivery = batch.find((entry) => entry.type === "ishiki.images");
      expect(delivery).toMatchObject({ data: { shown: [], released: [`${attachment.id}:0`] } });
      projection.restore(batch, messages);
      expect(imageParts(await projection.project(messages, "turn"))).toEqual([]);
      expect(JSON.stringify(await projection.project(messages, "turn"))).not.toContain("not supplied");
    }
    const missing = createCustomMessage("ishiki.attachment", {
      source: "tool",
      toolName: "x",
      toolCallId: "2",
      items: [{ url: "artifact://x/missing", mediaType: "image/png", lifetime: "retain" }],
    });
    const projection = new AttachmentProjection(center, { imageInput: true });
    const missingMessages = [toolMessage("x", "2"), missing];
    projection.restore([], missingMessages);
    expect(JSON.stringify(await projection.project(missingMessages, "turn"))).toContain("resource unavailable");
    await commitImages(projection, missingMessages);
    expect(JSON.stringify(await projection.project(missingMessages, "turn"))).toContain("resource unavailable");
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
  failover?: boolean;
  maxImageBytes?: number;
  maxImageCount?: number;
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
    codemode: CodemodeConfig({ enable: options.codemode ?? true, direct: options.direct ?? [] } as never),
    pacing: { maxSteps: 20, wrapUpSteps: 0, progressAt: 0 },
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
  it("reports a script return as text sections with no media side effects", async () => {
    const blocks: ScreenshotBlock[] = [
      { type: "text", text: "fixture" },
      { type: "image", mimeType: "image/png", data: PNG },
    ];
    const probe = await scenario({
      tools: {
        Screenshot: tool({ inputSchema: emptyInput, execute: async () => blocks }),
      },
      steps: (index) =>
        index === 0
          ? [
              {
                name: "codemode",
                id: "inspection",
                input: { js: "const shot = await tools.Screenshot({}); return shot.map((block) => ({ type: block.type, keys: Object.keys(block) }));" },
              },
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    const output = results(messages)[0]!.output;
    expect(output.type).toBe("text");
    expect(textOf(output)).toContain("=== STATUS ===\ncompleted");
    expect(textOf(output)).toContain('{"type":"text","keys":["type","text"]}');
    expect(textOf(output)).not.toContain("=== ATTACHMENTS ===");
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
    expect(probe.bodies).toHaveLength(2);
    expect(imageUrls(probe.bodies[1]!)).toHaveLength(0);
  });

  it("passes a result over 1 MiB to a second host tool, then attaches an explicit image", async () => {
    const bytes = Buffer.concat([PNG_BUFFER, Buffer.alloc(900000)]);
    const base64 = bytes.toString("base64");
    let nativeCalls = 0;
    let received = "";
    const probe = await scenario({
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
                  js: 'const shot = await tools.Screenshot({}); const processed = await tools.process_image({data: shot[1].data}); image({type: "image", data: shot[1].data, mimeType: "image/png"}); return {text: shot[0].text, processed};',
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

  it("does not archive or project internal media when the script returns only status", async () => {
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

  it("turns a host read result into an attachment through the native image helper", async () => {
    const probe = await scenario({
      steps: (index, bodies) => {
        if (index > 0) return [{ name: "finish", input: {} }];
        const match = /asset:\/\/[a-f0-9]{32}/.exec(JSON.stringify(bodies[0]));
        return [
          {
            name: "codemode",
            id: "attach",
            input: {
              js: `const file = await tools.read({url:${JSON.stringify(match![0])}}); image({type: "image", data: file.data, mimeType: file.mediaType}); return {byteLength: file.byteLength};`,
            },
          },
        ];
      },
    });
    const messages = await probe.run(`<img src="data:image/png;base64,${PNG}"/>`);
    expect(imageUrls(probe.bodies[0]!)).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)).toEqual([`data:image/png;base64,${PNG}`]);
    expect(await probe.resources.store.names("artifact", "read")).toEqual([]);
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(2); // 平台图 + codemode 图
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

  it("pages a long script result and replays it through a host read", async () => {
    const raw = ["first line", ...Array.from({ length: 6000 }, (_, i) => "row" + i)].join("\n");
    const probe = await scenario({
      tools: { logs: tool({ inputSchema: emptyInput, execute: async () => raw }) },
      steps: (index, bodies) => {
        if (index === 0) return [{ name: "codemode", id: "logs", input: { js: "return await tools.logs({});" } }];
        if (index === 1) {
          const content = bodies[1]!.messages
            .filter((message) => message.role === "tool")
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .join("\n");
          const next = /Continue: read\((\{"url":"[^"]*"\})\)/.exec(content)?.[1] ?? "";
          return [
            {
              name: "codemode",
              id: "read",
              input: { js: `const page = await tools.read(${next}); return { length: page.text.length, head: page.text.slice(0, 6) };` },
            },
          ];
        }
        return [{ name: "finish", input: {} }];
      },
    });
    const messages = await probe.run();
    const outputs = results(messages);
    const first = outputs[0]!.output;
    expect(first.type).toBe("text");
    const text = textOf(first);
    expect(text).toContain("=== STATUS ===\ncompleted");
    expect(text).toContain("first line");
    expect(text).toContain("[truncated: showing lines");
    const url = /Full result: (artifact:\/\/\S+)/.exec(text)?.[1] ?? "";
    const stored = await probe.resources.resolve(url);
    expect(stored.type === "text" && stored.text === JSON.stringify(raw)).toBe(true);
    const second = textOf(outputs[1]!.output);
    expect(second).toContain("=== RESULT ===");
    expect(second).not.toContain("=== ERROR ===");
    expect(second).toContain('"length":');
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
    expect(probe.bodies).toHaveLength(3);
    // 换一轮重新装配工具：持久化文本与附件不会重复生成。
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

  it("reports a script failure with its error section and no attachment message", async () => {
    const probe = await scenario({
      tools: {
        fail: tool({
          inputSchema: emptyInput,
          execute: async () => {
            throw new Error("fixture failure");
          },
        }),
      },
      steps: (index) =>
        index === 0 ? [{ name: "codemode", input: { js: "text('before the failure'); return await tools.fail({});" } }] : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    const output = results(messages)[0]!.output;
    expect(output.type).toBe("text");
    expect(textOf(output)).toContain("=== STATUS ===\nfailed");
    expect(textOf(output)).toContain("=== TEXT ===\nbefore the failure");
    expect(textOf(output)).toContain("=== ERROR ===\nscript: Error: fixture failure");
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
  });

  it("keeps an attached image when the script fails afterwards", async () => {
    const probe = await scenario({
      steps: (index) =>
        index === 0
          ? [
              {
                name: "codemode",
                id: "fail-image",
                input: { js: `image({type: "image", data: "${PNG}", mimeType: "image/png"}); throw new Error("after the image");` },
              },
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    const output = results(messages)[0]!.output;
    expect(textOf(output)).toContain("=== STATUS ===\nfailed");
    expect(textOf(output)).toContain("=== ATTACHMENTS ===");
    const attachments = messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment");
    expect(attachments).toHaveLength(1);
    expect(imageUrls(probe.bodies[1]!)).toEqual([`data:image/png;base64,${PNG}`]);
  });
});
