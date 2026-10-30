import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCustomMessage,
  jsonSchema,
  tool,
  type Agent,
  type AgentMessage,
  type AgentPlugin,
  type CustomMessages,
  type Experimental_DecisionModelV4 as DecisionModelV4,
  type Experimental_DecisionModelV4CallOptions as DecisionModelCallOptions,
  type Experimental_DecisionModelV4Result as DecisionModelResult,
  type ToolSet,
} from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFinish } from "../src/builtin-tools/finish.js";
import { collapse } from "../src/context/render.js";
import type { ExtensionInstance } from "../src/extension.js";
import { CodemodeConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime } from "../src/runtime.js";
import type { IshikiMessageCreated } from "../src/types.js";
import {
  StandardWakeupInstance,
  WillingnessWakeupConfig,
  WillingnessWakeupInstance,
  type WakeupEngineInstance,
  type WillingnessAddress,
} from "../src/wakeup/index.js";
import { JevWakeupInstance } from "../src/wakeup/jev.engine.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=";

/** 测试 logger 替身：只要 level 与不抛错的 sink，运行时只在失败路径上碰它。 */
const logger = {
  level: 1,
  debug: (message: string) => void message,
  info: (message: string) => void message,
  warn: (message: string) => void message,
  error: (message: string) => void message,
};

const jevContext = {
  runtimeId: "jev",
  domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
  logger,
} as never;

function jevModel(decide: (options: DecisionModelCallOptions) => DecisionModelResult | PromiseLike<DecisionModelResult>): DecisionModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "jev",
    supportedQuestionTypes: ["choice", "boolean"],
    doDecide: async (options) => decide(options),
  };
}

function jevEvidence(relation: "addressed" | "followup" | "open" | "other" | "ambient" = "addressed"): DecisionModelResult {
  const relations = {
    addressed: relation === "addressed" ? 0.9 : 0.025,
    followup: relation === "followup" ? 0.9 : 0.025,
    open: relation === "open" ? 0.9 : 0.025,
    other: relation === "other" ? 0.9 : 0.025,
    ambient: relation === "ambient" ? 0.9 : 0.025,
  };
  return {
    answers: {
      relation: { type: "choice", choice: relation, probabilities: relations },
      ready: { type: "boolean", probability: 0.95 },
      receptive: { type: "boolean", probability: 0.9 },
      worthwhile: { type: "boolean", probability: 0.85 },
      social: { type: "boolean", probability: 0.4 },
      withdrawn: { type: "boolean", probability: 0.02 },
      closed: { type: "boolean", probability: 0.02 },
      interested: { type: "boolean", probability: 0.8 },
    },
    warnings: [],
  };
}

const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
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

function createdIn(channelId: string, messageId: string, content = "hello", overrides: Partial<IshikiMessageCreated> = {}): CustomMessages {
  return createCustomMessage("ishiki.message.created", {
    platform: "test",
    selfId: "bot",
    channelId,
    messageId,
    timestamp: 1,
    content,
    isDirect: true,
    user: { id: "u" },
    ...overrides,
  });
}

