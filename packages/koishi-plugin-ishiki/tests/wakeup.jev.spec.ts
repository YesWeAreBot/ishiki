import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MockLanguageModelV4,
  createAssistantMessage,
  createCustomMessage,
  createEntry,
  simulateReadableStream,
  type Agent,
  type AgentEntry,
  type AgentEvent,
  type AgentMessage,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Context, Logger } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandardContextEngine } from "../src/context/standard.engine.js";
import { SceneRuntime } from "../src/runtime.js";
import { createSendMessage } from "../src/tools/send-message.js";
import type { IshikiMessageCreated } from "../src/types.js";
import { createWakeupEngine } from "../src/wakeup/index.js";
import { JevWakeupEngine, type JevWakeupConfig } from "../src/wakeup/jev.engine.js";

const logs: string[] = [];
const warnings: string[] = [];
const logger = {
  debug: (line: string) => logs.push(`debug ${line}`),
  warn: (line: string) => {
    warnings.push(line);
    logs.push(`warn ${line}`);
  },
  error: (line: string) => {
    warnings.push(line);
    logs.push(`error ${line}`);
  },
} as unknown as Logger;
const USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

type JevParams = Partial<JevWakeupConfig>;

/** 一条频道消息；默认是最普通的那一种（无 @、无引用、非私聊）。 */
function message(overrides: Partial<IshikiMessageCreated> = {}) {
  const timestamp = overrides.timestamp ?? Date.now();
  return createCustomMessage(
    "ishiki.message.created",
    {
      timestamp,
      platform: "onebot",
      selfId: "bot",
      channelId: "room",
      messageId: "m1",
      content: "在吗",
      isDirect: false,
      user: { id: "u1", name: "Neko" },
      ...overrides,
    } satisfies IshikiMessageCreated,
    { timestamp },
  );
}

/** 自己说过的一句话，形态与 agent 落盘时一致：assistant 消息里带一个 send_message 调用。 */
function said(texts: string[], at = Date.now()) {
  return createAssistantMessage([{ type: "tool-call", toolCallId: "call-1", toolName: "send_message", input: { messages: texts } }], {
    timestamp: at,
  });
}

