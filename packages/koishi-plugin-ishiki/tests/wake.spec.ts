import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, jsonSchema, tool, type AgentMessage, type CustomMessages, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { App } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFinish } from "../src/builtin-tools/finish.js";
import type { ExtensionInstance, RuntimeHandle } from "../src/extension.js";
import Ishiki from "../src/index.js";
import { ResourceCenter } from "../src/resources/center.js";
import { AgentRuntime } from "../src/runtime.js";
import type { IshikiEvent } from "../src/types.js";
import type { WakeupEngineInstance } from "../src/wakeup/index.js";

const logger = { warn() {}, error() {}, info() {}, debug() {}, level: 1 } as never;

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

function created(messageId: string, content = "hello"): CustomMessages {
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

async function terminalTurns(runtime: AgentRuntime): Promise<number> {
  const entries = await runtime.storage.read();
  return entries.filter(
    (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
  ).length;
}

/** 等到第 expected 个终态轮事件出现；唤醒在事实提交后异步发生，不能只靠 wait()。 */
async function waitForTurns(runtime: AgentRuntime, expected: number): Promise<void> {
  for (let index = 0; index < 2000; index += 1) {
    if ((await terminalTurns(runtime)) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`only ${await terminalTurns(runtime)} of ${expected} terminal turns`);
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
  decide?: (event: IshikiEvent) => "trigger" | "wait" | Promise<"trigger" | "wait">;
  gate?: (call: number) => Promise<void>;
  extensions?: ExtensionInstance[];
}): Promise<{ runtime: AgentRuntime; bodies: unknown[] }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-wake-"));
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
    id: "wake",
    home,
    model: gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { finish: createFinish(), ...speakTool },
    extensions: options.extensions ?? [],
    // 最小上下文投影：把 ishiki.message.created 渲染成可见 user 消息（与真实引擎同方向）。
    context: {
      renderMessages: (messages) =>
        messages.map((message) =>
          message.role === "custom" && message.type === "ishiki.message.created"
            ? ({ role: "user", content: `[${message.data.user.id}] ${message.data.content}` } as AgentMessage)
            : message,
        ),
    },
    wakeup: { decide: options.decide ?? (() => "wait") } as WakeupEngineInstance,
    codemode: { enable: false, direct: [], timeoutMs: 1000 },
    toolsearch: { enable: false, resident: [], maxResults: 5 },
    debugStream: false,
    logger,
    resources: new ResourceCenter("wake", home),
    attachment: { imageInput: false } as never,
  });
  runtimes.push(runtime);
  return { runtime, bodies };
}

const promptOf = (body: unknown): string => JSON.stringify(body);

describe("AgentRuntime wake", () => {
  it("records an inbound message on arrival and decides only after the commit", async () => {
    let sawCommitted = false;
    let runtimeRef: AgentRuntime | undefined;
    const { runtime } = await makeRuntime({
      steps: () => [],
      decide: async (event) => {
        if (event.type !== "ishiki.message.created") return "wait";
        const entries = await runtimeRef!.storage.read();
        sawCommitted = entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.data.role === "custom" &&
            entry.data.type === "ishiki.message.created" &&
            entry.data.data.messageId === event.data.messageId,
        );
        return "trigger";
      },
    });
    runtimeRef = runtime;

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);

    expect(sawCommitted).toBe(true);
    // toolsearch 关闭时，首个 step 边界仍会补发一条目录（既有行为）；这里只关心唤醒管线本身。
    const messages = (await runtime.storage.read())
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.data)
      .filter((message) => !(message.role === "custom" && message.type === "ishiki.tools.catalog"));
    const roles = messages.map((message) => message.role);
    // 信号轮由 continue 打开：合成 Continue 消息是它的开场输入。
    expect(roles).toEqual(["custom", "user", "assistant"]);
  });

  it("stays silent when the signal decides wait", async () => {
    const { runtime } = await makeRuntime({ steps: () => [], decide: () => "wait" });

    await runtime.deliver(created("m1"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await terminalTurns(runtime)).toBe(0);
    const stored = (await runtime.storage.read()).filter((entry) => entry.type === "message");
    expect(stored.some((entry) => entry.data.role === "custom")).toBe(true);
  });

  it("the declared msgs window alone wakes the agent, with no signal", async () => {
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 2 } }] : []),
      decide: (event) => (event.type === "ishiki.message.created" && event.data.messageId === "m1" ? "trigger" : "wait"),
    });

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);
    // 声明 msgs:2 —— 只来一条不够，不该开轮。
    await runtime.deliver(created("m2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await terminalTurns(runtime)).toBe(1);

    // 第二条够数：条件触发，不需要信号。
    await runtime.deliver(created("m3"));
    await waitForTurns(runtime, 2);

    // 触发即清空：再来两条也不该继续开轮。
    await runtime.deliver(created("m4"));
    await runtime.deliver(created("m5"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await terminalTurns(runtime)).toBe(2);
  });

  it("hands extensions a runtime handle and stops them with the runtime", async () => {
    const handles: RuntimeHandle[] = [];
    const stopped: string[] = [];
    let disposed = 0;
    const extension: ExtensionInstance = {
      attach: (handle) => {
        handles.push(handle);
        return () => {
          disposed += 1;
        };
      },
      stop: () => {
        stopped.push("ext");
      },
    };
    const { runtime } = await makeRuntime({ steps: () => [], decide: () => "trigger", extensions: [extension] });

    await handles[0]!.deliver(created("m1", "via handle"));
    await waitForTurns(runtime, 1);
    expect(typeof handles[0]!.wake("scheduled")).toBe("string");
    await waitForTurns(runtime, 2);

    await runtime.stop();
    expect(stopped).toEqual(["ext"]);
    expect(disposed).toBe(1);
  });
});