function created(messageId: string, content = "hello"): CustomMessages {
  return createdIn("channel", messageId, content);
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 等到条件成立：唤醒在事实提交后异步发生，不能只靠一次 read。 */
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

function sendMessageTool(success: boolean): ToolSet {
  return {
    send_message: tool({
      description: "send a message",
      inputSchema: jsonSchema<{ messages: string[] }>({
        type: "object",
        properties: { messages: { type: "array", items: { type: "string" } } },
        required: ["messages"],
      }),
      execute: async () =>
        success
          ? { ok: true, ids: ["sent"] }
          : {
              ok: false,
              error: { name: "SendError", message: "failed" },
              sent: [],
              failedAt: 0,
            },
    }),
  };
}

/**
 * 订阅式测试唤醒引擎：对提交后的 created 事实逐条判定，判定为醒且空闲时直接 continue()。
 * 判定跑在独立任务里（订阅回调被 core await，不能阻塞提交边界），dispose 后不再唤醒。
 */
function judgeWakeup(decide: (message: IshikiMessageCreated, agent: Agent) => boolean | Promise<boolean>): WakeupEngineInstance {
  return {
    attach(agent) {
      let disposed = false;
      const unsubscribe = agent.channel.subscribe("agent", (event) => {
        if (event.type !== "message.appended") return;
        const message = event.message;
        if (message.role !== "custom" || message.type !== "ishiki.message.created") return;
        void (async () => {
          if (disposed || !(await decide(message.data, agent))) return;
          if (!disposed && agent.isIdle()) agent.continue();
        })().catch((error: unknown) => logger.warn(`wakeup judgement failed: ${String(error)}`));
      });
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
  };
}

/** 订阅式测试引擎：首条 created 武装一次延迟唤醒，其后的输入合入同一次；dispose 撤销待触发唤醒。 */
function delayedWakeup() {
  const release = Promise.withResolvers<void>();
  const observed: string[] = [];
  const state = { armed: false, disposed: 0 };
  const engine: WakeupEngineInstance = {
    attach(agent) {
      let cancelled = false;
      const unsubscribe = agent.channel.subscribe("agent", (event) => {
        if (event.type !== "message.appended") return;
        const message = event.message;
        if (message.role !== "custom" || message.type !== "ishiki.message.created") return;
        observed.push(message.data.messageId);
        if (state.armed) return;
        state.armed = true;
        void (async () => {
          await release.promise;
          if (cancelled || !agent.isIdle()) return;
          agent.continue();
        })().catch((error: unknown) => logger.warn(`delayed wakeup failed: ${String(error)}`));
      });
      return () => {
        cancelled = true;
        state.disposed += 1;
        unsubscribe();
      };
    },
  };
  return { engine, observed, state, release: release.resolve };
}

async function makeRuntime(options: {
  steps: (index: number) => Call[];
  wakeup?: WakeupEngineInstance;
  gate?: (call: number) => Promise<void>;
  extensions?: ExtensionInstance[];
  externalPlugins?: readonly AgentPlugin[];
  tools?: ToolSet;
  codemode?: boolean;
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
    tools: { finish: createFinish(), ...speakTool, ...options.tools },
    extensions: options.extensions ?? [],
    externalPlugins: options.externalPlugins,
    // 真实 standard 引擎的投影：created 折成 user 行。
    context: { renderMessages: (messages) => collapse(messages) },
    wakeup: options.wakeup ?? judgeWakeup(() => false),
    codemode: CodemodeConfig({ enable: options.codemode ?? false }),
    pacing: { maxSteps: 20, wrapUpSteps: 0, progressAt: 0 },
    debugStream: false,
    logger: logger as never,
    resources: new ResourceCenter("wake", home),
    attachment: { imageInput: false } as never,
  });
  runtimes.push(runtime);
  return { runtime, bodies };
}

const promptOf = (body: unknown): string => JSON.stringify(body);

describe("AgentRuntime wakeup subscription", () => {
  it("decides after the commit and opens on the stored fact, with no synthetic input", async () => {
    let committed = false;
    const { runtime, bodies } = await makeRuntime({
      steps: () => [],
      wakeup: judgeWakeup(async (message, agent) => {
        const entries = await agent.storage.read();
        committed = entries.some(
          (entry) =>
            entry.type === "message" &&
            entry.data.role === "custom" &&
            entry.data.type === "ishiki.message.created" &&
            entry.data.data.messageId === message.messageId,
        );
        return true;
      }),
    });

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);

    expect(committed).toBe(true);
    const messages = await storedMessages(runtime);
    expect(createdIds(messages)).toEqual(["m1"]);
    expect(messages.filter((message) => message.role === "user")).toEqual([]);
    // 无 prompt 的 continue 靠历史开轮：请求里只有投影后的原文，没有合成的 user 输入。
    const request = bodies[0] as { messages: Array<{ role: string }> };
    expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain("hello");
    expect(promptOf(bodies[0])).not.toContain("Continue.");
  });

  it("includes external AgentPlugin instructions in the model request", async () => {
    const { runtime, bodies } = await makeRuntime({
      steps: () => [],
      wakeup: judgeWakeup(() => true),
      externalPlugins: [
        {
          name: "prompt-overlay-test",
          enforce: "post",
          extendInstructions: () => "EXTERNAL_PROMPT_OVERLAY_SENTINEL",
        },
      ],
    });

    await runtime.deliver(created("overlay"));
    await waitForTurns(runtime, 1);

    expect(promptOf(bodies[0])).toContain("EXTERNAL_PROMPT_OVERLAY_SENTINEL");
  });

  it("stays silent when the engine declines while the fact stays stored", async () => {
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: judgeWakeup(() => false) });

    await runtime.deliver(created("m1"));
    await until(async () => createdIds(await storedMessages(runtime)).length === 1);
    await sleep(50);

    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
    expect(createdIds(await storedMessages(runtime))).toEqual(["m1"]);
  });

  it("merges a burst into one delayed round: input stored on arrival, nothing withheld", async () => {
    const debounce = delayedWakeup();
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: debounce.engine });

    await runtime.deliver(created("m1", "first part"));
    await runtime.deliver(created("m2", "second part"));
    await runtime.deliver(created("m3", "third part"));
    await until(async () => debounce.observed.length === 3);

    // 输入到达即入事实流：延迟唤醒还没放行，模型请求为零，消息不攒在唤醒里。
    expect(createdIds(await storedMessages(runtime))).toEqual(["m1", "m2", "m3"]);
    expect(bodies).toHaveLength(0);
    expect(await terminalTurns(runtime)).toBe(0);

    debounce.release();
    await waitForTurns(runtime, 1);

    // 三段合入同一轮；这轮靠历史开轮，也没有任何合成的 user 输入。
    expect(await terminalTurns(runtime)).toBe(1);
    expect(promptOf(bodies[0])).toContain("first part");
    expect(promptOf(bodies[0])).toContain("second part");
    expect(promptOf(bodies[0])).toContain("third part");
    expect(promptOf(bodies[0])).not.toContain("Continue.");
    expect((await storedMessages(runtime)).filter((message) => message.role === "user")).toEqual([]);
  });

  it("ignores internal appends and wakes on a matching message through the real standard engine", async () => {
    const { runtime, bodies } = await makeRuntime({
      steps: () => [],
      wakeup: new StandardWakeupInstance({ direct: false, atSelf: false, quoteSelf: false, keywords: ["ishiki-ping"] }),
    });

    // init 与 deliver 落盘的内部附加消息既不该开轮，也必须照常存储。
    await runtime.deliver(created("m1", `<img src="data:image/png;base64,${PNG}"/>`));
    await until(async () => (await storedMessages(runtime)).some((message) => message.role === "custom" && message.type === "ishiki.attachment"));
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(0);
    const internal = await storedMessages(runtime);
    expect(createdIds(internal)).toEqual(["m1"]);

    await runtime.deliver(created("m2", "ishiki-ping"));
    await waitForTurns(runtime, 1);
    expect(promptOf(bodies[0])).toContain("ishiki-ping");
    expect(promptOf(bodies[0])).not.toContain("Continue.");
    // 这轮自己的 assistant 输出同样是内部附加：不自我唤醒，不追加第二轮。
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(1);
  });

  it("runtime.wake opens a round on the raw prompt and stores exactly it", async () => {
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: judgeWakeup(() => false) });

    expect(typeof runtime.wake("first contact")).toBe("string");
    await waitForTurns(runtime, 1);

    const users = (await storedMessages(runtime)).filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ content: "first contact" });
    expect(promptOf(bodies[0])).toContain("first contact");
    expect(promptOf(bodies[0])).not.toContain("Continue.");
  });

  it("runtime.wake supplies content when the prompt is empty", async () => {
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: judgeWakeup(() => false) });

    expect(typeof runtime.wake()).toBe("string");
    await waitForTurns(runtime, 1);
    expect(typeof runtime.wake("   ")).toBe("string");
    await waitForTurns(runtime, 2);

    const users = (await storedMessages(runtime)).filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ content: "Continue." });
    expect(users[1]).toMatchObject({ content: "Continue." });
    expect(promptOf(bodies[0])).toContain("Continue.");
    expect(promptOf(bodies[1])).toContain("Continue.");
  });

  it("a declared secs window opens the next round on stored history", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { i: "等待下一轮", secs: 1 } }] : [{ name: "finish", input: { i: "结束" } }]),
    });

    await runtime.deliver(created("m1", "only an at-mention"));
    await waitForTurns(runtime, 1);
    // 没有任何新消息，纯靠 secs 截止开轮；触发原因要进入模型上下文，避免空唤醒。
    await waitForTurns(runtime, 2);

    expect(bodies).toHaveLength(2);
    expect(promptOf(bodies[1])).toContain("only an at-mention");
    expect(promptOf(bodies[1])).toContain("timer 1s expired");
    const stored = await storedMessages(runtime);
    expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "timer 1s expired" })]));
    expect(stored).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "ishiki.wake" })]));
  }, 15_000);

  it("treats wait({msgs: 0}) as no declaration: later input opens no round", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup(() => false),
      steps: () => [{ name: "wait", input: { i: "不声明等待", msgs: 0 } }],
    });

    runtime.wake("check in");
    await waitForTurns(runtime, 1);
    // 保持沉默也是收尾动作：wait 与其余动作同轮收轮，没有第二次模型调用。
    expect(bodies).toHaveLength(1);

    await runtime.deliver(created("m1", "hello"));
    await until(async () => createdIds(await storedMessages(runtime)).length === 1);
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(1);
  });

  it("does not self-wake without a declaration, and keeps conditions out of the facts", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup(() => false),
      steps: () => [],
    });

    runtime.wake("scheduled");
    await waitForTurns(runtime, 1);

    // 轮末没有条件：安静地等，不来第二响。
    await sleep(100);
    expect(await terminalTurns(runtime)).toBe(1);
    expect(bodies).toHaveLength(1);

    // 条件是运行态：事实流里没有它的位置。
    const types = new Set((await runtime.storage.read()).map((entry) => entry.type));
    expect([...types]).not.toContain("ishiki.wait");
  });

  it("speaks and declares the next window in one step, without an extra idle step", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup(() => false),
      steps: () => [
        { name: "wait", input: { i: "等待下一条", msgs: 1 } },
        { name: "speak", input: { i: "回复", text: "said and scheduled" } },
      ],
    });

    runtime.wake("first contact");
    await waitForTurns(runtime, 1);

    // 同一步里既说了话也声明了条件：整轮只有一次模型调用。
    expect(bodies).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain("first contact");
    expect(promptOf(bodies[0])).not.toContain("Continue.");
  });

  it("hands extensions the runtime and disposes them with the runtime", async () => {
    const handles: AgentRuntime[] = [];
    const stopped: string[] = [];
    let disposed = 0;
    const extension: ExtensionInstance = {
      attach: (runtime) => {
        handles.push(runtime);
        return () => {
          disposed += 1;
        };
      },
      stop: () => {
        stopped.push("ext");
      },
    };
    const { runtime } = await makeRuntime({ steps: () => [], wakeup: judgeWakeup(() => true), extensions: [extension] });

    await handles[0]!.deliver(created("m1", "via handle"));
    await waitForTurns(runtime, 1);
    // continue 只在空闲时开轮：等终态事件之后队列真正排空再显式唤醒。
    await until(async () => runtime.agent.isIdle());
    expect(typeof handles[0]!.wake("scheduled")).toBe("string");
    await waitForTurns(runtime, 2);

    await runtime.stop();
    expect(stopped).toEqual(["ext"]);
    expect(disposed).toBe(1);
  });

  it("drops pending wake work on dispose: no late round after stop", async () => {
    const debounce = delayedWakeup();
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: debounce.engine });

    await runtime.deliver(created("m1"));
    await until(async () => debounce.observed.length === 1);

    await runtime.stop();
    expect(debounce.state.disposed).toBe(1);
    debounce.release();
    await sleep(50);

    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});