/** 只实现引擎用到的那部分的 agent：可订阅事实流、可读存储。 */
function stubAgent(stored: readonly AgentEntry[] = []) {
  let listener: ((event: AgentEvent) => unknown) | undefined;
  const agent = {
    channel: {
      subscribe: (_channel: string, callback: (event: AgentEvent) => unknown) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    storage: { read: async () => stored },
  } as unknown as Agent;

  return {
    agent,
    /** 按 agent 的方式把一条消息落进事实流。 */
    appended: async (entry: AgentMessage) => {
      await listener?.({ type: "message.appended", message: entry });
    },
    isDetached: () => listener === undefined,
  };
}

/** 一个挂到打桩 agent 上的引擎。 */
function attached(config: JevParams = {}, stored: readonly AgentEntry[] = []) {
  const stub = stubAgent(stored);
  const engine = new JevWakeupEngine({ apiKey: "k", ...config }, { logger });
  engine.attach(stub.agent, "room");
  return { engine, ...stub };
}

/** 端点的一次成功作答。 */
function noul(chance: number) {
  return { ok: true, json: async () => ({ answers: { should_reply: { type: "noul", noul: chance } } }) };
}

/** 一段工具调用的流式分块，形状与 SDK 的 mock model 期望一致。 */
function toolStep(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

/** 一段纯文本的收尾分块。 */
function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

/** 打一次桩：记下每个请求体，按给定顺序给概率（用尽后一直用最后一个）。 */
function stubEndpoint(chances: number[]) {
  const bodies: Array<Record<string, any>> = [];
  let index = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    const chance = chances[Math.min(index, chances.length - 1)];
    index += 1;
    return noul(chance);
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  logs.length = 0;
  warnings.length = 0;
});

describe("jev wakeup: 兜底规则", () => {
  it("命中就直接唤醒，一次请求都不发", async () => {
    const bodies = stubEndpoint([0.1]);
    const { engine } = attached();

    expect(await engine.decide(message({ content: '<at id="bot"/>在吗' }))).toBe("trigger");
    expect(await engine.decide(message({ isDirect: true }))).toBe("trigger");
    expect(bodies).toHaveLength(0);
  });

  it("默认不兜引用于关键词，它们落到模型判定上", async () => {
    const bodies = stubEndpoint([0.1, 0.1]);
    const { engine } = attached();

    // 引用与关键词都只走模型：这一次模型说不回，就不回。
    expect(await engine.decide(message({ quote: { id: "m0", user: { id: "bot" }, content: "上一条" } }))).toBe("wait");
    expect(await engine.decide(message({ content: "neko 看一下" }))).toBe("wait");
    expect(bodies).toHaveLength(2);
  });

  it("规则可以按项开关；只写几项时缺的按本引擎的默认补", async () => {
    const bodies = stubEndpoint([0.9]);
    const { engine } = attached({ rules: { keywords: ["帮忙"] } });

    // 没写 quoteSelf，就按 jev 的默认（关）走模型，而不是回到 standard 的全开。
    expect(engine.config.rules).toEqual({ direct: true, atSelf: true, quoteSelf: false, keywords: ["帮忙"] });
    expect(await engine.decide(message({ content: "帮忙看一下" }))).toBe("trigger");
    expect(bodies).toHaveLength(0);

    const none = attached({ rules: { direct: false, atSelf: false } });
    // 规则全关：这条被 @ 的私聊也走模型，模型说回就回。
    expect(await none.engine.decide(message({ content: '<at id="bot"/>在吗', isDirect: true }))).toBe("trigger");
    expect(bodies).toHaveLength(1);
  });
});

describe("jev wakeup: 窗口", () => {
  it("别人的话与自己说过的话都进窗口，助手正文不算", async () => {
    const { engine, appended } = attached({ historyMessages: 4 });

    await appended(message({ content: "今天好热", user: { id: "u1", name: "小明" } }));
    await appended(message({ content: "是啊", user: { id: "u2", name: "小红" } }));
    await appended(said(["要喝点什么吗"]));
    await appended(createAssistantMessage("（内心话，没发出去）"));
    await appended(createCustomMessage("ishiki.inner_stimulus", { reason: "r", content: "纸条" } as never));

    expect(engine.historyOf("room").map((line) => `${line.author}:${line.text}`)).toEqual(["小明:今天好热", "小红:是啊", "self:要喝点什么吗"]);
  });

  it("窗口只留最近几条", async () => {
    const { engine, appended } = attached({ historyMessages: 2 });

    for (const text of ["一", "二", "三"]) await appended(message({ content: text }));

    expect(engine.historyOf("room").map((line) => line.text)).toEqual(["二", "三"]);
  });

  it("挂载时把存储里的历史读进来，与新鲜事件按时间合起来", async () => {
    const bodies = stubEndpoint([0.9]);
    const now = Date.now();
    const stored = [
      createEntry("message", message({ content: "下午的会定了吗", timestamp: now - 300_000 }), { timestamp: now - 300_000 }),
      createEntry("message", said(["定了，三号会议室"], now - 240_000), { timestamp: now - 240_000 }),
    ];
    const { engine, appended } = attached({ historyMessages: 4, cooldownMs: 600_000 }, stored);

    await appended(message({ content: "那我去准备", timestamp: now - 60_000 }));

    // `decide` 会等历史装载落地，所以这里顺带断定它已经装好。
    expect(await engine.decide(message({ content: "三点见" }))).toBe("wait");
    expect(bodies).toHaveLength(0); // 装载进来的最后一句是自己的，冷却因此仍然有效
    expect(engine.historyOf("room").map((line) => line.text)).toEqual(["下午的会定了吗", "定了，三号会议室", "那我去准备"]);
  });

  it("detach 之后不再记账", async () => {
    const { engine, appended, isDetached } = attached();

    engine.detach("room");
    expect(isDetached()).toBe(true);
    await appended(message({ content: "还在吗" }));
    expect(engine.historyOf("room")).toEqual([]);
  });

  it("非消息事件不判定也不进窗口", async () => {
    const bodies = stubEndpoint([0.9]);
    const { engine } = attached();

    const stimulus = createCustomMessage("ishiki.inner_stimulus", {
      timestamp: Date.now(),
      platform: "onebot",
      selfId: "bot",
      channelId: "room",
      reason: "r",
      content: "c",
    });

    expect(await engine.decide(stimulus)).toBe("wait");
    expect(bodies).toHaveLength(0);
    expect(engine.historyOf("room")).toEqual([]);
  });

  it("存储读不动也照常判：窗口空着，但不从此不醒", async () => {
    const bodies = stubEndpoint([0.9]);
    const broken = {
      channel: { subscribe: () => () => undefined },
      storage: {
        read: async () => {
          throw new Error("events.jsonl is not readable");
        },
      },
    } as unknown as Agent;
    const engine = new JevWakeupEngine({ apiKey: "k" }, { logger });
    engine.attach(broken, "room");

    expect(await engine.decide(message())).toBe("trigger");
    expect(bodies).toHaveLength(1);
    expect(logs.some((line) => line.includes("history unavailable"))).toBe(true);
  });
});

describe("jev wakeup: 模型判定", () => {
  it("概率过阈值才开口，请求体带着窗口与问句", async () => {
    const bodies = stubEndpoint([0.9]);
    // 这条用例只看请求体：关掉冷却，免得「自己刚说过话」把它挡在模型之外。
    const { engine, appended } = attached({
      threshold: 0.5,
      historyMessages: 2,
      cooldownMs: 0,
      instruction: "猫娘 neko，只接和说话人有关的话",
    });

    await appended(message({ content: "今天好热", user: { id: "u1", name: "小明" } }));
    await appended(said(["热就开空调"]));

    expect(await engine.decide(message({ content: "你不觉得吗", user: { id: "u1", name: "小明" } }))).toBe("trigger");
    expect(bodies).toHaveLength(1);
    // 判定不改窗口：本条要等投递之后才由 agent 追加进来。
    expect(engine.historyOf("room").map((line) => line.text)).toEqual(["今天好热", "热就开空调"]);

    const body = bodies[0];
    expect(body.model).toBe("jev-latest");
    expect(body.state.scene).toMatchObject({ type: "group" });
    expect(body.state.scene.seconds_since_bot_last_spoke).toBeGreaterThanOrEqual(0);
    // 请求里的窗口是本条之前的：本条只在 pending_message 里。
    expect(body.state.recent_messages).toEqual([
      { author: "小明", text: "今天好热" },
      { author: "self", text: "热就开空调" },
    ]);
    expect(body.state.pending_message).toMatchObject({ text: "你不觉得吗", mentions_bot: false, replies_to_bot: false });
    expect(body.questions.should_reply.type).toBe("noul");
    // 判据进 instructions（与问句并列，由问句点名引用），不进 state。
    expect(body.questions.should_reply.instructions).toEqual({
      instruction: "猫娘 neko，只接和说话人有关的话",
      question: expect.stringContaining("`instruction`"),
    });
    expect(body.questions.should_reply.criteria.true.length).toBeGreaterThan(0);
  });

  it("没写 instruction 时问句仍是自包含的一档判据，并点明 self 是谁", async () => {
    const bodies = stubEndpoint([0.9]);
    const { engine } = attached();
    await engine.decide(message());

    expect(typeof bodies[0].questions.should_reply.instructions).toBe("string");
    expect(bodies[0].questions.should_reply.instructions).toContain('"self"');
    expect(bodies[0].questions.should_reply.instructions).toContain("group chat");
  });

  it("判据按场景分档：私聊默认该回，群聊默认别插话；instruction 只做补充", async () => {
    const bodies = stubEndpoint([0.9, 0.9, 0.9]);
    // 关掉规则，否则私聊这类消息根本到不了模型。
    const { engine } = attached({ rules: { direct: false, atSelf: false }, instruction: "话不多，别用颜文字" });

    await engine.decide(message({ isDirect: true }));
    await engine.decide(message({ isDirect: false }));

    const [direct, group] = bodies;
    expect(direct.state.scene.type).toBe("direct");
    expect(direct.questions.should_reply.criteria.true).toContain("direct chat");
    expect(direct.questions.should_reply.criteria.true).toContain("normal thing to do");
    expect(group.state.scene.type).toBe("group");
    expect(group.questions.should_reply.criteria.true).toContain("mentions, quotes or names this bot");

    // 两档都在 criteria 之上加 instruction，而不是让 instruction 顶替它们。
    for (const body of [direct, group]) {
      expect(body.questions.should_reply.instructions.instruction).toBe("话不多，别用颜文字");
      expect(body.questions.should_reply.instructions.question).toContain("`criteria` describe");
      expect(body.questions.should_reply.instructions.question).toContain("without replacing them");
    }
    expect(bodies).toHaveLength(2);
  });

  it("概率不到阈值就不开口", async () => {
    stubEndpoint([0.49]);
    const { engine } = attached({ threshold: 0.5 });
    expect(await engine.decide(message())).toBe("wait");
  });

  it("自己刚说过话，冷却期内连请求都不发", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const bodies = stubEndpoint([0.9]);
    const { engine, appended } = attached({ cooldownMs: 60_000 });

    expect(await engine.decide(message({ content: "第一条" }))).toBe("trigger");
    await appended(said(["回过了"]));

    // 冷却期内：模型路径没有发言权，兜底规则不受影响。
    expect(await engine.decide(message({ content: "第二条" }))).toBe("wait");
    expect(bodies).toHaveLength(1);
    expect(await engine.decide(message({ content: '<at id="bot"/>第三条' }))).toBe("trigger");
    expect(bodies).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    expect(await engine.decide(message({ content: "第四条" }))).toBe("trigger");
    expect(bodies).toHaveLength(2);
  });

  it("判定失败一律等下一轮：不抛，记日志", async () => {
    const { engine } = attached();

    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ETIMEDOUT");
    });
    expect(await engine.decide(message())).toBe("wait");

    vi.stubGlobal("fetch", async () => ({ ok: false, status: 429, statusText: "Too Many Requests" }));
    expect(await engine.decide(message())).toBe("wait");

    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ answers: {} }) }));
    expect(await engine.decide(message())).toBe("wait");

    expect(warnings.filter((line) => line.includes("wakeup jev"))).toHaveLength(3);
  });
});

