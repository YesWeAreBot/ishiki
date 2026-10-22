import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import {
  createAssistantMessage,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  createToolMessage,
  type AgentMessage,
  type AgentStorage,
  type JSONValue,
} from "@yesimagent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReadTool } from "../src/builtin-tools/read.js";
import { ResourceCenter } from "../src/resource/center.js";
import { processOutput } from "../src/resource/output.js";
import { AttachmentProjection } from "../src/resource/projection.js";
import type { AttachmentItem, ImageLifetime } from "../src/types.js";

/** Two distinct, valid 1x1 PNG images. */
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BYTES_A = Buffer.from(PNG_A, "base64");
const BYTES_B = Buffer.from(PNG_B, "base64");

let home: string;
let center: ResourceCenter;
let storage: AgentStorage;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-output-"));
  center = new ResourceCenter("rt", home);
  storage = createJsonlStorage(path.join(home, "events.jsonl"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function imageParts(messages: readonly AgentMessage[]) {
  return messages.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : [],
  );
}

function toolMessage(toolName: string, toolCallId: string) {
  return createToolMessage([{ type: "tool-result", toolName, toolCallId, output: { type: "text", value: "ok" } }]);
}

/** The attachment message a codemode-style JSON return produces. */
async function jsonAttachment(toolName: string, toolCallId: string, entries: unknown[]) {
  const { items } = await processOutput(center, toolName, { type: "json", value: { attachments: entries as JSONValue[] } }, undefined, true);
  return { items, message: createCustomMessage("ishiki.attachment", { source: "tool", toolName, toolCallId, items }) };
}

/** The attachment message a direct media read produces. */
async function readAttachment(toolCallId: string, url: string, lifetime: ImageLifetime) {
  const tool = createReadTool({ center, lifetime: true });
  const raw = await tool.execute!({ url, lifetime }, { toolCallId, messages: [], context: undefined });
  if (!("type" in raw)) throw new Error("expected a single read result");
  const converted = await tool.toModelOutput!({ toolCallId, input: { url, lifetime }, output: raw });
  const { items } = await processOutput(center, "read", converted, raw, true);
  return { items, message: createCustomMessage("ishiki.attachment", { source: "tool", toolName: "read", toolCallId, items }) };
}

/** Persist one model response through real JSONL storage and restore the projection from it. */
async function commit(projection: AttachmentProjection, messages: readonly AgentMessage[], turnId: string): Promise<void> {
  await storage.append(...projection.append([createEntry("message", createAssistantMessage("observed"), { turnId })]));
  projection.restore(await storage.read(), messages);
}

/**
 * One once item and one retain item for each way media enters the runtime:
 * an MCP image block, a read file result, an embedded MCP resource, and a live
 * file snapshotted by the runtime (transformed media).
 */
async function fourMediaPaths(): Promise<{ messages: AgentMessage[]; items: AttachmentItem[] }> {
  const first = await center.store.writeArtifact("seed", BYTES_A, { mediaType: "image/png" });
  const second = await center.store.writeArtifact("seed", BYTES_B, { mediaType: "image/png" });
  await fs.mkdir(path.join(home, "media"), { recursive: true });
  await fs.writeFile(path.join(home, "media", "a.png"), BYTES_A);
  await fs.writeFile(path.join(home, "media", "b.png"), BYTES_B);

  const messages: AgentMessage[] = [];
  const items: AttachmentItem[] = [];
  const add = (toolName: string, toolCallId: string, produced: { message: AgentMessage; items: AttachmentItem[] }): void => {
    messages.push(toolMessage(toolName, toolCallId), produced.message);
    items.push(...produced.items);
  };

  add(
    "mcp_image",
    "m1",
    await jsonAttachment("mcp_image", "m1", [
      { type: "image", mimeType: "image/png", data: PNG_A, lifetime: "once" },
      { type: "image", mimeType: "image/png", data: PNG_B, lifetime: "retain" },
    ]),
  );
  add("read", "r1", await readAttachment("r1", first, "once"));
  add("read", "r2", await readAttachment("r2", second, "retain"));
  add(
    "mcp_resource",
    "m2",
    await jsonAttachment("mcp_resource", "m2", [
      { type: "resource", resource: { uri: "mcp://srv/a", mimeType: "image/png", blob: PNG_A }, lifetime: "once" },
      { type: "resource", resource: { uri: "mcp://srv/b", mimeType: "image/png", blob: PNG_B }, lifetime: "retain" },
    ]),
  );
  add(
    "snapshot",
    "m3",
    await jsonAttachment("snapshot", "m3", [
      { type: "file", url: "local://media/a.png", mediaType: "image/png", lifetime: "once" },
      { type: "file", url: "local://media/b.png", mediaType: "image/png", lifetime: "retain" },
    ]),
  );

  return { messages, items };
}

describe("image lifetimes reach the consumer", () => {
  it("spends once media and keeps retained media across a persisted response and a restart", async () => {
    const { messages, items } = await fourMediaPaths();
    const spent = items.filter((item) => item.lifetime === "once").map((item) => item.url);
    const kept = items.filter((item) => item.lifetime === "retain").map((item) => item.url);
    expect(spent).toHaveLength(4);
    expect(kept).toHaveLength(4);
    expect(new Set([...spent, ...kept]).size).toBe(8);

    const policy = { imageInput: true, maxImageCount: 8 };
    const projection = new AttachmentProjection(center, policy);
    projection.restore([], messages);
    expect(imageParts(await projection.project(messages, "turn-1"))).toHaveLength(8);

    await commit(projection, messages, "turn-1");
    const next = await projection.project(messages, "turn-2");
    expect(imageParts(next)).toHaveLength(4);
    const visible = JSON.stringify(next);
    for (const url of kept) expect(visible).toContain(url);
    for (const url of spent) expect(visible).not.toContain(url);

    const restarted = new AttachmentProjection(center, policy);
    restarted.restore(await storage.read(), messages);
    expect(await restarted.project(messages, "turn-3")).toEqual(next);
  });

  it("evicts the oldest viewed recent images in a batch once the window overflows", async () => {
    const messages: AgentMessage[] = [];
    const items: AttachmentItem[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const toolName = `recent_${index}`;
      const produced = await jsonAttachment(toolName, `c${index}`, [{ type: "image", mimeType: "image/png", data: PNG_A, lifetime: "recent" }]);
      messages.push(toolMessage(toolName, `c${index}`), produced.message);
      items.push(...produced.items);
    }
    expect(new Set(items.map((item) => item.url)).size).toBe(5);

    const policy = { imageInput: true, maxImageCount: 8, recentImageCount: 3, imagePruneBatchSize: 2 };
    const projection = new AttachmentProjection(center, policy);
    projection.restore([], messages);
    expect(imageParts(await projection.project(messages, "turn-1"))).toHaveLength(5);

    await commit(projection, messages, "turn-1");
    const pruned = await projection.project(messages, "turn-2");
    expect(imageParts(pruned)).toHaveLength(3);
    const visible = JSON.stringify(pruned);
    expect(visible).not.toContain(items[0]!.url);
    expect(visible).not.toContain(items[1]!.url);
    for (const item of items.slice(2)) expect(visible).toContain(item.url);

    await commit(projection, messages, "turn-2");
    expect(await projection.project(messages, "turn-2")).toEqual(pruned);
    const restarted = new AttachmentProjection(center, policy);
    restarted.restore(await storage.read(), messages);
    expect(await restarted.project(messages, "turn-3")).toEqual(pruned);
  });

  it("supplies no visual content when image input is disabled, even with unusable lifetime metadata", async () => {
    const { items } = await processOutput(
      center,
      "mcp_image",
      { type: "json", value: { attachments: [{ type: "image", mimeType: "image/png", data: PNG_A, lifetime: "forever" }] } as JSONValue },
      undefined,
      false,
    );
    expect(items).toHaveLength(1);
    const message = createCustomMessage("ishiki.attachment", { source: "tool", toolName: "mcp_image", toolCallId: "off", items });
    const messages = [toolMessage("mcp_image", "off"), message];

    const projection = new AttachmentProjection(center, { imageInput: false });
    projection.restore([], messages);
    const rejected = await projection.project(messages, "turn-1");
    expect(imageParts(rejected)).toHaveLength(0);
    expect(JSON.stringify(rejected)).toContain("model image input disabled");
    await commit(projection, messages, "turn-1");
    const settled = await projection.project(messages, "turn-2");
    expect(imageParts(settled)).toEqual([]);
    expect(JSON.stringify(settled)).not.toContain("not supplied");
  });
});

describe("invalid lifetime boundary", () => {
  it("rejects an unknown lifetime instead of falling back", async () => {
    for (const lifetime of ["forever", "Retain", null, true, 1]) {
      const value = { attachments: [{ type: "image", mimeType: "image/png", data: PNG_A, lifetime }] } as JSONValue;
      await expect(processOutput(center, "probe", { type: "json", value })).rejects.toMatchObject({ code: "invalid_attachment_lifetime" });
    }
    await expect(
      processOutput(center, "probe", { type: "json", value: { attachments: [{ type: "note", lifetime: "forever" }] } as JSONValue }),
    ).rejects.toMatchObject({ code: "invalid_attachment_lifetime" });
    expect(await center.store.names("artifact", "probe")).toEqual([]);
  });
});
