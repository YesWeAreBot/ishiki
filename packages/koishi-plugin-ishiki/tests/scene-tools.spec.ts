import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, simulateReadableStream, type LanguageModelV4StreamPart, type Tool } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProfileConfig, resolveProfile } from "../src/profile.js";
import { ProfileRuntime } from "../src/runtime.js";
import { createFinish } from "../src/tools/finish.js";
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

/** 一批里的多个工具调用：收尾在批边界判定，同一批有没有别的工具决定这一轮停不停。 */
function toolBatch(...calls: Array<[string, unknown]>): LanguageModelV4StreamPart[] {
  return [
    ...calls.map(([toolName, input], index) => ({
      type: "tool-call" as const,
      toolCallId: `call-${index + 1}`,
      toolName,
      input: JSON.stringify(input),
    })),
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
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
    let ended = 0;
    bots["onebot:2"] = {
      platform: "onebot",
      selfId: "2",
      sendMessage: async () => {
        throw Object.assign(new Error("blocked"), { name: "BotOffline" });
      },
    };
    const tool = createSendMessage({ ctx, logger, sid: "onebot:2", channelId: "group:2", typing: instant, onEndTurn: () => (ended += 1) });
    const result = await run(tool, { messages: ["第一句"] });

    expect(result).toEqual({ ok: false, sent: [], failedAt: 0, error: { name: "BotOffline", message: "blocked" } });
    // 没发出去就不算「说完了」：轮次留着，模型可以换个说法再来
    expect(ended).toBe(0);
  });

  it("reports an unconnected account and rejects empty input", async () => {
    let ended = 0;
    const tool = createSendMessage({ ctx, logger, sid: "onebot:9", channelId: "group:2", typing: instant, onEndTurn: () => (ended += 1) });

    expect(await run(tool, { messages: ["在吗"] })).toMatchObject({ ok: false, error: { name: "BotNotFound" } });
    expect(await run(tool, { messages: [] })).toMatchObject({ ok: false, error: { name: "InvalidInput" } });
    expect(ended).toBe(0);
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
        // 私聊才唤醒：群里的消息只落盘，不起轮次。
        wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
        scenes: {
          rooms: { sid: "onebot:1", whitelist: ["group:*"] },
          dms: { sid: "onebot:1", whitelist: ["private:*"] },
        },
      },
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

    runtime = new ProfileRuntime({ id: "neko", directory: root, resolved: resolveProfile(config, "neko"), ctx, gateway, logger });
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
    await scene.deliver(direct("a"));
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
    await scene.deliver(direct("b"));
    await scene.idle();

    expect(platform.sent).toEqual([]);
    expect(platform.streams).toBe(1);
  });

  it("keeps the turn alive when the batch carries tools besides speaking", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    // 同一批里既说了话又要查资料：这一批不停，等下一批（没有别的工具了）才收尾
    steps = [
      toolBatch(["send_message", { messages: ["我看看"] }], ["peek_channel_history", { channelId: "group:2", limit: 3 }]),
      toolStep("send_message", { messages: ["看完了"] }),
      textStep("这一步不该被走到"),
    ];

    const scene = runtime.route(direct("d"))!;
    await scene.deliver(direct("d"));
    await scene.idle();

    expect(platform.sent.map((entry) => entry.content)).toEqual(["我看看", "看完了"]);
    expect(platform.streams).toBe(2);
  });
});