describe("jev wakeup: 决策日志", () => {
  it("每条路径都留一行：规则、模型、冷却、不可用", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const bodies = stubEndpoint([0.9, 0.1]);
    const { engine, appended } = attached({ cooldownMs: 60_000 });

    expect(await engine.decide(message({ content: '<at id="bot"/>在吗' }))).toBe("trigger");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] trigger rule elapsed=\d+ms$/);

    expect(await engine.decide(message({ content: "嗯" }))).toBe("trigger");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] trigger model chance=0\.90 threshold=0\.5 window=0 elapsed=\d+ms$/);

    await appended(said(["回过了"]));
    expect(await engine.decide(message({ content: "第二条" }))).toBe("wait");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] wait cooldown since=0s elapsed=\d+ms$/);

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(await engine.decide(message({ content: "第三条" }))).toBe("wait");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] wait model chance=0\.10 threshold=0\.5 window=1 elapsed=\d+ms$/);

    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    vi.setSystemTime(new Date("2026-01-01T00:03:00Z"));
    expect(await engine.decide(message({ content: "第四条" }))).toBe("wait");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] wait model unavailable elapsed=\d+ms$/);
    expect(bodies).toHaveLength(2);
  });

  it("挂载、历史装载与卸载也各留一行", async () => {
    stubEndpoint([0.1]);
    const now = Date.now();
    const stored = [createEntry("message", message({ content: "下午的会定了吗", timestamp: now - 1_000 }), { timestamp: now - 1_000 })];
    const stub = stubAgent(stored);
    const engine = new JevWakeupEngine({ apiKey: "k" }, { logger });

    engine.attach(stub.agent, "room");
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[room\] attached$/));

    await engine.decide(message());
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[room\] history 1 line\(s\) folded in$/));
    expect(engine.historyOf("room").map((line) => line.text)).toEqual(["下午的会定了吗"]);

    engine.detach("room");
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[room\] detached$/));
  });
});

