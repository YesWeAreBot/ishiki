import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool, LanguageModelV4Prompt } from "@ai-sdk/provider";
import {
  MockLanguageModelV4,
  createCustomMessage,
  simulateReadableStream,
  type Agent,
  type AgentEvent,
  type AgentMessage,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { sleep, type Context, type Logger } from "koishi";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileConfig, resolveProfile, type ResolvedProfile } from "../src/profile.js";
import { ProfileRuntime } from "../src/runtime.js";
import type { IshikiEvent } from "../src/types.js";
import { ClassicWakeupEngine } from "../src/wakeup/classic.engine.js";
import { registerWakeupEngine, WakeupEngine, type WakeupDecision } from "../src/wakeup/index.js";

/**
 * 一个只数「被造了几次」的唤醒引擎：preset 层造实例，频道只引用，同一套账因此跨频道可见。
 * 建了几次就是共享得对不对——账的内容各频道不同，看实例数才验得出来。
 */
let built = 0;
class CountingWakeupEngine extends WakeupEngine<"counting"> {
  constructor(_config: Record<string, never>) {
    super("counting", {});
    built += 1;
  }

  decide(_event: IshikiEvent): WakeupDecision {
    return "wait";
  }
}

declare module "../src/wakeup/engine.js" {
  interface WakeupEngines {
    counting: Record<string, never>;
  }
}

registerWakeupEngine("counting", (config) => new CountingWakeupEngine(config));

/** 用例自选的唤醒规则：认领里没有私聊时改由 @ 起一轮。 */
type Wakeup = { engine: "standard"; standard: { direct: boolean; atSelf: boolean; quoteSelf: boolean; keywords: string[] } };

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const sent: Array<{ sid: string; channelId: string; content: string }> = [];
const ctx = {
  bots: {
    "onebot:1": {
      platform: "onebot",
      selfId: "1",
      sendMessage: async (channelId: string, content: string) => {
        sent.push({ sid: "onebot:1", channelId, content });
        return [`id-${sent.length}`];
      },
    },
    "onebot:2": {
      platform: "onebot",
      selfId: "2",
      sendMessage: async (channelId: string, content: string) => {
        sent.push({ sid: "onebot:2", channelId, content });
        return [`id-${sent.length}`];
      },
    },
  },
} as unknown as Context;

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
}

function toolStep(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [
    { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
    { type: "finish", usage: USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
  ];
}

function message(channelId: string, id: string, selfId = "1") {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId,
    channelId,
    // 用例只关心视窗与寻址：私聊唤醒，群里只落盘。用例要触发一轮时就往私聊投。
    isDirect: channelId.startsWith("private:"),
    messageId: `m-${id}`,
    content: id,
    user: { id: "42", name: "Miaow" },
  });
}

/** 一条 @ 了本账号的消息：认领里没有私聊的用例靠它起一轮。 */
function mentioned(channelId: string, id: string, selfId: string) {
  const event = message(channelId, id, selfId);
  return { ...event, data: { ...event.data, content: `<at id="${selfId}"/>${id}` } };
}

/** 一个按脚本作答的模型，并把每一轮实际送进模型的 prompt 与工具目录留下来：渲染成什么样只能从这两样上验。 */
function scripted(steps: () => LanguageModelV4StreamPart[][], prompts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (request: LanguageModelV4CallOptions) => {
      prompts.push(JSON.stringify({ prompt: request.prompt, tools: request.tools ?? [] }));
      return { stream: simulateReadableStream({ chunks: steps().shift() ?? textStep("（脚本用完了）") }) };
    },
  });
}

/** 运行时连同它的现场：脚本、prompt 记录、临时目录，每个用例块各建一份，互不串味。 */
interface Rig {
  root: string;
  scenesDir: string;
  prompts: string[];
  script: LanguageModelV4StreamPart[][];
  runtime: ProfileRuntime;
}

function rig(resolved: ResolvedProfile): Rig {
  const root = mkdtempSync(path.join(os.tmpdir(), "ishiki-cross-"));
  const prompts: string[] = [];
  const script: LanguageModelV4StreamPart[][] = [];
  const model = scripted(() => script, prompts);
  const gateway = { languageModel: () => model, groups: () => [] } as unknown as Gateway;
  const runtime = new ProfileRuntime({ id: "neko", directory: root, resolved, ctx, gateway, logger });
  return { root, prompts, script, runtime, scenesDir: path.join(root, "scenes") };
}

