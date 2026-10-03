import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, simulateReadableStream, type LanguageModelV4StreamPart } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, type Logger } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandardContextInstance } from "../../src/context/standard.engine.js";
import { AgentRuntime } from "../../src/runtime.js";
import type { IshikiMessageCreated } from "../../src/types.js";
import { WakeupEngine, type WakeupEngineInstance } from "../../src/wakeup/engine.js";
import { StandardWakeupEngine } from "../../src/wakeup/standard.engine.js";
import { V3WakeupEngine, V3WakeupInstance } from "../../src/wakeup/v3.engine.js";
import { contextOptions } from "../context-stub.js";

const logs: string[] = [];
const logger = {
  debug: () => undefined,
  warn: (line: string) => logs.push(`warn ${line}`),
  error: (line: string) => logs.push(`error ${line}`),
} as unknown as Logger;
const USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

/** 一条频道消息；默认是最普通的那一种（无 @、无引用、非私聊、无关键词）。 */
function message(overrides: Partial<IshikiMessageCreated> = {}) {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "bot",
    channelId: "room",
    messageId: "m1",
    content: "在吗",
    isDirect: false,
    user: { id: "u1", name: "Neko" },
    ...overrides,
  } satisfies IshikiMessageCreated);
}

/** 只看得到的意愿值：`decide` 的掷骰在测试里不参与断言。 */
function engineWith(overrides: Partial<ConstructorParameters<typeof V3WakeupInstance>[0]> = {}): V3WakeupInstance {
  return new V3WakeupInstance(overrides);
}

describe("v3 wakeup: 配置", () => {
  it("可调用 provider 从完整配置读取本变体参数，运行体独立", async () => {
    const app = new Context();
    new V3WakeupEngine(app);
    new StandardWakeupEngine(app);
    await app.start();
    try {
      const provider = WakeupEngine.GetService(app, "v3");
      const limited = provider({ engine: "v3", v3: { maxWillingness: 42 } }, {});
      const normal = provider({ engine: "v3" }, {});
      const mentioned = message({ content: '<at id="bot"/>在吗' });
      expect(limited.decide(mentioned)).toBe("wait");
      expect(normal.decide(mentioned)).toBe("trigger");
      const standard = WakeupEngine.GetService(app, "standard")({ engine: "standard", standard: { direct: false } }, {});
      expect(standard.decide(message({ isDirect: true }))).toBe("wait");
    } finally {
      await app.stop();
    }
  });

  it("越界的数值回落到默认值，不把 NaN 放进概率", () => {
    const engine = engineWith({ maxWillingness: 0, decayHalfLifeSeconds: Number.NaN, probabilityAmplifier: -1, replyCost: -5 });
    expect(engine.config.maxWillingness).toBe(100);
    expect(engine.config.decayHalfLifeSeconds).toBe(600);
    expect(engine.config.probabilityAmplifier).toBe(0.04);
    expect(engine.config.replyCost).toBe(35);
  });
});

describe("v3 wakeup: 增益", () => {
  it("单条普通消息只拿到基础分", () => {
    const engine = engineWith();
    engine.decide(message());
    expect(engine.score("room")).toBe(12);
  });

  it("被 @、引用、私聊、关键词各自加成，@ 与引用可叠加", () => {
    const mentioned = engineWith();
    mentioned.decide(message({ content: '<at id="bot"/>在吗' }));
    expect(mentioned.score("room")).toBe(100); // 112 被上限夹住

    const quoted = engineWith();
    quoted.decide(message({ quote: { id: "m0", user: { id: "bot" }, content: "上一条" } }));
    expect(quoted.score("room")).toBe(27); // 12 + 15

    const direct = engineWith();
    direct.decide(message({ isDirect: true }));
    expect(direct.score("room")).toBe(52); // 12 + 40

    const keyword = engineWith({ keywords: ["帮忙"] });
    keyword.decide(message({ content: "帮我个忙行不行" }));
    expect(keyword.score("room")).toBe(12); // 未命中，走 defaultMultiplier

    const hit = engineWith({ keywords: ["帮忙"] });
    hit.decide(message({ content: "麻烦你帮忙看一下" }));
    expect(hit.score("room")).toBeCloseTo(14.4, 6); // 12 × 1.2

    // 加成是相加的：把基础分清零后只剩两项加成之和。
    const stacked = engineWith({ base: 0, atMention: 10, isQuote: 5 });
    stacked.decide(message({ content: '<at id="bot"/>看这个', quote: { id: "m0", user: { id: "bot" }, content: "上一条" } }));
    expect(stacked.score("room")).toBe(15);
  });

  it("增益的边际递减被 S 型曲线放大，中段最高，接近上限时回落", () => {
    const engine = engineWith();
    const deltas: number[] = [];
    let previous = 0;
    for (let index = 0; index < 12; index += 1) {
      engine.decide(message());
      const now = engine.score("room");
      deltas.push(now - previous);
      previous = now;
    }

    // 起点是纯基础分（S 曲线在 0.2 以下是 1 倍），中段被放大到超过它，接近上限时又收敛回去。
    expect(deltas[0]).toBe(12);
    expect(Math.max(...deltas)).toBeGreaterThan(deltas[0]!);
    expect(deltas[deltas.length - 1]!).toBeLessThan(deltas[0]!);
    expect(previous).toBeLessThanOrEqual(100);
  });
});

