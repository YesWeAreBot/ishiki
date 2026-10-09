import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, jsonSchema, tool, type Agent, type AgentMessage, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it } from "vitest";

import { loadCodemode } from "../src/builtin-tools/codemode.js";
import { createFinish } from "../src/builtin-tools/finish.js";
import { createReadTool } from "../src/builtin-tools/read.js";
import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { collapse } from "../src/context/standard.engine.js";
import { V3ContextInstance } from "../src/context/v3.engine.js";
import { FailoverModel } from "../src/failover.js";
import { CodemodeConfig, ResourcesConfig, ToolsearchConfig, TypingConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resources/center.js";
import { AgentRuntime } from "../src/runtime.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=", "base64");
const logger = { warn() {}, error() {}, info() {}, debug() {}, level: 1 } as never;
const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { force: true, recursive: true });
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
    attachmentPolicy: ResourcesConfig({
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
  it("passes a result over 1 MiB to a second host tool, archives only the outer return, then sends a user image", async () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(900000)]);
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
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] }) },
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
            { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
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
    expect(denied && JSON.stringify(probe.bodies[1]).includes(PNG.toString("base64"))).toBe(false);
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
              { type: "file", mediaType: "image/png", data: { type: "data", data: PNG.toString("base64") } },
              { type: "file", mediaType: "image/png", filename: "second", data: { type: "data", data: PNG.toString("base64") } },
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
    const messages = await probe.run(`<img src="data:image/png;base64,${PNG.toString("base64")}"/>`);
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
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] }) },
    });
    const url = await probe.resources.store.writeArtifact("image", PNG, { mediaType: "image/png" });
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
    expect(String(delivered[0].content)).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
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
      tools: { Screenshot: tool({ inputSchema: emptyInput, execute: async () => [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] }) },
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