describe("host address entry", () => {
  it("routes by address, spawns lazily and throws when unclaimed", async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-host-"));
    homes.push(dataPath);
    await fs.mkdir(path.join(dataPath, "profiles", "test"), { recursive: true });
    await fs.writeFile(
      path.join(dataPath, "models.yaml"),
      [
        "providers:",
        "  mock:",
        "    api: openai-completions",
        "    baseUrl: https://fixture.invalid/v1",
        "    apiKey: test-only",
        "    models:",
        "      - id: vision",
        "        type: language",
        "        input: [text]",
      ].join("\n"),
    );
    await fs.writeFile(path.join(dataPath, "profiles", "test", "profile.yaml"), ["model: mock:vision", "channels:", '  "test:bot":', '    - "*"'].join("\n"));

    const app = new App();
    app.plugin(Ishiki, { dataPath, logLevel: 0, dumpRequests: false, debugStream: false });
    await app.start();
    try {
      const address = { platform: "test", selfId: "bot", channelId: "channel" };
      expect(() => app.ishiki.wake({ platform: "test", selfId: "bot", channelId: "other" })).toThrow("no profile claims");

      // profile 经 ctx.inject 异步激活：等它就绪再断言按需派生。
      const id = await vi.waitFor(
        () => {
          const wakeId = app.ishiki.wake(address, "scheduled");
          if (typeof wakeId !== "string") throw new Error("profile not ready yet");
          return wakeId;
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(typeof id).toBe("string");
      await app.ishiki.deliver(address, created("m1"));

      const runtimesRoot = path.join(dataPath, "profiles", "test", "runtimes");
      for (let index = 0; index < 100; index += 1) {
        const found = await fs.readdir(runtimesRoot, { recursive: true }).catch(() => []);
        const file = found.find((name) => name.endsWith("events.jsonl"));
        if (file !== undefined) {
          const content = await fs.readFile(path.join(runtimesRoot, file), "utf8").catch(() => "");
          if (content.includes("m1")) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("delivered event never reached the runtime storage");
    } finally {
      await app.stop();
    }
  }, 20_000);
});

describe("wake smoke", () => {
  it("refuses to jump in on a split sentence: the first turn ends on wait, then one turn answers both parts", async () => {
    const { runtime, bodies } = await makeRuntime({
      decide: (event) => (event.type === "ishiki.message.created" && event.data.messageId === "m1" ? "trigger" : "wait"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 1 } }] : index === 1 ? [{ name: "speak", input: { text: "both parts answered" } }] : []),
    });

    await runtime.deliver(created("m1", "first part"));
    await waitForTurns(runtime, 1);
    // 首轮只有一步：wait 本身收尾，不再为空转多跑一次模型。
    expect(bodies).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain('"wait"');

    await runtime.deliver(created("m2", "second part"));
    await waitForTurns(runtime, 2);

    // 条件轮（call1）以合成 Continue 开场，两段都在场，同一步作答。
    expect(promptOf(bodies[1])).toContain("Continue.");
    expect(promptOf(bodies[1])).toContain("first part");
    expect(promptOf(bodies[1])).toContain("second part");
    expect(promptOf(bodies[1])).toContain("speak");
  });

  it("fires the declared timer after a silent message: one more turn runs with no new input", async () => {
    const { runtime, bodies } = await makeRuntime({
      decide: (event) => (event.type === "ishiki.message.created" && event.data.messageId === "m1" ? "trigger" : "wait"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { secs: 1 } }] : index === 1 ? [{ name: "speak", input: { text: "checking in" } }] : []),
    });

    await runtime.deliver(created("m1", "only an at-mention"));
    await waitForTurns(runtime, 1);

    // 没有任何新消息，纯靠 secs 截止唤醒。
    await waitForTurns(runtime, 2);
    expect(promptOf(bodies[1])).toContain("Reason: timer 1s expired");
  }, 15_000);

  it("joins a second message sent mid-turn into the running turn, then falls back to the condition machine", async () => {
    const release = Promise.withResolvers<void>();
    const { runtime, bodies } = await makeRuntime({
      // 只有第一条触发信号；第二条是普通消息，落库 join，不产生信号轮。
      decide: (event) => (event.type === "ishiki.message.created" && event.data.messageId === "m1" ? "trigger" : "wait"),
      gate: async (call) => {
        if (call === 0) await release.promise;
      },
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 1 } }] : index === 1 ? [{ name: "speak", input: { text: "follow-up sent" } }] : []),
    });

    await runtime.deliver(created("m1", "opening line"));
    for (let index = 0; index < 1000 && bodies.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.deliver(created("m2", "arrived while responding"));
    release.resolve();
    await waitForTurns(runtime, 2);

    // 当前轮开场时 m2 还没到；第二步模型调用（同轮）已经能看到 join 进来的 m2。
    expect(promptOf(bodies[0])).not.toContain("arrived while responding");
    expect(promptOf(bodies[1])).toContain("arrived while responding");
  });

  it("declares wait in the same turn as speaking: one step says it and schedules, no idle step", async () => {
    const { runtime, bodies } = await makeRuntime({
      decide: () => "wait",
      steps: () => [
        { name: "wait", input: { msgs: 1 } },
        { name: "speak", input: { text: "said and scheduled" } },
      ],
    });

    await runtime.deliver(created("m1", "hello"));
    // 信号为 wait：不会自动开轮，靠 wait 声明触发。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await terminalTurns(runtime)).toBe(0);

    runtime.wake("first contact");
    await waitForTurns(runtime, 1);

    // 同一步里既说了话也声明了条件：整轮只有一次模型调用。
    expect(bodies).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain("Continue.");
    // 声明的 msgs:1 生效：再来一条就开轮（信号为 wait，只能是条件触发的）。
    await runtime.deliver(created("m2", "anything"));
    await waitForTurns(runtime, 2);
  });

  it("ends a turn on wait alone: staying silent still finishes the turn", async () => {
    const { runtime, bodies } = await makeRuntime({
      decide: () => "wait",
      steps: () => [{ name: "wait", input: { msgs: 0 } }],
    });

    runtime.wake("check in");
    await waitForTurns(runtime, 1);

    // 保持沉默也是收尾动作：没有第二次模型调用。
    expect(bodies).toHaveLength(1);
    // wait({msgs: 0}) 关掉自动唤醒：后续消息不再开轮，只剩信号与外部唤醒。
    await runtime.deliver(created("m1", "hello"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await terminalTurns(runtime)).toBe(1);
  });

  it("does not self-wake without a declaration: no condition at turn end, nothing written to the facts", async () => {
    const { runtime, bodies } = await makeRuntime({
      decide: () => "wait",
      steps: () => [],
    });

    // 外部唤醒一轮，模型什么都没声明。
    runtime.wake("scheduled");
    await waitForTurns(runtime, 1);

    // 轮末没有条件：后面安静地等，不来第二响。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await terminalTurns(runtime)).toBe(1);
    expect(bodies).toHaveLength(1);

    // 条件是运行态：事实流里没有它的位置。
    const types = new Set((await runtime.storage.read()).map((entry) => entry.type));
    expect([...types]).not.toContain("ishiki.wait");
  });
});
