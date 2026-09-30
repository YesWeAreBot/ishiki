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
import { Context, type Logger } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandardContextInstance } from "../src/context/standard.engine.js";
import { AgentRuntime } from "../src/runtime.js";
import { createSendMessage } from "../src/tools/send-message.js";
import type { IshikiMessageCreated, IshikiMessageDeleted } from "../src/types.js";
import { JevWakeupEngine, JevWakeupInstance, type JevWakeupConfig } from "../src/wakeup/jev.engine.js";

/** provider 只需要一个 Koishi Context，不需要 start；只有 `ctx.get(服务名)` 才要求 start。 */
const app = new Context();

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

/**
 * 「明确该开口」的一组答案：合成 sqrt(0.9 × 0.9) = 0.9。
 * 单值写法三维同值会被 `others` 压掉一半，只适合断言「不该开口」。
 */
const SPEAKS = { addressed: 0.9, interested: 0.9, others: 0.1 } as const;

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

/** 一条撤回事件：不是普通消息，因此不走唤醒判定也不进判定窗口。 */
function deleted(messageId: string, at = Date.now()) {
  return createCustomMessage(
    "ishiki.message.deleted",
    { timestamp: at, platform: "onebot", selfId: "bot", channelId: "room", messageId } satisfies IshikiMessageDeleted,
    { timestamp: at },
  );
}

/** 只实现引擎用到的那部分的 agent：可订阅事实流、可读存储。 */
function stubAgent(stored: readonly AgentEntry[] = []) {
  let listener: ((event: AgentEvent) => unknown) | undefined;
  const agent = {
    id: "stub",
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
  const engine = new JevWakeupInstance({ apiKey: "k", ...config }, { logger });
  const dispose = engine.attach(stub.agent);
  return { engine, dispose, ...stub };
}

/**
 * 端点的一次成功作答：三个问句各一个 noul。
 *
 * 单值是三维取同一个值——大部分用例只关心「三个都给多少」，不关心是哪一维。
 * 要单独看某一维就传对象。
 */
function noul(chance: number | { addressed?: number; interested?: number; others?: number }) {
  const answers =
    typeof chance === "number" ? { addressed: chance, interested: chance, others: chance } : { addressed: 0.5, interested: 0.5, others: 0.5, ...chance };
  return {
    ok: true,
    json: async () => ({ answers: Object.fromEntries(Object.entries(answers).map(([name, value]) => [name, { type: "noul", noul: value }])) }),
  };
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

/** 打一次桩：记下每个请求体，按给定顺序给答案（用尽后一直用最后一个）。 */
function stubEndpoint(chances: Array<number | { addressed?: number; interested?: number; others?: number }>) {
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
    const bodies = stubEndpoint([SPEAKS]);
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
    await appended(deleted("m-1"));

    expect(engine.history("room").map((line) => `${line.author}:${line.text}`)).toEqual(["小明:今天好热", "小红:是啊", "self:要喝点什么吗"]);
  });

  it("窗口只留最近几条", async () => {
    const { engine, appended } = attached({ historyMessages: 2 });

    for (const text of ["一", "二", "三"]) await appended(message({ content: text }));

    expect(engine.history("room").map((line) => line.text)).toEqual(["二", "三"]);
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
    expect(engine.history("room").map((line) => line.text)).toEqual(["下午的会定了吗", "定了，三号会议室", "那我去准备"]);
  });

  it("拆卸之后不再记账", async () => {
    const { engine, appended, isDetached, dispose } = attached();

    dispose();
    expect(isDetached()).toBe(true);
    await appended(message({ content: "还在吗" }));
    expect(engine.history("room")).toEqual([]);
  });

  it("非消息事件不判定也不进窗口", async () => {
    const bodies = stubEndpoint([0.9]);
    const { engine } = attached();

    expect(await engine.decide(deleted("m-1"))).toBe("wait");
    expect(bodies).toHaveLength(0);
    expect(engine.history("room")).toEqual([]);
  });

  it("存储读不动也照常判：窗口空着，但不从此不醒", async () => {
    const bodies = stubEndpoint([SPEAKS]);
    const broken = {
      channel: { subscribe: () => () => undefined },
      storage: {
        read: async () => {
          throw new Error("events.jsonl is not readable");
        },
      },
      id: "broken",
    } as unknown as Agent;
    const engine = new JevWakeupInstance({ apiKey: "k" }, { logger });
    engine.attach(broken);

    expect(await engine.decide(message())).toBe("trigger");
    expect(bodies).toHaveLength(1);
    expect(logs.some((line) => line.includes("history unavailable"))).toBe(true);
  });
});

