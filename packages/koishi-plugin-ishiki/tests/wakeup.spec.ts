import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, simulateReadableStream, type LanguageModelV4StreamPart } from "@yesimagent/core";
import type { Logger } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StandardContextEngine } from "../src/context/standard.engine.js";
import { SceneRuntime } from "../src/runtime.js";
import type { IshikiMessageCreated } from "../src/types.js";
import { ClassicWakeupEngine } from "../src/wakeup/classic.engine.js";
import { createWakeupEngine } from "../src/wakeup/index.js";

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
function engineWith(overrides: Partial<ConstructorParameters<typeof ClassicWakeupEngine>[0]> = {}): ClassicWakeupEngine {
  return new ClassicWakeupEngine(overrides);
}

describe("classic wakeup: 配置", () => {
  it("按名从注册表建出引擎", () => {
    expect(createWakeupEngine({ engine: "classic" }).name).toBe("classic");
    expect(createWakeupEngine({ engine: "standard" }).name).toBe("standard");
    expect(() => createWakeupEngine({ engine: "nope" })).toThrow(/unknown wakeup engine/);
  });

  it("越界的数值回落到默认值，不把 NaN 放进概率", () => {
    const engine = engineWith({ maxWillingness: 0, decayHalfLifeSeconds: Number.NaN, probabilityAmplifier: -1, replyCost: -5 });
    expect(engine.config.maxWillingness).toBe(100);
    expect(engine.config.decayHalfLifeSeconds).toBe(600);
    expect(engine.config.probabilityAmplifier).toBe(0.04);
    expect(engine.config.replyCost).toBe(35);
  });
});

describe("classic wakeup: 增益", () => {
  it("单条普通消息只拿到基础分", () => {
    const engine = engineWith();
    engine.decide(message());
    expect(engine.scoreOf("room")).toBe(12);
  });

  it("被 @、引用、私聊、关键词各自加成，@ 与引用可叠加", () => {
    const mentioned = engineWith();
    mentioned.decide(message({ content: '<at id="bot"/>在吗' }));
    expect(mentioned.scoreOf("room")).toBe(100); // 112 被上限夹住

    const quoted = engineWith();
    quoted.decide(message({ quote: { id: "m0", user: { id: "bot" }, content: "上一条" } }));
    expect(quoted.scoreOf("room")).toBe(27); // 12 + 15

    const direct = engineWith();
    direct.decide(message({ isDirect: true }));
    expect(direct.scoreOf("room")).toBe(52); // 12 + 40

    const keyword = engineWith({ keywords: ["帮忙"] });
    keyword.decide(message({ content: "帮我个忙行不行" }));
    expect(keyword.scoreOf("room")).toBe(12); // 未命中，走 defaultMultiplier

    const hit = engineWith({ keywords: ["帮忙"] });
    hit.decide(message({ content: "麻烦你帮忙看一下" }));
    expect(hit.scoreOf("room")).toBeCloseTo(14.4, 6); // 12 × 1.2

    // 加成是相加的：把基础分清零后只剩两项加成之和。
    const stacked = engineWith({ base: 0, atMention: 10, isQuote: 5 });
    stacked.decide(message({ content: '<at id="bot"/>看这个', quote: { id: "m0", user: { id: "bot" }, content: "上一条" } }));
    expect(stacked.scoreOf("room")).toBe(15);
  });

  it("增益的边际递减被 S 型曲线放大，中段最高，接近上限时回落", () => {
    const engine = engineWith();
    const deltas: number[] = [];
    let previous = 0;
    for (let index = 0; index < 12; index += 1) {
      engine.decide(message());
      const now = engine.scoreOf("room");
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

describe("classic wakeup: 掷骰", () => {
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
    const stimulus = createCustomMessage("ishiki.inner_stimulus", {
      timestamp: Date.now(),
      platform: "onebot",
      selfId: "bot",
      channelId: "room",
      reason: "别的频道在聊你",
      content: "过来看看",
    });

    expect(engine.decide(stimulus)).toBe("wait");
    expect(engine.scoreOf("room")).toBe(0);
  });
});

describe("classic wakeup: 衰减与回复成本", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("半衰期到点，意愿减半", () => {
    vi.useFakeTimers();
    const engine = engineWith();
    engine.decide(message());
    expect(engine.scoreOf("room")).toBe(12);

    vi.advanceTimersByTime(600_000);
    expect(engine.scoreOf("room")).toBeCloseTo(6, 6);
  });

  it("久闲之后归零", () => {
    vi.useFakeTimers();
    const engine = engineWith();
    engine.decide(message({ content: '<at id="bot"/>在吗' }));

    vi.advanceTimersByTime(600_000 * 20);
    expect(engine.scoreOf("room")).toBe(0);
  });

  it("一轮结束后扣掉回复成本", () => {
    const engine = engineWith();
    engine.decide(message({ content: '<at id="bot"/>在吗' }));
    expect(engine.scoreOf("room")).toBe(100);

    engine.observe("room");
    expect(engine.scoreOf("room")).toBe(65);

    // 成本扣到 0 就停住，不会倒欠。
    engine.observe("room");
    engine.observe("room");
    expect(engine.scoreOf("room")).toBe(0);
  });

  it("没见过的频道收到回执不做任何事", () => {
    const engine = engineWith();
    engine.observe("nowhere");
    expect(engine.scoreOf("nowhere")).toBe(0);
  });
});

describe("classic wakeup: 轮末回执由场景侧送进来", () => {
  it("一轮走完后扣掉回复成本", async () => {
    const stream: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "嗯" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
    ];
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: stream }) }) });
    const wakeup = new ClassicWakeupEngine();
    const directory = mkdtempSync(path.join(tmpdir(), "ishiki-wakeup-"));

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
        tools: {},
        wakeup,
        logger,
      });

      // 被 @ 一条即触发，意愿顶到上限。
      const event = message({ content: '<at id="bot"/>在吗' });
      scene.deliver(event);
      await scene.idle();

      expect(logs).toEqual([]);
      expect(wakeup.scoreOf("room")).toBe(65); // 100 - replyCost
      await scene.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
