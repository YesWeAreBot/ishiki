import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, createToolMessage, jsonSchema, tool, type Agent, type AgentMessage, type ToolResultOutput, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { supportsImageInput } from "../src/attachment/capabilities.js";
import { AttachmentConfig } from "../src/attachment/config.js";
import { processOutput } from "../src/attachment/output.js";
import { attachmentMessages, projectAttachments } from "../src/attachment/projection.js";
import { loadCodemode } from "../src/builtin-tools/codemode.js";
import { createFinish } from "../src/builtin-tools/finish.js";
import { createReadTool, ReadFile } from "../src/builtin-tools/read.js";
import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { collapse } from "../src/context/standard.engine.js";
import { V3ContextInstance } from "../src/context/v3.engine.js";
import { FailoverModel } from "../src/failover.js";
import { CodemodeConfig, ToolsearchConfig, TypingConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resources/center.js";
import { AgentRuntime } from "../src/runtime.js";

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

async function process(value: unknown, converted: ToolResultOutput = { type: "json", value: value as never }, name = "probe") {
  return processOutput(center, name, converted);
}

function toolMessage(toolName = "probe", toolCallId = "call-1", output: ToolResultOutput = { type: "text", value: "ok" }) {
  return createToolMessage([{ type: "tool-result", toolName, toolCallId, output }]);
}

async function attachmentFor(name: string, callId: string) {
  const item = (await process([imageBlock()], { type: "json", value: [imageBlock()] as never }, name)).items[0]!;
  return createCustomMessage("ishiki.attachment", { source: "tool", toolName: name, toolCallId: callId, items: [item] });
}

function imageBlock(data = PNG) {
  return { type: "image", mimeType: "image/png", data };
}

describe("json branch: the attachment field", () => {
  it("extracts attachment entries and strips their payloads in place", async () => {
    const result = await process({ summary: "screenshot", attachment: [imageBlock()] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ mediaType: "image/png" });
    expect(JSON.stringify(result.output)).not.toContain(PNG);
    expect(result.output).toMatchObject({ type: "json", value: { summary: "screenshot" } });
    const [entry] = (result.output as { value: { attachment: Array<Record<string, unknown>> } }).value.attachment;
    expect(String(entry.url)).toMatch(/^artifact:\/\/probe\//);
    expect(entry.byteLength).toBe(PNG_BUFFER.byteLength);
    expect(entry.data).toBeUndefined();
    expect(await center.resolve(result.items[0]!.url)).toMatchObject({ bytes: new Uint8Array(PNG_BUFFER) });
  });
  it("accepts read file results and an embedded MCP resource", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const readNode: ReadFile = { type: "file", url, mediaType: "image/png", data: PNG, byteLength: PNG_BUFFER.byteLength };
    const resourceEntry = { type: "resource", resource: { uri: "mcp://srv/doc", mimeType: "image/png", blob: PNG } };
    const result = await process({ attachment: [readNode, resourceEntry] });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.url).toBe(url); // hash match reuses the source
    expect(result.items[1]!.url).toMatch(/^artifact:\/\/probe\//);
    const [first, second] = (result.output as { value: { attachment: Array<Record<string, unknown>> } }).value.attachment;
    expect(first.url).toBe(url);
    expect(first.data).toBeUndefined();
    expect(second.resource).toEqual({ uri: "mcp://srv/doc", mimeType: "image/png" });
    expect(await center.store.names("artifact", "probe")).toHaveLength(1);
  });
  it("archives changed media instead of reusing the old source", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const changed: ReadFile = { type: "file", url, mediaType: "image/png", data: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64"), byteLength: 7 };
    const result = await process({ attachment: [changed] });
    expect(result.items[0]!.url).toMatch(/^artifact:\/\/probe\//);
    expect(result.items[0]!.url).not.toBe(url);
    expect([...(await center.resolve(url)).bytes!]).toEqual([...PNG_BUFFER]);
  });
  it("reuses a bare store URL without a payload and passes ordinary fields through", async () => {
    const url = await center.store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    const result = await process({ ok: true, attachment: [{ type: "file", mediaType: "image/png", url }] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.url).toBe(url);
    expect(result.output).toMatchObject({ type: "json", value: { ok: true } });
  });
  it("never guesses media outside the attachment field", async () => {
    for (const value of [
      [imageBlock()], // bare MCP blocks array: ordinary JSON
      { note: "screenshot", result: imageBlock() },
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
  it("archives file parts, reuses store URLs, and keeps text parts", async () => {
    const url = await center.store.writeArtifact("source", PNG_BUFFER, { mediaType: "image/png" });
    const converted = {
      type: "content",
      value: [
        { type: "text", text: "screenshot" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
        { type: "file", mediaType: "image/png", data: { type: "url", url: new URL(url), originalUrl: url } },
        { type: "file", mediaType: "image/png", data: { type: "url", url: new URL("https://example.com/a.png") } },
      ],
    } as unknown as ToolResultOutput;
    const result = await process({ note: true }, converted, "mcp");
    expect(result.items).toHaveLength(2);
    expect(result.items[1]!.url).toBe(url);
    expect(JSON.stringify(result.output)).not.toContain(PNG);
    expect(result.output).toMatchObject({
      type: "content",
      value: [{ type: "text", text: "screenshot" }, { type: "text" }, { type: "text" }, { type: "text" }],
    });
    expect(JSON.stringify(result.output)).toContain("[attachment:");
    expect(JSON.stringify(result.output)).toContain("[unloaded media: https://example.com/a.png]");
    expect(await center.store.names("artifact", "mcp")).toHaveLength(1);
  });
  it("does not archive a read image twice: the url part reuses the source", async () => {
    const url = await center.store.writeArtifact("media", PNG_BUFFER, { mediaType: "image/png" });
    const read = createReadTool({ center });
    const node = (await read.execute!({ url }, { toolCallId: "r", messages: [] })) as ReadFile;
    const converted = read.toModelOutput!({ toolCallId: "r", input: { url }, output: node });
    const result = await processOutput(center, "read", converted);
    expect(result.items[0]!.url).toBe(url);
    expect(await center.store.names("artifact", "read")).toHaveLength(0);
  });
  it("preserves native conversions without media and passes errors through", async () => {
    const converted = { type: "text", value: "native preview", providerOptions: { example: { hint: "keep" } } } as const;
    expect((await process({ secret: "internal" }, converted)).output).toEqual(converted);
    const content = {
      type: "content",
      value: [{ type: "text", text: "native", providerOptions: { example: { hint: "keep" } } }],
    } as unknown as ToolResultOutput;
    expect((await process(content, content)).output).toEqual(content);
  });
  it("reports invalid base64 payloads instead of archiving garbage", async () => {
    await expect(process({ attachment: [{ type: "image", mimeType: "image/png", data: "not base64!" }] })).rejects.toThrow(/base64/);
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });
});

describe("text budget", () => {
  it("archives a long result once and reconstructs it through the anchor", async () => {
    // attachment first: the marker lands inside the preview; the fat stdout line is cut.
    const value = { attachment: [imageBlock()], stdout: "x".repeat(20000), stderr: "y".repeat(20000) };
    const result = await process(value);
    expect(result.output.type).toBe("text");
    const output = (result.output as { type: "text"; value: string }).value;
    expect(output).toContain("artifact://probe/");
    expect(output).toContain("Continue: read(");
    expect(output).toContain("last line cut at the character budget");
    const url = /Full result: (artifact:\/\/\S+)/.exec(output)![1]!;
    const parsed = ResourceCenter.parse(url);
    const archived = Buffer.from(await center.store.readBytes("artifact", parsed.authority, parsed.segments.at(-1)!)).toString();
    const roundTrip = JSON.parse(archived) as { attachment: Array<Record<string, unknown>>; stdout: string };
    expect(roundTrip.stdout).toBe("x".repeat(20000)); // the full view is intact
    expect(roundTrip.attachment[0]!.data).toBeUndefined(); // payload stripped in the view
    expect(roundTrip.attachment[0]!.url).toMatch(/^artifact:\/\/probe\//);
    expect(await center.store.names("artifact", "probe")).toHaveLength(2); // media + text view
    // continuing through read reconstructs the JSON without the image payload
    const read = createReadTool({ center });
    const anchor = /Continue: read\(\{url: "([^"]+)"\}\)/.exec(output)![1]!;
    const page = (await read.execute!({ url: anchor }, { toolCallId: "r", messages: [] })) as string;
    expect(page.length).toBeGreaterThan(0);
  });
  it("keeps short JSON typed as json so consumers like send_message keep working", async () => {
    const result = await process({ ok: true, ids: ["m1"] });
    expect(result.output).toEqual({ type: "json", value: { ok: true, ids: ["m1"] } });
  });
  it("does not re-archive an already-converted read page", async () => {
    const text = "line\n".repeat(9000);
    const url = await center.store.writeArtifact("big", Buffer.from(text), { mediaType: "text/plain" });
    const read = createReadTool({ center });
    const node = (await read.execute!({ url }, { toolCallId: "r", messages: [] })) as string;
    const converted = read.toModelOutput!({ toolCallId: "r", input: { url }, output: node });
    const result = await processOutput(center, "read", converted);
    expect(result.output.type).toBe("text");
    expect((result.output as { value: string }).value).toContain(`Continue: read({url: "${url}:`);
    expect(await center.store.names("artifact", "read")).toHaveLength(0);
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
  it("allocates quotas newest-first while keeping message order", async () => {
    const first = (await process({ attachment: [imageBlock()] }, undefined, "a")).items[0]!;
    const second = (await process({ attachment: [imageBlock()] }, undefined, "b")).items[0]!;
    const messages = [
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "a", toolCallId: "1", items: [first] }),
      createCustomMessage("ishiki.attachment", { source: "tool", toolName: "b", toolCallId: "2", items: [second] }),
    ];
    const result = await projectAttachments(messages, center, { imageInput: true, maxImageCount: 1 });
    const imageParts = result.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "file") : []));
    expect(imageParts).toHaveLength(1);
    // the newest message wins the quota; the older one is described only
    expect(JSON.stringify(result[0])).toContain("count limit");
    expect(JSON.stringify(result[1])).toContain("include: original bytes");
    expect(JSON.stringify(result)).not.toContain(PNG);
    // replays recompute from scratch
    const replay = await projectAttachments(messages, center, { imageInput: true, maxImageCount: 2 });
    expect(replay.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "file") : []))).toHaveLength(2);
  });
  it("describes policy-rejected images without base64", async () => {
    const item = (await process({ attachment: [imageBlock()] }, undefined, "x")).items[0]!;
    const messages = [createCustomMessage("ishiki.attachment", { source: "tool", toolName: "x", toolCallId: "1", items: [item] })];
    for (const policy of [{ imageInput: false }, { imageInput: true, maxImageBytes: 1 }, { imageInput: true, maxTotalImageBytes: 1 }]) {
      const result = await projectAttachments(messages, center, policy);
      expect(result.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? m.content.filter((p) => p.type === "file") : []))).toHaveLength(0);
      expect(JSON.stringify(result)).toContain(item.url);
    }
    const missing = createCustomMessage("ishiki.attachment", {
      source: "tool",
      toolName: "x",
      toolCallId: "2",
      items: [{ url: "artifact://x/missing", mediaType: "image/png" }],
    });
    const absent = await projectAttachments([missing], center, { imageInput: true });
    expect(JSON.stringify(absent)).toContain("resource unavailable");
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

async function scenario(options: {
  codemode?: boolean;
  visual?: boolean;
  v3?: boolean;
  search?: boolean;
  failover?: boolean;
  maxImageBytes?: number;
  maxImageCount?: number;
  direct?: string[];
  steps: (index: number, bodies: any[]) => Call[];
  tools?: ToolSet;
}) {
  await loadCodemode();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-smoke-"));
  homes.push(home);
  const resources = new ResourceCenter("smoke", home);
  const bodies: any[] = [];
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
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return reply(options.steps(bodies.length - 1, bodies));
    },
  });
  const attached = Promise.withResolvers<Agent>();
  const v3 = new V3ContextInstance({}, { root: home, logger } as never);
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
      renderMessages: options.v3 ? v3.renderMessages : (messages) => collapse(messages),
    },
    wakeup: { decide: () => "trigger" },
    codemode: CodemodeConfig({ enable: options.codemode ?? true, direct: options.direct ?? [] } as never),
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
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const entries = await runtime.storage.read();
    const failed = entries.filter((entry) => entry.type === "event" && (entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"));
    expect(failed).toHaveLength(expectedFailure ? 1 : 0);

    return entries.flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
  };
  return { runtime, home, resources, bodies, run, agent: attached.promise };
}

function imageParts(body: any): any[] {
  return body.messages.flatMap((message: any) =>
    message.role === "user" && Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "image_url") : [],
  );
}
function results(messages: AgentMessage[]) {
  return messages.flatMap((message) => (message.role === "tool" ? message.content : []));
}
/** An MCP-style tool: raw blocks from execute, standard content parts for direct calls. */
function screenshotTool(blocks: () => unknown) {
  return tool({
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: blocks as never,
    toModelOutput: ({ output }): ToolResultOutput => ({
      type: "content",
      value: (output as Array<{ type: string; text?: string; mimeType?: string; data?: string }>).map((block) =>
        block.type === "image"
          ? ({ type: "file", mediaType: block.mimeType!, data: { type: "data", data: block.data! } } as never)
          : ({ type: "text", text: block.text ?? "" } as never),
      ),
    }),
  });
}

const emptyInput = jsonSchema({ type: "object", properties: {} });

describe("real Agent / codemode / provider smoke", () => {
  it("keeps a field inspection return as plain JSON with no media side effects", async () => {
    const blocks = [
      { type: "text", text: "fixture" },
      { type: "image", mimeType: "image/png", data: PNG },
    ];
    const metadata = blocks.map((x) => ({ type: x.type, keys: Object.keys(x), mimeType: x.mimeType }));
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
    expect(imageParts(probe.bodies[1])).toHaveLength(0);
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
                  js: "const shot = await tools.Screenshot({}); const processed = await tools.process_image({data: shot[1].data}); return {text: shot[0].text, attachment: [shot[1]], processed};",
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
    const saved = (await probe.resources.resolve(attachment.data.items[0]!.url)).bytes!;
    expect(Buffer.from(saved).equals(bytes)).toBe(true);
    expect(messages.findIndex((m) => m === attachment)).toBeGreaterThan(messages.findIndex((m) => m.role === "tool"));
    expect(results(messages).map((p) => p.toolName)).toEqual(["codemode", "finish"]);
    const events = await fs.readFile(path.join(probe.home, "events.jsonl"), "utf8");
    expect(events).not.toContain(base64.slice(0, 200));
    expect(imageParts(probe.bodies[0])).toHaveLength(0);
    expect(imageParts(probe.bodies[1])).toHaveLength(1);
    expect(imageParts(probe.bodies[1])[0].image_url.url === `data:image/png;base64,${base64}`).toBe(true);
    expect(JSON.stringify(probe.bodies[1].messages.filter((m: any) => m.role === "tool"))).not.toContain(base64.slice(0, 200));
  }, 20000);

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
    expect(imageParts(probe.bodies[1])).toHaveLength(0);
  });

  it.each([{ visual: false }, { maxImageBytes: 1 }, { v3: true }, { failover: true }])(
    "projects direct MCP-style calls through a real provider with %j",
    async (options) => {
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
      expect(imageParts(probe.bodies[1])).toHaveLength(options.visual === false || options.maxImageBytes === 1 ? 0 : 1);
      expect(JSON.stringify(probe.bodies[1])).toContain("artifact://Screenshot/");
      const denied = options.visual === false || options.maxImageBytes === 1;
      expect(denied && JSON.stringify(probe.bodies[1]).includes(PNG)).toBe(false);
    },
  );

  it("associates concurrent native outputs with their outer call ids and stable item order", async () => {
    const probe = await scenario({
      codemode: false,
      tools: {
        Screenshot: tool({
          inputSchema: emptyInput,
          execute: async () => ({ ok: true }),
          toModelOutput: () =>
            ({
              type: "content",
              value: [
                { type: "text", text: "native" },
                { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
                { type: "file", mediaType: "image/png", filename: "second", data: { type: "data", data: PNG } },
              ],
            }) as never,
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
    expect(imageParts(probe.bodies[1])).toHaveLength(1);
    const replayed = await probe.run("replay", "m2");
    expect(replayed.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(2);
    expect(await probe.resources.store.names("artifact", "Screenshot")).toHaveLength(1);
    expect(imageParts(probe.bodies[2])).toHaveLength(1);
    // Context trimming cannot revive an attachment whose successful result was removed.
    const agent = await probe.agent;
    const snapshot = await agent.storage.read();
    await agent.storage.clear();
    await agent.storage.append(...snapshot.filter((entry) => entry.type !== "message" || (entry.data.role !== "tool" && entry.data.role !== "assistant")));
    await probe.run("after trimming", "m3");
    expect(imageParts(probe.bodies[3])).toHaveLength(0);
  });

  it("lets read reuse platform media through the attachment array without artifact chains", async () => {
    const probe = await scenario({
      steps: (index, bodies) => {
        if (index > 0) return [{ name: "finish", input: {} }];
        const match = /asset:\/\/[a-f0-9]{32}/.exec(JSON.stringify(bodies[0]));
        return [{ name: "codemode", input: { js: `const image = await tools.read({url:${JSON.stringify(match![0])}}); return {attachment: [image]};` } }];
      },
    });
    const messages = await probe.run(`<img src="data:image/png;base64,${PNG}"/>`);
    expect(imageParts(probe.bodies[0])).toHaveLength(1);
    expect(imageParts(probe.bodies[1])).toHaveLength(1);
    expect(await probe.resources.store.names("artifact", "codemode")).toEqual([]);
    expect(await probe.resources.store.names("artifact", "read")).toEqual([]);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(2); // platform + read
  });

  it("keeps send_message ok/ids and delivers artifact media to the adapter payload", async () => {
    const delivered: any[] = [];
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
            sendMessage: async (channel: string, content: any) => {
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
    expect(delivered[0].channel).toBe("channel");
    expect(String(delivered[0].content)).toContain(`data:image/png;base64,${PNG}`);
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
          const result = bodies[1].messages.find((m: any) => m.role === "tool").content;
          const url = /Full result: (artifact:\/\/\S+)/.exec(result)![1]!;
          return [
            {
              name: "codemode",
              id: "read",
              input: { js: `const page = await tools.read({url:${JSON.stringify(`${url}:2+2000`)}}); return { length: page.length, head: page.slice(0, 4) };` },
            },
          ];
        }
        return [{ name: "finish", input: {} }];
      },
    });
    const messages = await probe.run();
    const outputs = results(messages);
    expect(outputs[0]?.output).toMatchObject({ type: "text", value: expect.stringContaining("first line") });
    const first = outputs[0]!.output as { type: "text"; value: string };
    const url = /Full result: (artifact:\/\/\S+)/.exec(first.value)![1]!;
    expect((await probe.resources.resolve(url)).content === raw).toBe(true);
    expect(outputs[1]?.output).toMatchObject({ type: "json", value: { length: expect.any(Number), head: "row0" } });
    expect((outputs[1]!.output as { value: { length: number } }).value.length).toBeGreaterThan(1900);
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
    expect(imageParts(probe.bodies[1])).toHaveLength(0);
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
