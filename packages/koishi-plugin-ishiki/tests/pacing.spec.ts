import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jsonSchema, tool, type AgentMessage, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createFinish } from "../src/builtin-tools/finish.js";
import { collapse } from "../src/context/standard.engine.js";
import type { PacingConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime, type AgentRuntimeConfig } from "../src/runtime.js";

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

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 2000; index += 1) {
    if (await condition()) return;
    await sleep(5);
  }
  throw new Error("condition not reached");
}

/** 不结束轮次的工具：步数提醒只有在模型继续干活时才看得到。 */
const probeTool: ToolSet = {
  probe: tool({
    description: "do a small piece of work",
    inputSchema: jsonSchema<{ note: string }>({ type: "object", properties: { note: { type: "string" } }, required: ["note"] }),
    execute: async (input) => ({ ok: true, note: input.note }),
  }),
};

async function makeRuntime(options: {
  pacing: PacingConfig;
  steps: (index: number) => Call[];
}): Promise<{ runtime: AgentRuntime; bodies: Array<Record<string, unknown>> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-pacing-"));
  homes.push(home);
  const bodies: Array<Record<string, unknown>> = [];
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
      return reply(options.steps(call));
    },
  });
  const runtime = new AgentRuntime({
    id: "pacing",
    home,
    model: gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { finish: createFinish(), ...probeTool },
    extensions: [],
    context: { renderMessages: (messages) => collapse(messages) },
    // 主动开轮：本用例只关心步数，不需要消息投递。
    wakeup: { attach: () => () => {} },
    codemode: { enable: false, direct: [], timeoutMs: 1000 },
    pacing: options.pacing,
    toolsearch: { enable: false, resident: [], maxResults: 5 },
    debugStream: false,
    logger: logger as never,
    resources: new ResourceCenter("pacing", home),
    attachment: { imageInput: false } as never,
  } satisfies AgentRuntimeConfig);
  runtimes.push(runtime);
  return { runtime, bodies };
}

async function terminalTurns(runtime: AgentRuntime): Promise<number> {
  const entries = await runtime.storage.read();
  return entries.filter(
    (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
  ).length;
}

async function storedText(runtime: AgentRuntime): Promise<string> {
  const messages: AgentMessage[] = (await runtime.storage.read()).flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
  return JSON.stringify(messages);
}

/** 一直干活，永不停轮：步数上限必须由 core 的 maxSteps 收住。 */
const keepWorking = (): Call[] => [{ name: "probe", input: { note: "still going" } }];

describe("step pacing", () => {
  it("stops at maxSteps and warns before the last step runs", async () => {
    const { runtime, bodies } = await makeRuntime({ pacing: { maxSteps: 3, wrapUpSteps: 1, progressAt: 0 }, steps: keepWorking });

    runtime.agent.continue("hello");
    await until(async () => (await terminalTurns(runtime)) === 1);

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0])).not.toContain("Step budget:");
    expect(JSON.stringify(bodies[1])).not.toContain("Step budget:");
    // 第三步是最后一次模型调用：这一句必须已经到模型手上，否则这一轮就静默结束了。
    expect(JSON.stringify(bodies[2])).toContain("Step budget: 1 step left in this waking");
    expect(JSON.stringify(bodies[2])).toContain("send_message");
  });

  it("repeats the warning on every step inside the wrap-up window", async () => {
    const { runtime, bodies } = await makeRuntime({ pacing: { maxSteps: 4, wrapUpSteps: 2, progressAt: 0 }, steps: keepWorking });

    runtime.agent.continue("hello");
    await until(async () => (await terminalTurns(runtime)) === 1);

    expect(bodies).toHaveLength(4);
    // 剩余步数按「这一步跑完还剩几步」计：第 1、2 步还剩 3、2 步，不提醒；
    // 第 3、4 步分别剩 2、1 步，落进 wrapUpSteps=2 的窗口。
    expect(JSON.stringify(bodies[1])).not.toContain("Step budget:");
    expect(JSON.stringify(bodies[2])).toContain("Step budget: 2 steps left in this waking");
    expect(JSON.stringify(bodies[3])).toContain("Step budget: 1 step left in this waking");
  });

  it("asks for a progress report once, and only while the turn has not spoken", async () => {
    const { runtime, bodies } = await makeRuntime({ pacing: { maxSteps: 20, wrapUpSteps: 0, progressAt: 1 }, steps: keepWorking });

    runtime.agent.continue("hello");
    await until(async () => (await terminalTurns(runtime)) === 1);

    expect(JSON.stringify(bodies[0])).not.toContain("Step budget:");
    expect(JSON.stringify(bodies[1])).toContain("Step budget: 19 steps left in this waking");
    expect(JSON.stringify(bodies[1])).toContain("continue: true");
    expect(JSON.stringify(bodies[2])).not.toContain("Step budget:");
    expect(JSON.stringify(bodies[3])).not.toContain("Step budget:");
  });

  it("keeps both reminders out of the stored history", async () => {
    const { runtime } = await makeRuntime({ pacing: { maxSteps: 3, wrapUpSteps: 1, progressAt: 0 }, steps: keepWorking });

    runtime.agent.continue("hello");
    await until(async () => (await terminalTurns(runtime)) === 1);

    expect(await storedText(runtime)).not.toContain("Step budget:");
  });
});