/** 该轮送进模型的文本：prompt 的各段正文拼起来，事实行与系统提示都在里面。 */
function promptText(rigged: Rig, at = -1): string {
  const prompt: LanguageModelV4Prompt = JSON.parse(rigged.prompts.at(at) ?? "{}").prompt;
  return prompt
    .flatMap((message) => (typeof message.content === "string" ? [message.content] : message.content.map((part) => (part.type === "text" ? part.text : ""))))
    .join("\n");
}

/** 该轮送给模型的工具目录：坐标字段在不在参数表里只能从这儿看。 */
function toolCatalog(rigged: Rig, at = -1): LanguageModelV4FunctionTool[] {
  return JSON.parse(rigged.prompts.at(at) ?? "{}").tools;
}

/** 收尾：未唤醒的投递不跟调用方同步，落盘还在飞，先等它落地再拆目录。 */
async function teardown(rigged: Rig): Promise<void> {
  await sleep(20);
  await rigged.runtime.stop();
  rmSync(rigged.root, { recursive: true, force: true });
}

/** 一个 cross preset：preset 自身即生效单位，claims 认领两个群与一个私聊。 */
function crossSpecs(
  claims: Record<string, { whitelist: string[] }> = { "onebot:1": { whitelist: ["group:*", "private:9"] } },
  wakeup: Wakeup = { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
): ResolvedProfile {
  return resolveProfile(
    ProfileConfig({
      id: "neko",
      presets: {
        lounge: {
          model: "test:model",
          cross: true,
          claims,
          context: { engine: "standard", standard: { maxChars: 10_000 } },
          wakeup,
          typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
        },
      },
    }),
    "neko",
  );
}

/** 一份普通 preset：一频道一实例，逐频道认领。 */
function plainSpecs(): ResolvedProfile {
  return resolveProfile(
    ProfileConfig({
      id: "plain",
      presets: {
        base: {
          model: "test:model",
          context: { engine: "standard", standard: { maxChars: 10_000 } },
          wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
          typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
          scenes: {
            rooms: { sid: "onebot:1", whitelist: ["group:*"] },
            dms: { sid: "onebot:1", whitelist: ["private:*"] },
          },
        },
      },
    }),
    "plain",
  );
}

describe("cross 聚合：claims 的频道共用一块视窗", () => {
  const rigged = rig(crossSpecs());
  afterEach(() => teardown(rigged));

  it("认领的频道全部汇进同一个实例，不逐频道各建一个", () => {
    const first = rigged.runtime.route(message("group:2", "a"));
    const second = rigged.runtime.route(message("group:7", "b"));
    const dm = rigged.runtime.route(message("private:9", "c"));
    expect(first).toBeDefined();
    // 两群一私聊共用一块视窗：第二、第三次路由拿回的是同一个对象
    expect(second).toBe(first);
    expect(dm).toBe(first);
  });

  it("落盘进 cross_<preset> 目录，claims 的频道写同一份 events.jsonl", async () => {
    const shared = rigged.runtime.route(message("group:2", "a"))!;
    await shared.deliver(message("group:2", "a"));
    await shared.deliver(message("group:7", "b"));
    await shared.deliver(message("private:9", "c"));
    await sleep(20);

    // preset 名单是唯一的目录来源：没有 onebot_1_group_2 这样的频道目录
    expect(readdirSync(rigged.scenesDir)).toEqual(["cross_lounge"]);

    const file = readFileSync(path.join(rigged.scenesDir, "cross_lounge", "events.jsonl"), "utf8");
    // 两个群的频道号出现在同一份流里——这正是合流要拿到的东西
    expect(file).toContain("group:2");
    expect(file).toContain("group:7");
  });

  it("claims 里的全部频道共用同一块视窗与同一个唤醒引擎实例", () => {
    built = 0;
    const shared = rig(crossSpecs({ "onebot:1": { whitelist: ["group:*", "private:9"] } }, { engine: "counting" } as never));
    // 引擎随首个实例诞生，装配期不预建
    expect(built).toBe(0);
    expect(shared.runtime.route(message("group:2", "a"))).toBeDefined();
    expect(built).toBe(1);
    expect(shared.runtime.route(message("group:2", "a"))).toBe(shared.runtime.route(message("group:7", "b")));
    expect(built).toBe(1);
    return teardown(shared);
  });
});

describe("cross 聚合：输入侧寻址头", () => {
  it("每条事实行标出处；同源连续消息合成一段，只留一个头", async () => {
    const rigged = rig(crossSpecs());
    const shared = rigged.runtime.route(message("private:9", "a"))!;

    // 未唤醒的投递不跟调用方同步：等它落盘，否则最后一轮读到的窗口里没有它们
    for (const [channel, id] of [
      ["group:2", "g1"],
      ["group:2", "g2"],
      ["group:7", "h1"],
      ["group:7", "h2"],
      ["group:7", "h3"],
    ] as const) {
      await shared.deliver(message(channel, id));
      await sleep(20);
    }
    rigged.script.push(textStep("看见了"));
    await shared.deliver(message("private:9", "wake"));
    await shared.idle();

    const prompt = promptText(rigged);
    // 坐标恒为复合坐标：各账号下的频道号互不相干，单写频道号模型无从分辨
    expect(prompt).toContain("[#onebot:1/group:2]");
    expect(prompt).toContain("[#onebot:1/group:7]");
    // 五条群消息分属两个来源，各只留一个头：同源连续的不重复标出处
    expect(prompt.split("[#onebot:1/group:2]").length - 1).toBe(1);
    expect(prompt.split("[#onebot:1/group:7]").length - 1).toBe(1);
    // 两条内容都还在，合并的是头不是事实
    expect(prompt).toContain("g2");
    expect(prompt).toContain("h3");

    await teardown(rigged);
  });
});

describe("cross 聚合：出站要显式寻址", () => {
  it("模型给的坐标落在认领范围内就发到那个频道", async () => {
    const rigged = rig(crossSpecs());
    sent.length = 0;
    rigged.script.push(toolStep("send_message", { target: "group:7", messages: ["群里那句"] }), textStep("说完了"));
    const shared = rigged.runtime.route(message("private:9", "wake"))!;

    await shared.deliver(message("private:9", "wake"));
    await shared.idle();

    // 唤醒的是私聊，发言的却是另一个群：坐标说了算
    expect(sent).toEqual([{ sid: "onebot:1", channelId: "group:7", content: "群里那句" }]);
    await teardown(rigged);
  });

  it("坐标落在认领范围外，一条都不发出去，报错让模型换坐标重试", async () => {
    const rigged = rig(crossSpecs());
    sent.length = 0;
    rigged.script.push(
      toolStep("send_message", { target: "guild:404", messages: ["发不出去"] }),
      toolStep("send_message", { target: "private:9", messages: ["换了个坐标"] }),
      textStep("说完了"),
    );
    const shared = rigged.runtime.route(message("private:9", "wake"))!;

    await shared.deliver(message("private:9", "wake"));
    await shared.idle();

    // 第一次的坐标没被认领：没有落到平台上，只有改对之后的那条真的出去了
    expect(sent).toEqual([{ sid: "onebot:1", channelId: "private:9", content: "换了个坐标" }]);
    await teardown(rigged);
  });

  it("可达地址簿进系统提示，坐标在参数表里且必填", async () => {
    const rigged = rig(crossSpecs());
    rigged.script.push(textStep("知道了"));
    const shared = rigged.runtime.route(message("private:9", "wake"))!;

    await shared.deliver(message("private:9", "wake"));
    await shared.idle();

    const prompt = promptText(rigged);
    // 通配认领原样进地址簿：展开要一张运行时才知道的表，写模式才是配置者写下的那句事实
    expect(prompt).toContain("onebot:1: group:*, private:9");
    // 坐标在参数表里，且是必填：没有默认投递目标可猜
    const send = toolCatalog(rigged).find((tool) => tool.name === "send_message")!;
    expect(send.inputSchema.required).toEqual(["messages", "target"]);
    expect(Object.keys(send.inputSchema.properties ?? {})).toContain("target");
    await teardown(rigged);
  });
});

describe("cross 聚合：跨账号认领", () => {
  it("两个账号的同名频道汇进同一块视窗，坐标写成复合坐标", async () => {
    const rigged = rig(
      crossSpecs({
        "onebot:1": { whitelist: ["group:2"] },
        "onebot:2": { whitelist: ["group:2"] },
      }),
    );
    const first = rigged.runtime.route(message("group:2", "a", "1"));
    expect(first).toBeDefined();
    expect(rigged.runtime.route(message("group:2", "b", "2"))).toBe(first);
    await teardown(rigged);
  });

  it("复合坐标解到对应账号；裸频道号指不准时报错，不猜一个发出去", async () => {
    const rigged = rig(
      crossSpecs(
        {
          "onebot:1": { whitelist: ["group:2"] },
          "onebot:2": { whitelist: ["group:2"] },
        },
        { engine: "standard", standard: { direct: true, atSelf: true, quoteSelf: false, keywords: [] } },
      ),
    );
    sent.length = 0;
    rigged.script.push(
      toolStep("send_message", { target: "group:2", messages: ["指不准的那条"] }),
      toolStep("send_message", { target: "onebot:2/group:2", messages: ["补上 sid 的那条"] }),
    );
    const shared = rigged.runtime.route(message("group:2", "a", "1"))!;

    // 认领里没有私聊，@ 才起得了这一轮
    await shared.deliver(mentioned("group:2", "a", "1"));
    await shared.idle();

    expect(sent).toEqual([{ sid: "onebot:2", channelId: "group:2", content: "补上 sid 的那条" }]);

    // 未唤醒的投递不跟调用方同步：等它落盘，否则这一轮读到的窗口里没有它
    await shared.deliver(mentioned("group:2", "b", "2"));
    await sleep(20);
    rigged.script.push(textStep("在"));
    await shared.idle();

    // 多 sid 时寻址头必须带 sid：两个账号的 group:2 只写频道号，模型无从分辨
    expect(promptText(rigged)).toContain("[#onebot:1/group:2]");
    await teardown(rigged);
  });
});

describe("非 cross 零收缩", () => {
  const rigged = rig(plainSpecs());
  afterEach(() => teardown(rigged));

  it("仍是一频道一实例，目录仍按 sid 与频道命名", async () => {
    const room = rigged.runtime.route(message("group:2", "a"))!;
    const dm = rigged.runtime.route(message("private:9", "c"))!;

    expect(dm).not.toBe(room);

    await room.deliver(message("group:2", "a"));
    await dm.deliver(message("private:9", "c"));
    await dm.idle();

    expect(readdirSync(rigged.scenesDir).sort()).toEqual(["onebot_1_group_2", "onebot_1_private_9"]);
  });

  it("事实行不带寻址头，系统提示里没有地址簿", async () => {
    rigged.prompts.length = 0;
    rigged.script.push(textStep("在"));
    const dm = rigged.runtime.route(message("private:9", "c"))!;

    await dm.deliver(message("private:9", "c"));
    await dm.idle();

    const prompt = promptText(rigged);
    expect(prompt).not.toContain("[#private:9 |");
    expect(prompt).not.toContain("本视窗合并了下列频道");
  });

  it("send_message 不带 target，工具参数表里也没有坐标字段", async () => {
    rigged.prompts.length = 0;
    sent.length = 0;
    rigged.script.push(toolStep("send_message", { messages: ["在的"] }), textStep("说完了"));
    const dm = rigged.runtime.route(message("private:9", "c"))!;

    await dm.deliver(message("private:9", "c"));
    await dm.idle();

    expect(sent).toEqual([{ sid: "onebot:1", channelId: "private:9", content: "在的" }]);
    // 单频道形态的模型看不到坐标字段：没有它就没有能写错的地方
    const send = toolCatalog(rigged).find((tool) => tool.name === "send_message")!;
    expect(Object.keys(send.inputSchema.properties ?? {})).not.toContain("target");
  });
});

describe("引擎随生效单位独立", () => {
  it("同一 preset 下的兄弟 scene 是两个实例，唤醒引擎各自一份", async () => {
    built = 0;
    const resolved = resolveProfile(
      ProfileConfig({
        id: "plain",
        presets: {
          base: {
            model: "test:model",
            context: { engine: "standard", standard: { maxChars: 10_000 } },
            wakeup: { engine: "counting" },
            typing: { baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 },
            scenes: {
              rooms: { sid: "onebot:1", whitelist: ["group:*"] },
              dms: { sid: "onebot:1", whitelist: ["private:*"] },
            },
          },
        },
      }),
      "plain",
    );
    expect(resolved.specs.map((spec) => spec.preset)).toEqual(["base", "base"]);

    const rigged = rig(resolved);
    const room = rigged.runtime.route(message("group:2", "a"));
    const dm = rigged.runtime.route(message("private:9", "c"));
    // 两个 scene 是两个生效单位、两个 agent；引擎随实例各造一份，跨实例状态走 shared 池
    expect(room).not.toBe(dm);
    expect(built).toBe(2);

    await teardown(rigged);
  });
});

/** 只实现唤醒引擎用到的那部分 agent：可订阅事实流，并按 agent 的方式往里放消息与轮末事件。 */
function stubAgent() {
  const listeners = new Map<string, (event: AgentEvent) => unknown>();
  const agent = {
    id: "stub",
    channel: {
      subscribe: (_channel: string, callback: (event: AgentEvent) => unknown) => {
        const name = `l${listeners.size}`;
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
  } as unknown as Agent;
  return {
    agent,
    append: (name: string, message: AgentMessage) => listeners.get(name)?.({ type: "message.appended", message }),
    turnDone: (name: string) => listeners.get(name)?.({ type: "turn.done", turnId: "t" }),
  };
}

/** 一条 @ 到位、意愿顶到上限的消息。 */
function at(channelId: string) {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "1",
    channelId,
    isDirect: false,
    messageId: `m-${channelId}`,
    content: '<at id="1"/>在吗',
    user: { id: "42", name: "Miaow" },
  });
}

describe("唤醒记账归谁", () => {
  it("聚合形态：一轮走完，视窗内各频道的意愿值都扣掉回复成本", () => {
    const engine = new ClassicWakeupEngine();
    const { agent, append, turnDone } = stubAgent();
    // 整块视窗挂一次：视窗里出现过哪些频道由事实流自己说明，两个群的账共用一次开口
    engine.attach(agent);

    append("l0", at("group:2"));
    engine.decide(at("group:2"));
    append("l0", at("group:7"));
    engine.decide(at("group:7"));
    expect(engine.score("group:2")).toBe(100);
    expect(engine.score("group:7")).toBe(100);

    turnDone("l0");

    // 一次开口让整块视窗都冷静下来，而不是只扣触发那一轮那个频道
    expect(engine.score("group:2")).toBe(65);
    expect(engine.score("group:7")).toBe(65);
  });

  it("非聚合形态：各频道各记各的，一轮只扣它自己那个频道", () => {
    const engine = new ClassicWakeupEngine();
    const first = stubAgent();
    const second = stubAgent();
    engine.attach(first.agent);
    engine.attach(second.agent);

    first.append("l0", at("group:2"));
    engine.decide(at("group:2"));
    expect(engine.score("group:2")).toBe(100);
    expect(engine.score("group:7")).toBe(0);

    first.turnDone("l0");

    // 只扣触发那一轮所在的那个频道，另一个频道的账分毫未动
    expect(engine.score("group:2")).toBe(65);
    expect(engine.score("group:7")).toBe(0);
  });

  it("拆卸之后这条视窗的账被丢掉，回执也不再落到它头上", () => {
    const engine = new ClassicWakeupEngine();
    const { agent, append, turnDone } = stubAgent();
    const dispose = engine.attach(agent);

    append("l0", at("group:2"));
    engine.decide(at("group:2"));
    expect(engine.score("group:2")).toBe(100);

    dispose();
    expect(engine.score("group:2")).toBe(0);

    // 订阅已经解开：视窗里再来的事与它无关，账也不会再被扣。
    append("l0", at("group:2"));
    engine.decide(at("group:2"));
    turnDone("l0");
    expect(engine.score("group:2")).toBe(100);
  });
});
