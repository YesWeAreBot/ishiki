import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, jsonSchema, tool, type Agent, type AgentMessage, type AgentPlugin, type CustomMessages, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFinish } from "../src/builtin-tools/finish.js";
import { collapse } from "../src/context/standard.engine.js";
import type { ExtensionInstance } from "../src/extension.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime } from "../src/runtime.js";
import type { IshikiMessageCreated } from "../src/types.js";
import { StandardWakeupInstance, type WakeupEngineInstance } from "../src/wakeup/index.js";
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
  toolsearch?: { enable: boolean; resident: string[]; maxResults: number };
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
    externalPlugins: options.externalPlugins,
    // 真实 standard 引擎的投影：created 折成 user 行，catalog 留给 toModelMessages。
    context: { renderMessages: (messages) => collapse(messages) },
    wakeup: options.wakeup ?? judgeWakeup(() => false),
    codemode: { enable: false, direct: [], timeoutMs: 1000 },
    toolsearch: options.toolsearch ?? { enable: false, resident: [], maxResults: 5 },
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
      toolsearch: { enable: true, resident: [], maxResults: 5 },
    });

    // init 落盘的 catalog、deliver 落盘的平台附件都是内部附加消息：既不该开轮，也必须照常存储。
    await runtime.deliver(created("m1", `<img src="data:image/png;base64,${PNG}"/>`));
    await until(async () => (await storedMessages(runtime)).some((message) => message.role === "custom" && message.type === "ishiki.attachment"));
    await sleep(50);
    expect(await terminalTurns(runtime)).toBe(0);
    const internal = await storedMessages(runtime);
    expect(internal.some((message) => message.role === "custom" && message.type === "ishiki.tools.catalog")).toBe(true);
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

  it("a declared secs window opens the next round on stored history", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { secs: 1 } }] : [{ name: "finish", input: {} }]),
    });

    await runtime.deliver(created("m1", "only an at-mention"));
    await waitForTurns(runtime, 1);
    // 没有任何新消息，纯靠 secs 截止开轮；机械 reason 只进 debug 日志，不进上下文。
    await waitForTurns(runtime, 2);

    expect(bodies).toHaveLength(2);
    expect(promptOf(bodies[1])).toContain("only an at-mention");
    expect(promptOf(bodies[1])).not.toContain("timer 1s expired");
  }, 15_000);

  it("treats wait({msgs: 0}) as no declaration: later input opens no round", async () => {
    const { runtime, bodies } = await makeRuntime({
      wakeup: judgeWakeup(() => false),
      steps: () => [{ name: "wait", input: { msgs: 0 } }],
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
        { name: "wait", input: { msgs: 1 } },
        { name: "speak", input: { text: "said and scheduled" } },
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
  it("keeps the full prior window without repeating the pending message", async () => {
    const pending = Promise.withResolvers<Response>();
    const judgements: Array<{ state: { recent_messages: Array<{ text: string }>; pending_message: { text: string } } }> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      judgements.push(request);
      if (request.state.pending_message.text === "pending") return pending.promise;
      return new Response(JSON.stringify({ answers: { addressed: { noul: 0 }, interested: { noul: 0 }, others: { noul: 1 } } }));
    });
    const engine = new JevWakeupInstance(
      { apiKey: "test-only", historyMessages: 2, threshold: 0.5, rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
      { logger } as never,
    );
    const { runtime, bodies } = await makeRuntime({ steps: () => [], wakeup: engine });
    for (const text of ["history-1", "history-2", "history-3"]) {
      await runtime.deliver(created(text, text));
      await until(async () => engine.history("channel").some((line) => line.text === text));
    }
    await runtime.deliver(created("pending", "pending"));
    await until(async () => judgements.length === 4);

    // The classifier may still be waiting while the current input is already committed.
    expect(createdIds(await storedMessages(runtime))).toEqual(["history-1", "history-2", "history-3", "pending"]);
    expect(bodies).toHaveLength(0);
    expect(judgements[3].state.recent_messages.map((line) => line.text)).toEqual(["history-2", "history-3"]);
    expect(judgements[3].state.pending_message.text).toBe("pending");

    pending.resolve(new Response(JSON.stringify({ answers: { addressed: { noul: 1 }, interested: { noul: 1 }, others: { noul: 0 } } })));
    await waitForTurns(runtime, 1);
    expect(promptOf(bodies[0])).toContain("pending");
    expect((await storedMessages(runtime)).filter((message) => message.role === "user")).toEqual([]);
  });

  it("ignores a judgement that completes after the engine is detached", async () => {
    const pending = Promise.withResolvers<Response>();
    let requested = false;
    vi.stubGlobal("fetch", async () => {
      requested = true;
      return pending.promise;
    });
    const engine = new JevWakeupInstance({ apiKey: "test-only", rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } }, { logger } as never);
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
    await runtime.deliver(created("m1", "classify this input"));
    await until(async () => requested);
    disposers[0]();
    pending.resolve(new Response(JSON.stringify({ answers: { addressed: { noul: 1 }, interested: { noul: 1 }, others: { noul: 0 } } })));
    await sleep(50);

    expect(runtime.agent.isIdle()).toBe(true);
    expect(await terminalTurns(runtime)).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});

describe("declared wake windows (end-to-end)", () => {
  it("wakes on the declared msgs window alone, with no signal", async () => {
    const { runtime } = await makeRuntime({
      wakeup: judgeWakeup((message) => message.messageId === "m1"),
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 2 } }] : []),
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
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 1 } }] : [{ name: "speak", input: { text: "both parts answered" } }]),
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
      steps: (index) => (index === 0 ? [{ name: "wait", input: { msgs: 1 } }] : [{ name: "speak", input: { text: "follow-up sent" } }]),
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