describe("jev wakeup: 模型判定", () => {
  it("合成量过阈值才开口，请求体带着窗口与问句", async () => {
    const bodies = stubEndpoint([SPEAKS]);
    // 这条用例只看请求体：关掉冷却，免得「自己刚说过话」把它挡在模型之外。
    const { engine, appended } = attached({
      threshold: 0.5,
      historyMessages: 2,
      cooldownMs: 0,
      instruction: "猫娘 neko，只接和说话人有关的话",
      interests: ["猫娘 neko", " 群聊插话  "],
    });

    await appended(message({ content: "今天好热", user: { id: "u1", name: "小明" } }));
    await appended(said(["热就开空调"]));

    expect(await engine.decide(message({ content: "你不觉得吗", user: { id: "u1", name: "小明" } }))).toBe("trigger");
    expect(bodies).toHaveLength(1);
    // 判定不改窗口：本条要等投递之后才由 agent 追加进来。
    expect(engine.history("room").map((line) => line.text)).toEqual(["今天好热", "热就开空调"]);

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
    // 身份进 state：interested 那一维靠它指认「本 bot」，因此兴趣是 state 的一部分而不是问句的一部分。
    expect(body.state.bot.id).toBe("bot");
    expect(body.state.bot.interests).toEqual(["猫娘 neko", "群聊插话"]);
    expect(Object.keys(body.questions)).toEqual(["addressed", "interested", "others"]);
    for (const name of ["addressed", "interested", "others"]) {
      expect(body.questions[name].type).toBe("noul");
      // 判据进 instructions（与问句并列，由问句点名引用），不进 state。
      expect(body.questions[name].instructions).toEqual({
        instruction: "猫娘 neko，只接和说话人有关的话",
        question: expect.stringContaining("`instruction`"),
      });
      expect(body.questions[name].criteria.true.length).toBeGreaterThan(0);
    }
  });

  it("interests 进 state 且逐条去空白；没写就是空列表，不偏袒任何话题", async () => {
    const bodies = stubEndpoint([0.9, 0.9]);
    const withInterests = attached({ interests: ["猫娘 neko", " 群聊插话  ", "   "] });
    await withInterests.engine.decide(message());
    const plain = attached();
    await plain.engine.decide(message());

    expect(bodies[0].state.bot.interests).toEqual(["猫娘 neko", "群聊插话"]);
    expect(bodies[1].state.bot.interests).toEqual([]);
  });

  it("没写 instruction 时问句仍是自包含的一档判据，并点明 self 是谁", async () => {
    const bodies = stubEndpoint([SPEAKS]);
    const { engine } = attached();
    await engine.decide(message());

    expect(typeof bodies[0].questions.addressed.instructions).toBe("string");
    expect(bodies[0].questions.addressed.instructions).toContain('"self"');
    expect(bodies[0].questions.addressed.instructions).toContain("`state.bot`");
  });

  it("三个问句各管一维，判据互不代替；instruction 只做补充", async () => {
    const bodies = stubEndpoint([0.9, 0.9]);
    // 关掉规则，否则私聊这类消息根本到不了模型。
    const { engine } = attached({ rules: { direct: false, atSelf: false }, instruction: "话不多，别用颜文字" });

    await engine.decide(message({ isDirect: true }));
    await engine.decide(message({ isDirect: false }));

    const [direct, group] = bodies;
    expect(direct.state.scene.type).toBe("direct");
    // 私聊只体现在场景提示上，三条判据本身不分档：同一个 bot 在哪都按同一把尺子量。
    expect(direct.state.bot.scene_hint).toContain("private chat");
    expect(group.state.scene.type).toBe("group");
    expect(group.state.bot.scene_hint).toContain("group chat");

    // addressed 问「谁在说话」，interested 问「有没有话说」，others 问「是不是别人的对话」——三者措辞不同。
    expect(direct.questions.addressed.instructions.question).toContain("addressing this bot");
    expect(direct.questions.interested.instructions.question).toContain("worth saying");
    expect(direct.questions.others.instructions.question).toContain("between other participants");
    // 每个问句只管自己那一维，明确告诉模型别去答别的。
    for (const name of ["addressed", "interested", "others"]) {
      expect(direct.questions[name].instructions.question).toContain("the others are asked separately");
    }

    // 三个问句都在 criteria 之上加 instruction，而不是让 instruction 顶替它们。
    for (const body of [direct, group]) {
      for (const name of ["addressed", "interested", "others"]) {
        expect(body.questions[name].instructions.instruction).toBe("话不多，别用颜文字");
        expect(body.questions[name].instructions.question).toContain("`criteria` describe");
        expect(body.questions[name].instructions.question).toContain("without replacing them");
      }
    }
    expect(bodies).toHaveLength(2);
  });

  it("合成量不到阈值就不开口", async () => {
    stubEndpoint([0.49]);
    const { engine } = attached({ threshold: 0.5 });
    expect(await engine.decide(message())).toBe("wait");
  });

  it("没人在找它但它有话想说，照样开口：interested 单独撑着入场", async () => {
    stubEndpoint([{ addressed: 0.1, interested: 0.9, others: 0.1 }]);
    const { engine } = attached();
    // 这正是单问句治不了的漏判：0.9 的兴趣在「该不该说话」这一个数里读不出来。
    expect(await engine.decide(message())).toBe("trigger");
  });

  it("明显是别人之间的对话就不插话：others 压过 interested", async () => {
    stubEndpoint([{ addressed: 0.1, interested: 0.9, others: 0.95 }]);
    const { engine } = attached();
    expect(await engine.decide(message())).toBe("wait");
  });

  it("中性区连续：三个问句都给 0.5 时合成恰好 0.5，稍有证据就往上走", async () => {
    const { engine } = attached({ threshold: 0.5 });
    stubEndpoint([0.5]);
    expect(await engine.decide(message())).toBe("trigger");

    // 触发与不触发必须由证据决定，而不是由「恰好压在门槛上」决定：同一组答案换一个阈值就不该过。
    const { engine: stricter } = attached({ threshold: 0.51 });
    stubEndpoint([0.5]);
    expect(await stricter.decide(message())).toBe("wait");
  });

  it("缺任何一个问句的答案就整次作废，不拿缺省值补", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ answers: { addressed: { noul: 0.9 }, interested: { noul: 0.9 } } }) }));
    const { engine } = attached();
    // 缺一维等于回到「只有一个数」，那正是拆成三个问句要治的病。
    expect(await engine.decide(message())).toBe("wait");
    expect(warnings.some((line) => line.includes('"others" is not a number'))).toBe(true);
  });

  it("自己刚说过话，冷却期内连请求都不发", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const bodies = stubEndpoint([SPEAKS]);
    const { engine, appended } = attached({ cooldownMs: 60_000 });

    // agent 落盘的顺序：触发它的那条先落，模型的话随后；引擎据此知道这两句算进哪本账。
    await appended(message({ content: "第一条" }));
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
    // 第二条要 wait：三维同值的 0.1 合成 sqrt(0.1 × 0.9) = 0.3，正好在阈值之下。
    const bodies = stubEndpoint([SPEAKS, 0.1]);
    const { engine, appended } = attached({ cooldownMs: 60_000 });

    expect(await engine.decide(message({ content: '<at id="bot"/>在吗' }))).toBe("trigger");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] trigger rule elapsed=\d+ms$/);

    expect(await engine.decide(message({ content: "嗯" }))).toBe("trigger");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] trigger model chance=0\.90 threshold=0\.5 window=0 elapsed=\d+ms$/);

    // 决定开口之后这一轮才发生：触发它的那条与模型的话按顺序落进事实流。
    await appended(message({ content: "嗯" }));
    await appended(said(["回过了"]));
    expect(await engine.decide(message({ content: "第二条" }))).toBe("wait");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] wait cooldown since=0s elapsed=\d+ms$/);

    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(await engine.decide(message({ content: "第三条" }))).toBe("wait");
    expect(logs.at(-1)).toMatch(/^debug wakeup jev \[room\] wait model chance=0\.30 threshold=0\.5 window=\d+ elapsed=\d+ms$/);

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
    const engine = new JevWakeupInstance({ apiKey: "k" }, { logger });

    const dispose = engine.attach(stub.agent);
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[stub\] attached$/));

    await engine.decide(message());
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[room\] history 1 line\(s\) folded in$/));
    expect(engine.history("room").map((line) => line.text)).toEqual(["下午的会定了吗"]);

    dispose();
    expect(logs).toContainEqual(expect.stringMatching(/^debug wakeup jev \[stub\] detached$/));
  });
});

