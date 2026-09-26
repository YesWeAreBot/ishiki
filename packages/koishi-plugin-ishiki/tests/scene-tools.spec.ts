import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, simulateReadableStream, type LanguageModelV4StreamPart, type Tool } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProfileConfig, resolveProfile } from "../src/profile.js";
import { ProfileRuntime } from "../src/runtime.js";
import { createDispatchStimulus } from "../src/tools/dispatch-stimulus.js";
import { createFinish } from "../src/tools/finish.js";
import { createPeekChannelHistory } from "../src/tools/peek-channel-history.js";
import { createSendMessage } from "../src/tools/send-message.js";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const logger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** 直接驱动一个工具：AI SDK 只在执行时用到 toolCallId。 */
async function run<I, O>(tool: Tool<I, O>, input: I): Promise<O> {
  return (await tool.execute!(input, { toolCallId: "call-1" } as never)) as O;
}

/** 一段工具调用的流式分块，形状与 SDK 的 mock model 期望一致。 */
function toolStep(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

describe("send_message", () => {
  /** 用例不测节奏时就别等：charPerSecond 归零 => 只留 minDelay，而 minDelay 也是 0。 */
  const instant = { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 };
  const sent: Array<{ channelId: string; content: string }> = [];
  const bots: Record<string, unknown> = {
    "onebot:1": {
      platform: "onebot",
      selfId: "1",
      sendMessage: async (channelId: string, content: string) => {
        sent.push({ channelId, content });
        return [`id-${sent.length}`];
      },
    },
  };
  const ctx = { bots } as unknown as Context;
  const build = (onEndTurn: () => void = () => undefined, typing = instant) =>
    createSendMessage({ ctx, logger, sid: "onebot:1", channelId: "group:2", typing, onEndTurn });

  it("sends each message as its own platform message and ends the turn by default", async () => {
    sent.length = 0;
    let ended = 0;
    const result = await run(
      build(() => (ended += 1)),
      { messages: ["早", "在干嘛"] },
    );

    expect(result).toEqual({ ok: true, count: 2 });
    expect(sent).toEqual([
      { channelId: "group:2", content: "早" },
      { channelId: "group:2", content: "在干嘛" },
    ]);
    expect(ended).toBe(1);
  });

  it("keeps the turn alive when continue is true", async () => {
    sent.length = 0;
    let ended = 0;
    const result = await run(
      build(() => (ended += 1)),
      { messages: ["先看一眼"], continue: true },
    );

    expect(result).toEqual({ ok: true, count: 1 });
    expect(ended).toBe(0);
  });

  it("escapes the text in raw mode so markup arrives as literal characters", async () => {
    sent.length = 0;
    await run(build(), { messages: ['<at id="42"/> & "引号"'], mode: "raw" });

    expect(sent[0].content).toContain("&lt;at");
    expect(sent[0].content).not.toContain("<at");
  });

  it("stops at the failing message and reports what already left", async () => {
    sent.length = 0;
    bots["onebot:2"] = {
      platform: "onebot",
      selfId: "2",
      sendMessage: async () => {
        throw Object.assign(new Error("blocked"), { name: "BotOffline" });
      },
    };
    const tool = createSendMessage({ ctx, logger, sid: "onebot:2", channelId: "group:2", typing: instant, onEndTurn: () => undefined });
    const result = await run(tool, { messages: ["第一句"] });

    expect(result).toEqual({ ok: false, sent: [], failedAt: 0, error: { name: "BotOffline", message: "blocked" } });
  });

  it("reports an unconnected account and rejects empty input", async () => {
    const tool = createSendMessage({ ctx, logger, sid: "onebot:9", channelId: "group:2", typing: instant, onEndTurn: () => undefined });

    expect(await run(tool, { messages: ["在吗"] })).toMatchObject({ ok: false, error: { name: "BotNotFound" } });
    expect(await run(tool, { messages: [] })).toMatchObject({ ok: false, error: { name: "InvalidInput" } });
  });

  it("waits out the typing rhythm before each bubble", async () => {
    sent.length = 0;
    vi.useFakeTimers();
    try {
      // charPerSecond 归零：延迟就是固定的 minDelay（同时也是 maxDelay）。
      const pending = run(build(undefined, { baseDelay: 0, charPerSecond: 0, minDelay: 250, maxDelay: 250 }), { messages: ["早", "在的"] });

      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toHaveLength(0); // 还在"打字"

      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(sent).toHaveLength(2);
      expect(await pending).toEqual({ ok: true, count: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finish", () => {
  it("asks the container to stop the turn", async () => {
    let stopped = 0;
    const result = await run(createFinish({ onStop: () => (stopped += 1) }), { reason: "没什么好说的" });

    expect(result).toEqual({ ok: true });
    expect(stopped).toBe(1);
  });
});

describe("peek_channel_history", () => {
  const self = { sid: "onebot:1", channelId: "group:2" };

  it("formats the target's own lines under one header", async () => {
    const tool = createPeekChannelHistory({ self, peek: async () => ["[10:00] Miaow(42) #m1: 早", "[10:01] Neko(1) #m2: 早"] });
    const result = await run(tool, { channelId: "group:9", limit: 1 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.text).toContain('<peek sid="onebot:1" channel="group:9" count=1>');
    expect(result.ok && result.text).toContain("#m2");
    expect(result.ok && result.text).not.toContain("#m1");
  });

  it("refuses a channel outside the profile", async () => {
    const tool = createPeekChannelHistory({ self, peek: async () => undefined });
    expect(await run(tool, { channelId: "group:3" })).toMatchObject({ ok: false, error: { name: "TargetNotAllowed" } });
  });

  it("refuses a limit beyond the ceiling without breaking the turn", async () => {
    const tool = createPeekChannelHistory({ self, peek: async () => [] });
    expect(await run(tool, { channelId: "group:9", limit: 51 })).toMatchObject({ ok: false, error: { name: "InvalidLimit" } });
  });
});

describe("dispatch_stimulus", () => {
  const self = { sid: "onebot:1", channelId: "group:2" };

  it("hands the targets to the container with the resolved urgency", async () => {
    const calls: Array<{ targets: unknown; body: unknown }> = [];
    const tool = createDispatchStimulus({
      self,
      dispatch: (targets, body) => {
        calls.push({ targets, body });
        return { delivered: 1, refused: [] };
      },
    });

    const result = await run(tool, { targets: [{ channelId: "group:9" }], reason: "想起来一件事", content: "刚才他说过" });
    await run(tool, { targets: [{ channelId: "group:9" }], reason: "想起来一件事", content: "刚才他说过", urgency: "urgent" });

    expect(result).toEqual({ ok: true, delivered: 1, refused: [] });
    // 不写 urgency 就是不叫醒：投递默认只送达，目标按自己的节奏醒来时读到
    expect(calls).toEqual([
      { targets: [{ channelId: "group:9" }], body: { reason: "想起来一件事", content: "刚才他说过", urgency: "idle" } },
      { targets: [{ channelId: "group:9" }], body: { reason: "想起来一件事", content: "刚才他说过", urgency: "urgent" } },
    ]);
  });

  it("refuses a target that is this very channel, and malformed input", async () => {
    const tool = createDispatchStimulus({ self, dispatch: () => ({ delivered: 1, refused: [] }) });

    expect(await run(tool, { targets: [{ channelId: "group:2" }], reason: "r", content: "c" })).toMatchObject({ ok: false, error: { name: "SelfTarget" } });
    expect(await run(tool, { targets: [], reason: "r", content: "c" })).toMatchObject({ ok: false, error: { name: "InvalidInput" } });
    expect(await run(tool, { targets: [{ channelId: "" }], reason: "r", content: "c" })).toMatchObject({ ok: false, error: { name: "InvalidInput" } });
    expect(await run(tool, { targets: [{ channelId: "group:9" }], reason: "r", content: "c", urgency: "loud" } as never)).toMatchObject({
      ok: false,
      error: { name: "InvalidInput" },
    });
  });

  it("surfaces a delivery that reached nobody", async () => {
    const tool = createDispatchStimulus({
      self,
      dispatch: () => ({ delivered: 0, refused: [{ target: "onebot:1/group:9", error: "channel is not configured in this profile" }] }),
    });
    const result = await run(tool, { targets: [{ channelId: "group:9" }], reason: "r", content: "c" });

    expect(result).toMatchObject({ ok: false, error: { name: "NotDelivered" } });
    expect(result.ok === false && result.refused).toHaveLength(1);
  });
});

/** 一条唤醒私聊场景的消息：只有私聊能唤醒它。 */
function direct(id: string) {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "1",
    channelId: "private:9",
    isDirect: true,
    messageId: `m-${id}`,
    content: id,
    user: { id: "42", name: "Miaow" },
  });
}

describe("tools through a real agent", () => {
  let root: string;
  let runtime: ProfileRuntime;
  let steps: LanguageModelV4StreamPart[][];
  let prompts: string[];
  const platform = { sent: [] as Array<{ channelId: string; content: string }>, streams: 0 };

  const config = ProfileConfig({
    id: "neko",
    presets: {
      base: {
        model: "test:model",
        context: { engine: "standard", standard: { maxChars: 10_000 } },
        // 用例不测节奏：打字延迟归零。
        typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
        // 私聊才唤醒，群里的事只有纸条和 peek 能把消息带进去。
        wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
      },
    },
    scenes: {
      rooms: { preset: "base", sid: "onebot:1", whitelist: ["group:*"] },
      dms: { preset: "base", sid: "onebot:1", whitelist: ["private:*"] },
    },
  });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-tools-"));
    prompts = [];
    steps = [];
    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        prompts.push(JSON.stringify(request.prompt));
        platform.streams += 1;
        return { stream: simulateReadableStream({ chunks: steps.shift() ?? textStep("（脚本用完了）") }) };
      },
    });
    const gateway = { languageModel: () => model, groups: () => [] } as unknown as Gateway;
    const ctx = {
      bots: {
        "onebot:1": {
          platform: "onebot",
          selfId: "1",
          sendMessage: async (channelId: string, content: string) => {
            platform.sent.push({ channelId, content });
            return [`id-${platform.sent.length}`];
          },
        },
      },
    } as unknown as Context;

    runtime = new ProfileRuntime({ id: "neko", directory: root, specs: resolveProfile(config, "neko"), ctx, gateway, logger });
  });

  afterAll(async () => {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("carries the model's own words to the platform and ends the turn", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    steps = [toolStep("send_message", { messages: ["在的"] }), textStep("这一步不该被走到")];

    const scene = runtime.route(direct("a"))!;
    scene.deliver(direct("a"));
    await scene.idle();

    expect(platform.sent).toEqual([{ channelId: "private:9", content: "在的" }]);
    // 说完了就是一轮的结尾：没有实义工具时不再走第二步
    expect(platform.streams).toBe(1);
  });

  it("ends the turn on finish without speaking", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    steps = [toolStep("finish", { reason: "不用回" }), textStep("这一步不该被走到")];

    const scene = runtime.route(direct("b"))!;
    scene.deliver(direct("b"));
    await scene.idle();

    expect(platform.sent).toEqual([]);
    expect(platform.streams).toBe(1);
  });

  it("delivers a stimulus into a sibling channel", async () => {
    platform.streams = 0;
    steps = [toolStep("dispatch_stimulus", { targets: [{ channelId: "group:2" }], reason: "想问一句", content: "刚才那边说了什么" })];

    const scene = runtime.route(direct("c"))!;
    scene.deliver(direct("c"));
    await scene.idle();

    // 默认 idle：念头落进对方的流，但对方不被叫醒，落盘也不跟这一轮同步
    await vi.waitFor(async () => {
      const lines = await runtime.peek("onebot:1", "group:2", 10);
      expect(lines?.some((line) => line.includes("<stimulus") && line.includes("刚才那边说了什么"))).toBe(true);
    });
  });

  it("feeds a peeked channel's lines back to the model", async () => {
    platform.streams = 0;
    platform.sent.length = 0;
    prompts.length = 0;
    steps = [toolStep("peek_channel_history", { channelId: "group:2", limit: 3 }), textStep("想起来了")];

    const scene = runtime.route(direct("d"))!;
    scene.deliver(direct("d"));
    await scene.idle();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("刚才那边说了什么");
    // 文本回复不会自己到达平台：只有 send_message 能让话被听见
    expect(platform.sent).toEqual([]);
  });
});