describe("JEV wakeup subscription", () => {
  it("asks a gateway DecisionModelV4 with structured evidence questions", async () => {
    const calls: DecisionModelCallOptions[] = [];
    const engine = new JevWakeupInstance(
      {
        debounceMs: 0,
        maxWaitMs: 0,
        timeoutMs: 500,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      jevContext,
      jevModel((options) => {
        calls.push(options);
        return jevEvidence();
      }),
    );
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: engine });
    const timestamp = Date.now();

    await runtime.deliver(
      createdIn("channel", "m1", "这个具体问题应该怎么排查？", {
        isDirect: false,
        timestamp,
        user: { id: "u", name: "甲" },
      }),
    );
    await waitForTurns(runtime, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0].questions.relation).toMatchObject({ type: "choice" });
    expect(calls[0].questions.ready).toMatchObject({ type: "boolean" });
    expect(calls[0].abortSignal).toBeInstanceOf(AbortSignal);
    const part = calls[0].state[0];
    expect(part).toMatchObject({ type: "json" });
    if (part?.type !== "json") throw new Error("missing JSON decision state");
    const state = part.value as {
      pending_message: { author_id: string; text: string };
      pending_messages: Array<{ id: string }>;
      recent_messages: Array<{ id: string }>;
    };
    expect(state.pending_message).toMatchObject({ author_id: "u", text: "这个具体问题应该怎么排查？" });
    expect(state.pending_messages.map((message) => message.id)).toEqual(["m1"]);
    expect(state.recent_messages).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain("这个具体问题应该怎么排查？");
  });

  it("chooses one author from a merged batch before judging evidence", async () => {
    const calls: DecisionModelCallOptions[] = [];
    const engine = new JevWakeupInstance(
      {
        debounceMs: 100,
        maxWaitMs: 200,
        timeoutMs: 500,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      jevContext,
      jevModel((options) => {
        calls.push(options);
        if ("focus" in options.questions) {
          return {
            answers: {
              focus: {
                type: "choice",
                choice: "author_1",
                probabilities: { author_0: 0.1, author_1: 0.85, none: 0.05 },
              },
            },
            warnings: [],
          };
        }
        return jevEvidence();
      }),
    );
    const { runtime } = await makeRuntime({ steps: () => [], wakeup: engine });
    const timestamp = Date.now();

    await runtime.deliver(
      createdIn("channel", "m1", "甲在说另一件事", {
        isDirect: false,
        timestamp,
        user: { id: "u1", name: "甲" },
      }),
    );
    await until(async () => engine.history("channel").length === 1);
    await runtime.deliver(
      createdIn("channel", "m2", "这个补全后的问题是在问我", {
        isDirect: false,
        timestamp: timestamp + 1,
        user: { id: "u2", name: "乙" },
      }),
    );
    await waitForTurns(runtime, 1);

    expect(calls).toHaveLength(2);
    expect(calls[0].questions.focus).toMatchObject({ type: "choice" });
    expect(calls[1].questions.relation).toMatchObject({ type: "choice" });
    const part = calls[1].state[0];
    if (part?.type !== "json") throw new Error("missing JSON decision state");
    const state = part.value as {
      pending_message: { author_id: string; text: string };
      pending_messages: Array<{ author_id: string }>;
    };
    expect(state.pending_message).toMatchObject({ author_id: "u2", text: "这个补全后的问题是在问我" });
    expect(state.pending_messages.map((message) => message.author_id)).toEqual(["u1", "u2"]);
  });

  it("drops a mixed batch when no author has a usable opening", async () => {
    const calls: DecisionModelCallOptions[] = [];
    const engine = new JevWakeupInstance(
      {
        debounceMs: 1000,
        maxWaitMs: 1500,
        timeoutMs: 500,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      jevContext,
      jevModel((options) => {
        calls.push(options);
        if ("focus" in options.questions) {
          return {
            answers: {
              focus: {
                type: "choice",
                choice: "none",
                probabilities: { author_0: 0.05, author_1: 0.05, none: 0.9 },
              },
            },
            warnings: [],
          };
        }
        return jevEvidence();
      }),
    );
    const { runtime } = await makeRuntime({ steps: () => [], wakeup: engine });
    const timestamp = Date.now();

    await runtime.deliver(
      createdIn("channel", "m1", "甲在同别人说话", {
        isDirect: false,
        timestamp,
        user: { id: "u1", name: "甲" },
      }),
    );
    await runtime.deliver(
      createdIn("channel", "m2", "乙也在同别人说话", {
        isDirect: false,
        timestamp: timestamp + 1,
        user: { id: "u2", name: "乙" },
      }),
    );
    await until(async () => engine.history("channel").length === 2);
    await until(async () => calls.length === 1);
    await sleep(20);

    expect(await terminalTurns(runtime)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.focus).toMatchObject({ type: "choice" });

    await runtime.deliver(
      createdIn("channel", "m3", "现在这条是单独问我的", {
        isDirect: false,
        timestamp: timestamp + 2,
        user: { id: "u3", name: "丙" },
      }),
    );
    await waitForTurns(runtime, 1);

    expect(calls).toHaveLength(2);
    expect(calls[1].questions.relation).toMatchObject({ type: "choice" });
  });

  it("does not wake on a focus message deleted during classification", async () => {
    const pending = Promise.withResolvers<DecisionModelResult>();
    let requested = false;
    const engine = new JevWakeupInstance(
      {
        debounceMs: 0,
        maxWaitMs: 0,
        timeoutMs: 500,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      jevContext,
      jevModel(() => {
        requested = true;
        return pending.promise;
      }),
    );
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: engine });

    await runtime.deliver(createdIn("channel", "m1", "正在判定的消息", { isDirect: false, timestamp: Date.now() }));
    await until(async () => requested);
    await runtime.deliver(
      createCustomMessage("ishiki.message.deleted", {
        platform: "test",
        selfId: "bot",
        channelId: "channel",
        messageId: "m1",
      }),
    );
    await until(async () => !engine.history("channel").some((line) => line.id === "m1"));
    pending.resolve(jevEvidence());
    await sleep(50);

    expect(runtime.agent.isIdle()).toBe(true);
    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it("records successful send_message output as bot speech", async () => {
    const engine = new JevWakeupInstance(
      { rules: { direct: false, atSelf: false, quoteSelf: false, keywords: ["wake"] } },
      jevContext,
      jevModel(() => {
        throw new Error("rule wake must not call the decision model");
      }),
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "send_message", input: { i: "reply", messages: ["reply"] } }] : []),
      wakeup: engine,
      tools: sendMessageTool(true),
    });

    await runtime.deliver(createdIn("channel", "m1", "wake", { isDirect: false, timestamp: Date.now() }));
    await waitForTurns(runtime, 1);
    await until(async () => engine.history("channel").some((line) => line.self && line.text === "reply"));

    expect(engine.history("channel").find((line) => line.self)).toMatchObject({ text: "reply", self: true });
  });

  it("ignores failed send_message output", async () => {
    const engine = new JevWakeupInstance(
      { rules: { direct: false, atSelf: false, quoteSelf: false, keywords: ["wake"] } },
      jevContext,
      jevModel(() => {
        throw new Error("rule wake must not call the decision model");
      }),
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "send_message", input: { i: "reply", messages: ["reply"] } }] : []),
      wakeup: engine,
      tools: sendMessageTool(false),
    });

    await runtime.deliver(createdIn("channel", "m1", "wake", { isDirect: false, timestamp: Date.now() }));
    await waitForTurns(runtime, 1);
    await sleep(30);

    expect(engine.history("channel").filter((line) => line.self)).toEqual([]);
  });

  it("ignores a judgement that completes after the engine is detached", async () => {
    const pending = Promise.withResolvers<DecisionModelResult>();
    let requested = false;
    const engine = new JevWakeupInstance(
      {
        debounceMs: 0,
        maxWaitMs: 0,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      jevContext,
      jevModel(() => {
        requested = true;
        return pending.promise;
      }),
    );
    const disposers: Array<() => void> = [];
    const { runtime, bodies } = await makeRuntime({
      steps: () => [],
      wakeup: {
        attach(agent) {
          const dispose = engine.attach(agent);
          disposers.push(dispose);
          return dispose;
        },
      },
    });
    await runtime.deliver(createdIn("channel", "m1", "classify this input", { isDirect: false, timestamp: Date.now() }));
    await until(async () => requested);
    disposers[0]();
    pending.resolve(jevEvidence());
    await sleep(50);

    expect(runtime.agent.isIdle()).toBe(true);
    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});

describe("willingness wakeup engine", () => {
  const context = {
    domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
    logger,
  } as never;

  it("keeps state isolated by platform, account, and channel", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 0,
        atMention: 100,
        isQuote: 15,
        isDirectMessage: 40,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
      },
      context,
    );
    const { runtime } = await makeRuntime({ steps: () => [], wakeup: engine });
    const platformAddress: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "shared" };
    const accountAddress: WillingnessAddress = { platform: "other", selfId: "bot", channelId: "shared" };
    const selfAddress: WillingnessAddress = { platform: "test", selfId: "other", channelId: "shared" };

    await runtime.deliver(createdIn("shared", "platform", '<at id="bot"/>', { platform: "test", selfId: "bot", isDirect: false }));
    await runtime.deliver(createdIn("shared", "account", "plain", { platform: "other", selfId: "bot" }));
    await runtime.deliver(
      createdIn("shared", "self", "quoted", {
        platform: "test",
        selfId: "other",
        isDirect: false,
        quote: { id: "quoted", user: { id: "other" } },
      }),
    );

    await until(async () => engine.getCurrentWillingness(platformAddress) >= 99);
    await until(async () => engine.getCurrentWillingness(accountAddress) >= 39);
    await until(async () => engine.getCurrentWillingness(selfAddress) >= 14);
    expect(engine.getCurrentWillingness(platformAddress)).toBeGreaterThan(99);
    expect(engine.getCurrentWillingness(accountAddress)).toBeLessThan(41);
    expect(engine.getCurrentWillingness(selfAddress)).toBeLessThan(16);
  });

  it("adds image willingness only to the matching message", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 1,
        isDirectMessage: 0,
        imageGain: 60,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
      },
      context,
    );
    const { runtime } = await makeRuntime({ steps: () => [], wakeup: engine });
    const address: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "channel" };

    await runtime.deliver(createdIn("channel", "plain", "plain", { isDirect: false }));
    await until(async () => engine.getCurrentWillingness(address) >= 0.9);
    await runtime.deliver(createdIn("channel", "image", `<img src="data:image/png;base64,${PNG}"/>`, { isDirect: false }));

    await until(async () => engine.getCurrentWillingness(address) > 60);
    expect(engine.getCurrentWillingness(address)).toBeLessThan(62);
  });

  it("charges reply cost once after a successful send_message call", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 0,
        isDirectMessage: 20,
        replyCost: 7,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
        directForce: true,
        participationWindowSeconds: 0,
      },
      context,
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "send_message", input: { messages: ["reply"] } }] : []),
      wakeup: engine,
      tools: sendMessageTool(true),
    });
    const address: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "channel" };

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);
    await until(async () => engine.getCurrentWillingness(address) < 20);
    expect(engine.getCurrentWillingness(address)).toBeGreaterThan(12);
  });

  it("leaves willingness unchanged when send_message reports failure", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 0,
        isDirectMessage: 20,
        replyCost: 7,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
        directForce: true,
        participationWindowSeconds: 0,
      },
      context,
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "send_message", input: { messages: ["reply"] } }] : []),
      wakeup: engine,
      tools: sendMessageTool(false),
    });
    const address: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "channel" };

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);
    await sleep(20);
    expect(engine.getCurrentWillingness(address)).toBeGreaterThan(19);
  });

  it("does not apply the participation bonus to a quote of someone else", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 10,
        atMention: 0,
        isQuote: 0,
        isDirectMessage: 0,
        replyCost: 0,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
        directForce: true,
        participationInfluence: 1,
      },
      context,
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "send_message", input: { messages: ["reply"] } }] : []),
      wakeup: engine,
      tools: sendMessageTool(true),
    });
    const address: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "channel" };

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);
    const before = engine.getCurrentWillingness(address);
    await runtime.deliver(
      createdIn("channel", "quoted", "quoted", {
        isDirect: false,
        quote: { id: "quoted", user: { id: "other" } },
      }),
    );
    await until(async () => engine.getCurrentWillingness(address) > before + 5);
    expect(engine.getCurrentWillingness(address) - before).toBeLessThan(15);
  });

  it("charges codemode sends from a channel without a turn source", async () => {
    const engine = new WillingnessWakeupInstance(
      {
        base: 20,
        isDirectMessage: 0,
        replyCost: 7,
        probabilityThreshold: 100,
        probabilityAmplifier: 0,
        participationWindowSeconds: 0,
      },
      context,
    );
    const { runtime } = await makeRuntime({
      steps: (index) => (index === 0 ? [{ name: "codemode", input: { i: "发送消息", js: 'await tools.send_message({ messages: ["reply"] });' } }] : []),
      wakeup: engine,
      tools: sendMessageTool(true),
      codemode: true,
    });
    const address: WillingnessAddress = { platform: "test", selfId: "bot", channelId: "channel" };

    await runtime.deliver(createdIn("channel", "m1", "plain", { isDirect: false }));
    await until(async () => engine.getCurrentWillingness(address) >= 19);
    runtime.wake();
    await waitForTurns(runtime, 1);
    await until(async () => engine.getCurrentWillingness(address) < 14);
    expect(engine.getCurrentWillingness(address)).toBeLessThan(14);
  });

  it("exports the wakeup schema with the documented defaults", () => {
    expect(WillingnessWakeupConfig({})).toMatchObject({
      base: 12,
      isDirectMessage: 40,
      imageGain: 8,
      maxWillingness: 100,
      probabilityThreshold: 55,
      replyCost: 35,
      participationInfluence: 0.5,
    });
  });
});

