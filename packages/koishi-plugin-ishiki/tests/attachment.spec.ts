import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, createToolMessage, jsonSchema, tool, type Agent, type AgentMessage, type ToolResultOutput, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { supportsImageInput } from "../src/attachment/capabilities.js";
import { processOutput } from "../src/attachment/output.js";
import { attachmentMessages, projectAttachments } from "../src/attachment/projection.js";
import { loadCodemode } from "../src/builtin-tools/codemode.js";
import { createFinish } from "../src/builtin-tools/finish.js";
import { createReadTool, type ReadResult } from "../src/builtin-tools/read.js";
import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { collapse } from "../src/context/standard.engine.js";
import { V3ContextInstance } from "../src/context/v3.engine.js";
import { FailoverModel } from "../src/failover.js";
import { CodemodeConfig, ResourcesConfig, ToolsearchConfig, TypingConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resources/center.js";
import { textPage } from "../src/resources/text.js";
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
  it("preserves media field descriptions as JSON without extracting attachments", async () => {
    const metadata = [
      { type: "text", keys: ["type", "text"] },
      { type: "image", keys: ["type", "data", "mimeType"], mimeType: "image/png" },
    ];
    for (const value of [metadata, metadata[1], { inspected: metadata }, [{ type: "text", text: "fields" }, metadata[1]]]) {
      const snapshot = JSON.stringify(value);
      const result = await process(value);
      expect(result.output).toEqual({ type: "json", value });
      expect(result.items).toEqual([]);
      expect(JSON.stringify(value)).toBe(snapshot);
    }
    for (const type of ["image", "audio", "video", "file", "media", "image-data", "file-data"]) {
      const value = { type, mediaType: "image/png", keys: ["data"] };
      expect((await process(value)).output).toEqual({ type: "json", value });
    }
    expect(await center.store.namespaces("artifact")).toEqual([]);
  });
  it("still reports invalid data when a media payload is actually present", async () => {
    await expect(process({ type: "image", mimeType: "image/png", data: "not base64!" })).rejects.toThrow("Invalid image/png media data from probe");
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
    attachment: ResourcesConfig({
      imageInput: options.visual ?? true,
      ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
      ...(options.maxImageCount === undefined ? {} : { maxImageCount: options.maxImageCount }),
    } as never),
  });
  runtimes.push(runtime);
  const run = async (content = "hello", messageId = "m1", expectedFailure = false) => {
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
    const agent = await attached.promise;
    await agent.wait();
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

const emptyInput = jsonSchema({ type: "object", properties: {} });

describe("real Agent / codemode / provider smoke", () => {
  it.each([true, false])("keeps screenshot field inspection as JSON with codemode=%s", async (codemode) => {
    const blocks = [
      { type: "text", text: "fixture" },
      { type: "image", mimeType: "image/png", data: PNG },
    ];
    const inspect = (values: typeof blocks) => values.map((x) => ({ type: x.type, keys: Object.keys(x), mimeType: x.mimeType }));
    const metadata = JSON.parse(JSON.stringify(inspect(blocks)));
    const probe = await scenario({
      codemode,
      tools: {
        Screenshot: tool({ inputSchema: emptyInput, execute: async () => blocks }),
        inspect: tool({ inputSchema: emptyInput, execute: async () => inspect(blocks) }),
      },
      steps: (index) =>
        index === 0
          ? [
              {
                name: codemode ? "codemode" : "inspect",
                id: "inspection",
                input: codemode
                  ? {
                      js: "const r = await tools.Screenshot({}); return r.map(x => ({type: x.type, keys: Object.keys(x), mimeType: x.mimeType, uri: x.resource && x.resource.uri}));",
                    }
                  : {},
              },
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await probe.run();
    expect(results(messages)[0]?.output).toEqual({ type: "json", value: metadata });
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toEqual([]);
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(probe.bodies).toHaveLength(2);
    expect(imageParts(probe.bodies[1])).toHaveLength(0);
    const toolResult = probe.bodies[1].messages.find((m: any) => m.role === "tool");
    expect(JSON.parse(toolResult.content)).toEqual(metadata);
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
                  js: "const shot = await tools.Screenshot({}); const processed = await tools.process_image({data: shot[1].data}); return {shot, processed};",
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

  it.each([{ visual: false }, { maxImageBytes: 1 }, { v3: true }, { failover: true }])("projects through real provider with %j", async (options) => {
    const probe = await scenario({
      ...options,
      codemode: false,
      tools: {
        Screenshot: tool({
          inputSchema: emptyInput,
          execute: async () => [
            { type: "text", text: "fixture" },
            { type: "image", mimeType: "image/png", data: PNG },
          ],
        }),
      },
      steps: (index) => (index === 0 ? [{ name: "Screenshot", id: "direct", input: {} }] : [{ name: "finish", input: {} }]),
    });
    const messages = await probe.run();
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(1);
    expect(imageParts(probe.bodies[1])).toHaveLength(options.visual === false || options.maxImageBytes === 1 ? 0 : 1);
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
          toModelOutput: () => ({
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

  it("uses the same policy for platform assets and lets read reuse existing media without artifact chains", async () => {
    const probe = await scenario({
      steps: (index, bodies) => {
        if (index > 0) return [{ name: "finish", input: {} }];
        const match = /asset:\/\/[a-f0-9]{32}/.exec(JSON.stringify(bodies[0]));
        return [{ name: "codemode", input: { js: `return await tools.read({url:${JSON.stringify(match![0])}});` } }];
      },
    });
    const messages = await probe.run(`<img src="data:image/png;base64,${PNG}"/>`);
    expect(imageParts(probe.bodies[0])).toHaveLength(1);
    expect(imageParts(probe.bodies[1])).toHaveLength(1);
    expect(await probe.resources.store.namespaces("artifact")).toEqual([]);
    expect(messages.filter((m) => m.role === "custom" && m.type === "ishiki.attachment")).toHaveLength(1);
  });

  it("keeps send_message ok/ids and delivers artifact media to the adapter payload", async () => {
    const delivered: any[] = [];
    const probe = await scenario({
      codemode: false,
      steps: (index) => (index === 0 ? [{ name: "Screenshot", input: {} }] : [{ name: "finish", input: {} }]),
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG }] }) },
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
    const raw = "first line\n" + "x".repeat(1100000);
    const probe = await scenario({
      tools: { logs: tool({ inputSchema: emptyInput, execute: async () => raw }) },
      steps: (index, bodies) => {
        if (index === 0) return [{ name: "codemode", id: "logs", input: { js: "return await tools.logs({});" } }];
        if (index === 1) {
          const result = bodies[1].messages.find((m: any) => m.role === "tool").content;
          const url = /Full result: (artifact:\/\/\S+)/.exec(result)![1]!;
          return [{ name: "codemode", id: "read", input: { js: `return await tools.read({url:${JSON.stringify(`${url}#offset=30000`)}});` } }];
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
    expect(outputs[1]?.output).toMatchObject({ type: "text", value: expect.stringContaining("#offset=60000") });
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
    expect(probe.bodies).toHaveLength(3);
    // Reassemble tools for another turn: the wrapper does not stack or duplicate attachment messages.
    await probe.run("again", "m2");
    expect(await probe.resources.store.names("artifact", "codemode")).toHaveLength(1);
  }, 20000);

  it("filters joined attachments after step output persistence fails", async () => {
    const probe = await scenario({
      codemode: false,
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG }] }) },
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