describe("v3 wakeup: 掷骰", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("意愿在阈值以下必等，@ 一条即触发", () => {
    const quiet = engineWith();
    expect(quiet.decide(message())).toBe("wait");

    const mentioned = engineWith();
    expect(mentioned.decide(message({ content: '<at id="bot"/>在吗' }))).toBe("trigger");
  });

  it("普通消息要攒到阈值之上，概率才从 0 抬起来", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const engine = engineWith();
    const decisions: string[] = [];
    for (let index = 0; index < 8; index += 1) decisions.push(engine.decide(message()));

    // 概率在阈值（55）处还是 0，到 67.5 才够 0.5；头几条因此必等。
    expect(decisions.slice(0, 4)).toEqual(["wait", "wait", "wait", "wait"]);
    expect(decisions).toContain("trigger");
    expect(decisions.indexOf("trigger")).toBeGreaterThanOrEqual(4);
  });

  it("其它类型的事件一律不唤醒", () => {
    const engine = engineWith();
    const deletion = createCustomMessage("ishiki.message.deleted", {
      timestamp: Date.now(),
      platform: "onebot",
      selfId: "bot",
      channelId: "room",
      messageId: "m-1",
    });

    expect(engine.decide(deletion)).toBe("wait");
    expect(engine.score("room")).toBe(0);
  });
});

describe("v3 wakeup: 衰减与回复成本", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("半衰期到点，意愿减半", () => {
    vi.useFakeTimers();
    const engine = engineWith();
    engine.decide(message());
    expect(engine.score("room")).toBe(12);

    vi.advanceTimersByTime(600_000);
    expect(engine.score("room")).toBeCloseTo(6, 6);
  });

  it("久闲之后归零", () => {
    vi.useFakeTimers();
    const engine = engineWith();
    engine.decide(message({ content: '<at id="bot"/>在吗' }));

    vi.advanceTimersByTime(600_000 * 20);
    expect(engine.score("room")).toBe(0);
  });

  it("一轮结束后扣掉回复成本", () => {
    const engine = engineWith();
    engine.decide(message({ content: '<at id="bot"/>在吗' }));
    expect(engine.score("room")).toBe(100);

    engine.observe("room");
    expect(engine.score("room")).toBe(65);

    // 成本扣到 0 就停住，不会倒欠。
    engine.observe("room");
    engine.observe("room");
    expect(engine.score("room")).toBe(0);
  });

  it("没见过的频道收到回执不做任何事", () => {
    const engine = engineWith();
    engine.observe("nowhere");
    expect(engine.score("nowhere")).toBe(0);
  });
});

describe("v3 wakeup: 轮末回执由场景侧送进来", () => {
  it("一轮走完后扣掉回复成本", async () => {
    const stream: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "嗯" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
    ];
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: stream }) }) });
    const wakeup = new V3WakeupInstance();
    const directory = mkdtempSync(path.join(tmpdir(), "ishiki-wakeup-"));

    try {
      const scene = new AgentRuntime({
        label: "test/scene/room",
        home: directory,
        root: directory,
        model,
        gateway: {} as Gateway,
        instructions: "",
        // 这个用例只送事实行，平台能力用不上：给一个空壳，装配期没有扩展包会碰它。
        ctx: {} as Context,
        domain: { form: "channel", platform: "onebot", selfId: "1", channelId: "room" },
        // 装配器要的是 provider：实例得等工具面与提示词定下来才造。
        context: new StandardContextInstance({ maxTokens: 10_000 }, contextOptions(logger)),
        tools: {},
        extensions: [],
        innerThoughts: false,
        codemode: { enable: false, direct: [], timeoutMs: 30_000 },
        wakeup,
        debugStream: false,
        logger,
      });

      // 被 @ 一条即触发，意愿顶到上限。
      const event = message({ content: '<at id="bot"/>在吗' });
      await scene.deliver(event);
      await scene.idle();

      expect(logs).toEqual([]);
      expect(wakeup.score("room")).toBe(65); // 100 - replyCost
      await scene.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("停止后视窗的订阅被摘掉，重复 stop 不重复拆卸", async () => {
    const stream: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "嗯" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
    ];
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: stream }) }) });
    let detached = 0;
    /** 只数挂载与拆卸次数的运行体：真实引擎的账另有几条用例在盯。 */
    const wakeup: WakeupEngineInstance = {
      decide: () => "trigger",
      attach: () => () => {
        detached += 1;
      },
    };
    const directory = mkdtempSync(path.join(tmpdir(), "ishiki-wakeup-"));

    try {
      const scene = new AgentRuntime({
        label: "test/scene/room",
        home: directory,
        root: directory,
        model,
        gateway: {} as Gateway,
        instructions: "",
        ctx: {} as Context,
        domain: { form: "channel", platform: "onebot", selfId: "1", channelId: "room" },
        context: new StandardContextInstance({ maxTokens: 10_000 }, contextOptions(logger)),
        tools: {},
        extensions: [],
        innerThoughts: false,
        codemode: { enable: false, direct: [], timeoutMs: 30_000 },
        wakeup,
        debugStream: false,
        logger,
      });

      // attach 挂在 core 的 init 上，init 到第一轮才跑：先让一轮走完，拆卸函数才在队列里。
      await scene.deliver(message());
      await scene.idle();
      expect(detached).toBe(0);

      await scene.stop();
      expect(detached).toBe(1);

      // 重复 stop 不再摘第二次。
      await scene.stop();
      expect(detached).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