describe("jev wakeup: 配置", () => {
  it("provider 按 profile 配置造出运行体", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "from-env");
    const engine = new JevWakeupEngine(app).create({ threshold: 0.8 }, {});

    expect(engine).toBeInstanceOf(JevWakeupInstance);
    expect((engine as JevWakeupInstance).config.apiKey).toBe("from-env");
    expect((engine as JevWakeupInstance).config.threshold).toBe(0.8);
  });

  it("缺 apiKey 时装配即抛错，不静默退化", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(() => new JevWakeupInstance({}, {})).toThrow(/apiKey/);
  });

  it("越界的数值回落到默认值", () => {
    const engine = new JevWakeupInstance({ apiKey: "k", threshold: 2, cooldownMs: -1, timeoutMs: 1, historyMessages: 0 }, {});
    expect(engine.config.threshold).toBe(1);
    expect(engine.config.cooldownMs).toBe(30_000);
    expect(engine.config.timeoutMs).toBe(1_500);
    expect(engine.config.historyMessages).toBe(8);
  });
});

describe("jev wakeup: 接进场景", () => {
  it("模型说该开口就真的唤起一轮；它自己发出去的话回到窗口，并顶起冷却", async () => {
    const bodies = stubEndpoint([SPEAKS]);
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

    const wakeup = new JevWakeupInstance({ apiKey: "k" }, { logger });
    // 自定义消息要有人投影成模型消息，否则一轮的 prompt 是空的。
    const context = new StandardContextInstance({ maxChars: 10_000 }, { logger });
    const directory = mkdtempSync(path.join(tmpdir(), "ishiki-wakeup-jev-"));

    try {
      const scene = new AgentRuntime({
        label: "test/scene/room",
        channelId: "room",
        directory,
        model,
        instructions: "",
        ctx,
        domain: { form: "channel", platform: "onebot", selfId: "1", channelId: "room" },
        context,
        tools: {
          send_message: createSendMessage({
            ctx,
            logger,
            sid: "onebot:1",
            channelId: "room",
            typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
          }),
        },
        extensions: [],
        innerThoughts: false,
        codemode: { enable: false, direct: [], timeoutMs: 30_000 },
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
      expect(wakeup.history("room").map((line) => `${line.author}:${line.text}`)).toEqual(["Neko:在吗", "self:在的"]);
      const before = bodies.length;
      expect(await wakeup.decide(message({ content: "再说一句" }))).toBe("wait");
      expect(bodies).toHaveLength(before);

      await scene.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
