import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, jsonSchema, tool, type AgentMessage, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { AgentRuntime, ResourceCenter, createFinish, collapse } from "koishi-plugin-ishiki";
import { afterEach, describe, expect, it } from "vitest";

import { V3WakeupInstance } from "../src/wakeup-engine.js";

const logger = {
  level: 1,
  debug: (message: string) => void message,
  info: (message: string) => void message,
  warn: (message: string) => void message,
  error: (message: string) => void message,
};

const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
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

function created(messageId: string, content = "hello") {
  return createCustomMessage("ishiki.message.created", {
    platform: "test",
    selfId: "bot",
    channelId: "channel",
    messageId,
    timestamp: 1,
    content,
    isDirect: true,
    user: { id: "u" },
  });
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 唤醒在事实提交后异步发生，不能只靠一次 read。 */
async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 2000; index += 1) {
    if (await condition()) return;
    await sleep(5);
  }
  throw new Error("condition not reached");
}

async function storedMessages(runtime: AgentRuntime): Promise<AgentMessage[]> {
  return (await runtime.storage.read()).flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
}

function createdIds(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => (message.role === "custom" && message.type === "ishiki.message.created" ? [message.data.messageId] : []));
}

async function terminalTurns(runtime: AgentRuntime): Promise<number> {
  const entries = await runtime.storage.read();
  return entries.filter(
    (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
  ).length;
}

async function waitForTurns(runtime: AgentRuntime, expected: number): Promise<void> {
  await until(async () => (await terminalTurns(runtime)) >= expected);
}

const speakTool: ToolSet = {
  speak: tool({
    description: "say something",
    inputSchema: jsonSchema<{ text: string }>({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
    execute: async (input) => ({ ok: true, text: input.text }),
  }),
};

async function makeRuntime(options: {
  steps: (index: number) => Call[];
  wakeup: V3WakeupInstance;
  gate?: (call: number) => Promise<void>;
}): Promise<{ runtime: AgentRuntime; bodies: unknown[] }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-v3-wake-"));
  homes.push(home);
  const bodies: unknown[] = [];
  let calls = 0;
  const gateway = createGateway({
    config: {
      providers: {
        mock: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "test-only",
          models: [{ id: "vision", type: "language", input: ["text"] }],
        },
      },
      groups: { vision: { models: ["mock:vision"] } },
    },
    fetch: async (_url, init) => {
      const call = calls++;
      bodies.push(JSON.parse(String(init?.body)));
      await options.gate?.(call);
      return reply(options.steps(call));
    },
  });
  const runtime = new AgentRuntime({
    id: "v3-wake",
    home,
    model: gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { finish: createFinish(), ...speakTool },
    extensions: [],
    context: { renderMessages: (messages) => collapse(messages) },
    wakeup: options.wakeup,
    codemode: { enable: false, direct: [], timeoutMs: 1000 },
    toolsearch: { enable: false, resident: [], maxResults: 5 },
    debugStream: false,
    logger: logger as never,
    resources: new ResourceCenter("v3-wake", home),
    attachment: { imageInput: false } as never,
  });
  runtimes.push(runtime);
  return { runtime, bodies };
}

const promptOf = (body: unknown): string => JSON.stringify(body);

describe("v3 willingness wakeup", () => {
  it("joins a message mid-turn without a second wake", async () => {
    const release = Promise.withResolvers<void>();
    const { runtime, bodies } = await makeRuntime({
      wakeup: new V3WakeupInstance({ probabilityThreshold: 0, probabilityAmplifier: 1 }),
      gate: async (call) => {
        if (call === 0) await release.promise;
      },
      steps: (index) => (index === 0 ? [{ name: "speak", input: { text: "one moment" } }] : [{ name: "finish", input: {} }]),
    });

    await runtime.deliver(created("m1", "opening line"));
    await until(async () => bodies.length >= 1);
    await runtime.deliver(created("m2", "arrived while responding"));
    release.resolve();
    await waitForTurns(runtime, 1);

    // 本轮开场时 m2 还没到；同轮下一步已经能看到 join 进来的 m2。
    expect(promptOf(bodies[0])).not.toContain("arrived while responding");
    expect(promptOf(bodies[1])).toContain("arrived while responding");
    // 输入没有被扣到另一轮：m2 已入事实流，且整段过程只有这一轮。
    expect(createdIds(await storedMessages(runtime))).toEqual(["m1", "m2"]);
    expect(await terminalTurns(runtime)).toBe(1);
  });

  it("stays silent below the probability threshold", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: new V3WakeupInstance({ probabilityThreshold: 1_000, probabilityAmplifier: 1 }),
      steps: () => [],
    });

    await runtime.deliver(created("m1"));
    await until(async () => createdIds(await storedMessages(runtime)).length === 1);
    await sleep(50);

    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});
