import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MockLanguageModelV4,
  createCustomMessage,
  jsonSchema,
  simulateReadableStream,
  tool,
  type LanguageModelV4StreamPart,
  type ToolSet,
} from "@yesimagent/core";
import { Context, type Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StandardContextEngine, StandardContextInstance } from "../src/context/standard.engine.js";
import { resolveProfile } from "../src/profile.js";
import { AgentRuntime, ProfileRuntime } from "../src/runtime.js";
import { NativeToolcallEngine } from "../src/toolcall/index.js";
import { CODE_MODE, createCodemode, loadCodemode } from "../src/tools/codemode.js";
import { createFinish } from "../src/tools/finish.js";
import { createSendMessage } from "../src/tools/send-message.js";
import { StandardWakeupEngine, StandardWakeupInstance } from "../src/wakeup/index.js";

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const logger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

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

/** 一条私聊事实行：私聊才唤醒场景。 */
function event(id: string) {
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

/** 记下每次调用的工具名与参数：沙箱里的调用是嵌套的，只有这里能看清调了哪几件。 */
const calls: Array<{ name: string; input: unknown }> = [];

const lookup = tool({
  description: "按关键词查词条。",
  inputSchema: jsonSchema<{ keyword: string }>({ type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }),
  execute: async (input) => {
    calls.push({ name: "lookup", input });
    return { hits: ["喵", "喵喵", "喵呜"] };
  },
});

const noop = tool({
  description: "什么也不做。",
  inputSchema: jsonSchema<string>({ type: "string" }),
  execute: async (input: string) => {
    calls.push({ name: "noop", input });
    return { ok: true };
  },
});

describe("code mode", () => {
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
  const baseTools: ToolSet = {
    send_message: createSendMessage({
      ctx,
      logger,
      sid: "onebot:1",
      channelId: "private:9",
      typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
    }),
    finish: createFinish(),
    lookup,
    noop,
  };
  const config = { enable: true, direct: ["noop"], timeoutMs: 10_000 };

  let directory: string;
  let steps: LanguageModelV4StreamPart[][];
  let toolNames: string[][];
  let scene: AgentRuntime | undefined;

  beforeEach(async () => {
    await loadCodemode();
    directory = mkdtempSync(path.join(os.tmpdir(), "ishiki-codemode-"));
    steps = [];
    toolNames = [];
    calls.length = 0;
    sent.length = 0;
  });

  afterEach(async () => {
    await scene?.stop();
    scene = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  /** 造一个开着代码模式的场景：工具面按配置收窄，收尾工具留在外。 */
  function openScene(): AgentRuntime {
    const sandbox = createCodemode(config, baseTools);
    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        toolNames.push((request.tools ?? []).map((tool) => tool.name));
        return { stream: simulateReadableStream({ chunks: steps.shift() ?? textStep("（脚本用完了）") }) };
      },
    });
    scene = new AgentRuntime({
      label: "test/scene/dm",
      channelId: "private:9",
      directory,
      model,
      instructions: "",
      context: new StandardContextInstance({ maxChars: 10_000 }, { logger }),
      tools: { ...baseTools, [CODE_MODE]: sandbox.tool },
      toolCallers: sandbox.callers,
      // 唤醒引擎不参与这个用例的断言：直接送事实行，起轮次靠的是引擎存在即可。
      wakeup: new StandardWakeupInstance({ direct: true, atSelf: false, quoteSelf: false, keywords: [] }),
      logger,
    });
    return scene;
  }

  it("hides the sandboxed tools from the model, leaving it the direct ones and the sandbox", async () => {
    steps = [textStep("先看看")];

    await openScene().deliver(event("a"));
    await scene!.idle();

    // lookup 收进沙箱；send_message 双可达、finish 只直调、noop 由 direct 点名，三者都留在目录。
    expect(toolNames[0]).toEqual(["send_message", "finish", "noop", CODE_MODE]);
  });

  it("runs a nested call from generated code and reports it to the host", async () => {
    steps = [
      toolStep(CODE_MODE, { js: 'const r = await tools.lookup({ keyword: "喵" }); return { n: r.hits.length };' }),
      toolStep("finish", { reason: "看完了" }),
    ];

    await openScene().deliver(event("b"));
    await scene!.idle();

    // 沙箱里的调用照样落到宿主工具上：它跑在沙箱外面，事件与 hooks 都在。
    expect(calls).toEqual([{ name: "lookup", input: { keyword: "喵" } }]);
    // 程序只是查了东西，轮次留着给模型接着用结果。
    expect(toolNames).toHaveLength(2);
  });

  it("keeps the turn going when the program speaks through send_message", async () => {
    steps = [
      toolStep(CODE_MODE, { js: 'const r = await tools.send_message({ messages: ["在的"] }); return { ok: r.ok };' }),
      toolStep("finish", { reason: "说完了" }),
    ];

    await openScene().deliver(event("c"));
    await scene!.idle();

    expect(sent).toEqual([{ channelId: "private:9", content: "在的" }]);
    // 程序内的发言不是直调：轮次留到下一步，收尾只由直调产生。
    expect(toolNames).toHaveLength(2);
  });

  it("reports a program that throws as a tool result and keeps the turn going", async () => {
    steps = [toolStep(CODE_MODE, { js: "throw new Error('我算错了');" }), toolStep("finish", { reason: "算了" }), textStep("这一步不该被走到")];

    await openScene().deliver(event("d"));
    await scene!.idle();

    const entries = await scene!.storage.read();
    expect(JSON.stringify(entries)).toContain("我算错了");
    // 第一步的失败由模型在下一步直接看到：finish 直调才收尾。
    expect(toolNames).toHaveLength(2);
  });
});

