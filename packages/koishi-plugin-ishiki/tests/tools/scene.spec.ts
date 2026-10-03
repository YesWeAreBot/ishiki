import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, simulateReadableStream, type LanguageModelV4StreamPart, type Tool } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, type Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { StandardContextEngine } from "../../src/context/standard.engine.js";
import { resolveProfile } from "../../src/profile.js";
import { ProfileRuntime } from "../../src/runtime.js";
import { NativeToolcallEngine } from "../../src/toolcall/native.engine.js";
import { createFinish } from "../../src/tools/finish.js";
import { createSendMessage } from "../../src/tools/send-message.js";
import { StandardWakeupEngine } from "../../src/wakeup/standard.engine.js";

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
  const build = (typing = instant) =>
    createSendMessage({ ctx, logger, domain: { form: "channel", platform: "onebot", selfId: "1", channelId: "group:2" }, typing });

  it("sends each message as its own platform message", async () => {
    sent.length = 0;
    const result = await run(build(), { messages: ["早", "在干嘛"] });

    expect(result).toEqual({ ok: true, count: 2 });
    expect(sent).toEqual([
      { channelId: "group:2", content: "早" },
      { channelId: "group:2", content: "在干嘛" },
    ]);
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
    const tool = createSendMessage({ ctx, logger, domain: { form: "channel", platform: "onebot", selfId: "2", channelId: "group:2" }, typing: instant });
    const result = await run(tool, { messages: ["第一句"] });

    expect(result).toEqual({ ok: false, sent: [], failedAt: 0, error: { name: "BotOffline", message: "blocked" } });
  });

  it("reports an unconnected account and rejects empty input", async () => {
    const tool = createSendMessage({ ctx, logger, domain: { form: "channel", platform: "onebot", selfId: "9", channelId: "group:2" }, typing: instant });

    expect(await run(tool, { messages: ["在吗"] })).toMatchObject({ ok: false, error: { name: "BotNotFound" } });
    expect(await run(tool, { messages: [] })).toMatchObject({ ok: false, error: { name: "InvalidInput" } });
  });

  it("waits out the typing rhythm before each bubble", async () => {
    sent.length = 0;
    vi.useFakeTimers();
    try {
      // charPerSecond 归零：延迟就是固定的 minDelay（同时也是 maxDelay）。
      const pending = run(build({ baseDelay: 0, charPerSecond: 0, minDelay: 250, maxDelay: 250 }), { messages: ["早", "在的"] });

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
  it("acknowledges the request", async () => {
    const result = await run(createFinish(), { reason: "没什么好说的" });

    expect(result).toEqual({ ok: true });
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
  /** 每次赋值覆盖发送行为：缺省成功，用例里换成抛错来模拟平台失败。 */
  let deliverMessage: (channelId: string, content: string) => Promise<string[]> = async (channelId, content) => {
    platform.sent.push({ channelId, content });
    return [`id-${platform.sent.length}`];
  };

  const config = {
    model: "test:model",
    context: { engine: "standard", standard: { maxTokens: 10_000 } },
    // 用例不测节奏：打字延迟归零。
    typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
    // 私聊才唤醒：群里的消息只落盘，不起轮次。
    wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
    scenes: {
      rooms: { sid: "onebot:1", whitelist: ["group:*"] },
      dms: { sid: "onebot:1", whitelist: ["private:*"] },
    },
  };

  // 引擎 provider 立在这台 ctx 上：运行时只按服务名取用，用例给的就是真服务；bot 换成桩。
  const app = new Context();
  new StandardContextEngine(app);
  new StandardWakeupEngine(app);
  new NativeToolcallEngine(app);

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-tools-"));
    prompts = [];
    steps = [];
    await app.start();
    // 平台出站只验「发了什么」：把 bot 注册表换成桩，真 Bot 要协议适配器，这里用不上。
    const bots = app as unknown as { bots: Record<string, unknown> };
    bots.bots = {
      "onebot:1": {
        platform: "onebot",
        selfId: "1",
        // 解引用而不是取值：用例可以在运行中换掉发送行为来模拟平台失败。
        sendMessage: (channelId: string, content: string) => deliverMessage(channelId, content),
      },
    };

    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        prompts.push(JSON.stringify(request.prompt));
        platform.streams += 1;
        return { stream: simulateReadableStream({ chunks: steps.shift() ?? textStep("（脚本用完了）") }) };
      },
    });
    const gateway = { languageModel: () => model, groups: () => [] } as unknown as Gateway;
    const resolved = resolveProfile(config, "neko");
    runtime = new ProfileRuntime({
      id: resolved.id,
      root,
      specs: resolved.specs,
      extensions: resolved.extensions,
      ctx: app,
      gateway,
      debugStream: false,
      logger,
    });
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

  it("keeps the turn alive when send_message asks to continue", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    // 发了话但话没说完：continue 让这一批不作数，下一步才收尾。
    steps = [toolStep("send_message", { messages: ["先看一眼"], continue: true }), toolStep("finish", { reason: "看完了" }), textStep("这一步不该被走到")];

    const scene = runtime.route(direct("f"))!;
    await scene.deliver(direct("f"));
    await scene.idle();

    expect(platform.sent.map((entry) => entry.content)).toEqual(["先看一眼"]);
    expect(platform.streams).toBe(2);
  });

  it("keeps the turn alive when the batch carries tools besides speaking", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    // 同一批里既说了话又调了别的工具：这一批不停，等下一批只发言时才收尾
    steps = [
      toolBatch(["send_message", { messages: ["我看看"] }], ["lookup", { keyword: "喵" }]),
      toolStep("send_message", { messages: ["看完了"] }),
      textStep("这一步不该被走到"),
    ];

    const scene = runtime.route(direct("d"))!;
    await scene.deliver(direct("d"));
    await scene.idle();

    expect(platform.sent.map((entry) => entry.content)).toEqual(["我看看", "看完了"]);
    expect(platform.streams).toBe(2);
  });

  it("keeps the turn alive when a partial batch send fails", async () => {
    platform.sent.length = 0;
    platform.streams = 0;
    // 第一条成功、第二条抛错：轮次留着，让模型看到 ok:false 再决定重试。
    const original = deliverMessage;
    deliverMessage = async (channelId, content) => {
      if (content === "第二条") throw Object.assign(new Error("blocked"), { name: "BotOffline" });
      return original(channelId, content);
    };
    steps = [toolStep("send_message", { messages: ["第一条", "第二条"] }), toolStep("finish", { reason: "重试过了" }), textStep("这一步不该被走到")];

    try {
      const scene = runtime.route(direct("e"))!;
      await scene.deliver(direct("e"));
      await scene.idle();

      expect(platform.sent.map((entry) => entry.content)).toEqual(["第一条"]);
      expect(platform.streams).toBe(2);
    } finally {
      deliverMessage = original;
    }
  });
});