describe("jev wakeup: 配置", () => {
  it("按名从注册表建出引擎", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "from-env");
    const engine = createWakeupEngine({ engine: "jev", jev: { threshold: 0.8 } });

    expect(engine).toBeInstanceOf(JevWakeupEngine);
    expect(engine.name).toBe("jev");
    expect((engine as JevWakeupEngine).config.apiKey).toBe("from-env");
    expect((engine as JevWakeupEngine).config.threshold).toBe(0.8);
  });

  it("缺 apiKey 时装配即抛错，不静默退化", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(() => new JevWakeupEngine({})).toThrow(/apiKey/);
  });

  it("越界的数值回落到默认值", () => {
    const engine = new JevWakeupEngine({ apiKey: "k", threshold: 2, cooldownMs: -1, timeoutMs: 1, historyMessages: 0 });
    expect(engine.config.threshold).toBe(1);
    expect(engine.config.cooldownMs).toBe(30_000);
    expect(engine.config.timeoutMs).toBe(1_500);
    expect(engine.config.historyMessages).toBe(8);
  });
});

describe("jev wakeup: 接进场景", () => {
  it("模型说该开口就真的唤起一轮；它自己发出去的话回到窗口，并顶起冷却", async () => {
    const bodies = stubEndpoint([0.9]);
    const sent: Array<{ channelId: string; content: string }> = [];
    const ctx = {
      bots: {
        "onebot:1": {
          platform: "onebot",
          selfId: "1",
          sendMessage: async (channelId: string, content: string) => {
            sent.push({ channelId, content });
            return [`id-${sent.length}`];
          },
        },
      },
    } as unknown as Context;

    // 第一步说话，第二步收尾；模型正文里的那点文字不构成「说过的话」。
    const steps: LanguageModelV4StreamPart[][] = [toolStep("send_message", { messages: ["在的"] }), textStep("嗯")];
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: steps.shift() ?? textStep("嗯") }) }),
    });

    const wakeup = new JevWakeupEngine({ apiKey: "k" }, { logger });
    const directory = mkdtempSync(path.join(tmpdir(), "ishiki-wakeup-jev-"));

    try {
      const scene = new SceneRuntime({
        label: "test/scene/room",
        sid: "onebot:1",
        channelId: "room",
        address: { platform: "onebot", selfId: "1" },
        directory,
        model,
        instructions: "",
        // 自定义消息要有人投影成模型消息，否则一轮的 prompt 是空的。
        plugins: [new StandardContextEngine({ logger }, { maxChars: 10_000 })],
        tools: {
          send_message: createSendMessage({
            ctx,
            logger,
            sid: "onebot:1",
            channelId: "room",
            typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
            onEndTurn: () => undefined,
          }),
        },
        wakeup,
        logger,
      });

      await scene.deliver(message({ content: "在吗" }));
      await scene.idle();

      // 一轮真的被唤起了：话到了平台，也落进了场景自己的记忆。
      expect(sent).toEqual([{ channelId: "room", content: "在的" }]);
      expect(warnings).toEqual([]);
      // 这个频道的第一条消息：判定时窗口还是空的，本条只在 pending_message 里。
      expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[room\] trigger model chance=[\d.]+ threshold=0\.5 window=0 elapsed=\d+ms$/));

      // 引擎从 agent 的事实流里认出了这句话是自己的，冷却随之生效。
      expect(wakeup.historyOf("room").map((line) => `${line.author}:${line.text}`)).toEqual(["Neko:在吗", "self:在的"]);
      const before = bodies.length;
      expect(await wakeup.decide(message({ content: "再说一句" }))).toBe("wait");
      expect(bodies).toHaveLength(before);

      await scene.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