describe("codemode config", () => {
  it("defaults to off, and scene overrides field by field", () => {
    const spec = resolveProfile(
      {
        id: "neko",
        presets: {
          base: {
            model: "test:model",
            codemode: { enable: true, direct: ["a"], timeoutMs: 1000 },
            // 数组整体替换：scene 写下新的一份，`direct` 不与 preset 拼接。
            scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"], codemode: { direct: ["b"], timeoutMs: 2000 } } },
          },
        },
      },
      "neko",
    ).presets[0]!.specs[0]!;

    expect(spec.codemode).toEqual({ enable: true, direct: ["b"], timeoutMs: 2000 });
    expect(
      resolveProfile({ id: "neko", presets: { base: { model: "test:model", scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } } } } }, "neko")
        .presets[0]!.specs[0]!.codemode,
    ).toEqual({ enable: false, direct: [], timeoutMs: 30_000 });
  });

  it("wires the scene's flag into the agent's caller table", async () => {
    await loadCodemode();
    const directory = mkdtempSync(path.join(os.tmpdir(), "ishiki-codemode-cfg-"));
    const seen: string[][] = [];
    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        seen.push((request.tools ?? []).map((tool) => tool.name));
        const chunks: LanguageModelV4StreamPart[] = [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "在的" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
        ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const config = {
      id: "neko",
      presets: {
        base: {
          model: "test:model",
          context: { engine: "standard", standard: { maxChars: 10_000 } },
          typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
          wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
          codemode: { enable: true },
          scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } },
        },
      },
    };
    const gateway = { languageModel: () => model, groups: () => [] } as never;
    // 引擎 provider 立在这台真 ctx 上：运行时只按服务名取用；provider 在 ready 时登记，先启动。
    const ctx = new Context();
    new StandardContextEngine(ctx);
    new StandardWakeupEngine(ctx);
    new NativeToolcallEngine(ctx);
    await ctx.start();
    const runtime = new ProfileRuntime({ id: "neko", directory, ctx, gateway, logger });
    for (const preset of resolveProfile(config, "neko").presets) runtime.activate(preset);

    try {
      await runtime.route(event("e"))!.deliver(event("e"));
      await runtime.route(event("e"))!.idle();
      // 收尾工具恒在外，其余收进沙箱：目录里两者并存。
      expect(seen[0]).toEqual(["send_message", "finish", CODE_MODE]);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