describe("declared wake windows (end-to-end)", () => {
  it("wakes on the declared msgs window alone, with no signal", async () => {
    const { runtime } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { i: "等待两条", msgs: 2 } }] : []),
    });

    await runtime.deliver(created("m1"));
    await waitForTurns(runtime, 1);
    // 声明 msgs:2 —— 只来一条不够，不该开轮。
    await runtime.deliver(created("m2"));
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(1);

    // 第二条够数：条件触发，不需要信号。
    await runtime.deliver(created("m3"));
    await waitForTurns(runtime, 2);

    // 触发即清空：再来两条也不该继续开轮。
    await runtime.deliver(created("m4"));
    await runtime.deliver(created("m5"));
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(2);
  }, 15_000);

  it("answers a split sentence once, in the round the window opens", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      steps: (index) =>
        index === 0 ? [{ name: "wait", input: { i: "等待补全", msgs: 1 } }] : [{ name: "speak", input: { i: "回复", text: "both parts answered" } }],
    });

    await runtime.deliver(created("m1", "first part"));
    await waitForTurns(runtime, 1);
    // 首轮只有一步：wait 本身收尾，不再为空转多跑一次模型。
    expect(bodies).toHaveLength(1);
    expect(promptOf(bodies[0])).toContain("wait");

    await runtime.deliver(created("m2", "second part"));
    await waitForTurns(runtime, 2);

    // 窗口开的这一轮同时看到两段原文，合成一个模型步作答。
    expect(promptOf(bodies[1])).toContain("first part");
    expect(promptOf(bodies[1])).toContain("second part");
    const spoke = (await storedMessages(runtime)).some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call" && part.toolName === "speak"),
    );
    expect(spoke).toBe(true);
  }, 15_000);

  it("settles a message that joined mid-turn into the round the window opens", async () => {
    const release = Promise.withResolvers<void>();
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      gate: async (call) => {
        if (call === 0) await release.promise;
      },
      steps: (index) =>
        index === 0 ? [{ name: "wait", input: { i: "等待补全", msgs: 1 } }] : [{ name: "speak", input: { i: "回复", text: "follow-up sent" } }],
    });

    await runtime.deliver(created("m1", "opening line"));
    await until(async () => bodies.length >= 1);
    await runtime.deliver(created("m2", "arrived while responding"));
    release.resolve();
    await waitForTurns(runtime, 2);

    // 首轮开场时 m2 还没到：它 join 在轮内，随后被声明的窗口结算成下一轮。
    expect(promptOf(bodies[0])).not.toContain("arrived while responding");
    expect(promptOf(bodies[1])).toContain("opening line");
    expect(promptOf(bodies[1])).toContain("arrived while responding");
  }, 15_000);
});
