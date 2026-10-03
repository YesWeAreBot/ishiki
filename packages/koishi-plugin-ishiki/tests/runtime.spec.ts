import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { APICallError, MockLanguageModelV4, createCustomMessage, type LanguageModelV4StreamPart, type ProviderV4 } from "@yesimagent/core";
import { createGateway, type Gateway } from "@yesimagent/gateway";
import { Context, sleep, type Logger, type Session } from "koishi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StandardContextEngine } from "../src/context/standard.engine.js";
import { resolveProfile } from "../src/profile.js";
import { ProfileRuntime, loadProfiles, type AgentRuntime } from "../src/runtime.js";
import { StandardHandler } from "../src/session-handler.js";
import { NativeToolcallEngine } from "../src/toolcall/native.engine.js";
import { StandardWakeupEngine } from "../src/wakeup/standard.engine.js";

const logs: string[] = [];
const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: (message: string) => logs.push(`warn ${message}`),
  error: (message: string) => logs.push(`error ${message}`),
} as unknown as Logger;

const calls = { streams: 0 };
const model = new MockLanguageModelV4({
  doStream: async () => {
    calls.streams += 1;
    throw new Error("这个用例不跑真流");
  },
});
const gateway = { languageModel: () => model, groups: () => [] } as unknown as Gateway;

/**
 * 静音 AI SDK 的 `onError`：它缺省是 `console.error`，会把用例故意制造的模型错误原样打进 stderr。
 * core 的 `settings` 只透传 `LanguageModelCallOptions`（不含 onError），内核没有干净的接缝——
 * 同一份失败已经由 `turn failed` 走 logger 断言过一次，不必再让它占满输出。
 */
function muteSdkErrors(): () => void {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
}

// 引擎 provider 立在这台 ctx 上：运行时只按服务名取用，用例给的就是真服务。
// toolcall 用 profile 的缺省（native），所以它也在这里。
const ctx = new Context();
new StandardContextEngine(ctx);
new StandardWakeupEngine(ctx);
new NativeToolcallEngine(ctx);

// provider 在 ready 时登记：先启动，运行时的按名取用才有东西可取。
beforeAll(async () => {
  await ctx.start();
});

/** 装载并实例化：测试直连生产里的「宿主 + 逐个 profile fiber」两步——解析出可装载项，再逐个激活。 */
function load(root: string): ProfileRuntime[] {
  return loadProfiles(root, logger).map(
    (item) => new ProfileRuntime({ id: item.id, root: item.root, specs: item.specs, extensions: item.extensions, ctx, gateway, debugStream: false, logger }),
  );
}

const config = {
  model: "test:model",
  context: { engine: "standard", standard: { maxTokens: 10_000 } },
  // 不认 @ 也不认引用，于是群里的消息唤不醒它、私聊能。
  wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
  scenes: {
    rooms: { sid: "onebot:1", whitelist: ["group:*"] },
    dms: { sid: "onebot:1", whitelist: ["private:*"] },
  },
};

function message(kind: "direct" | "group", channelId: string, id: string, selfId = "1") {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId,
    channelId,
    isDirect: kind === "direct",
    messageId: `m-${id}`,
    content: id,
    user: { id: "42", name: "Miaow" },
  });
}

describe("profile runtime", () => {
  let root: string;
  let runtime: ProfileRuntime;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-runtime-"));
    const resolved = resolveProfile(config, "neko");
    runtime = new ProfileRuntime({ id: resolved.id, root, specs: resolved.specs, extensions: resolved.extensions, ctx, gateway, debugStream: false, logger });
  });

  afterAll(async () => {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a scene on demand, one per channel, and reuses it", () => {
    const dm = runtime.route(message("direct", "private:9", "a"));
    // 坐标在 domain 上：非聚合形态就是那一个频道。
    expect(dm?.domain).toEqual({ form: "channel", platform: "onebot", selfId: "1", channelId: "private:9" });
    expect(runtime.route(message("direct", "private:9", "b"))).toBe(dm);
    expect(runtime.route(message("group", "group:2", "c"))).not.toBe(dm);
  });

  it("wakes on a direct message and keeps the channel's own stream", async () => {
    // 这个桩模型只抛错：轮次失败是本用例要断言的现象，SDK 那份 stderr 回显不必跟着看。
    const unmute = muteSdkErrors();
    const dm = runtime.route(message("direct", "private:9", "a"))!;
    try {
      await dm.deliver(message("direct", "private:9", "a"));
      await dm.idle();

      expect(calls.streams).toBe(1);
      expect(logs.some((line) => line.includes("turn failed"))).toBe(true);
      expect((await dm.storage.read()).some((entry) => entry.type === "message")).toBe(true);
    } finally {
      unmute();
    }
  });

  it("records a message the wakeup rule ignores without waking", async () => {
    const room = runtime.route(message("group", "group:2", "c"))!;
    await room.deliver(message("group", "group:2", "c"));
    await sleep(20);

    expect(calls.streams).toBe(1);
    expect((await room.storage.read()).some((entry) => entry.type === "message")).toBe(true);
  });

  it("claims nothing for another account", () => {
    expect(runtime.route(message("group", "group:2", "d", "9"))).toBeUndefined();
  });

  it("claims nothing for an unlisted channel", () => {
    expect(runtime.route(message("group", "guild:7", "e"))).toBeUndefined();
  });

  it("toolcall 变体缺席就抛错，不退回内置的 native", () => {
    const resolved = resolveProfile(
      {
        model: "test:model",
        toolcall: { engine: "neko-tools/absent" },
        scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } },
      },
      "neko",
    );
    const missing = new ProfileRuntime({
      id: resolved.id,
      root,
      specs: resolved.specs,
      extensions: resolved.extensions,
      ctx,
      gateway,
      debugStream: false,
      logger,
    });

    // 这台 ctx 上注册着 native 与其余内置变体，唯独没有这个社区变体。
    expect(() => missing.route(message("direct", "private:88", "absent"))).toThrow(/ishiki\.engine\.toolcall\.neko-tools\/absent/);
  });

  it("takes a platform session all the way to its scene", () => {
    const session = {
      type: "message-created",
      timestamp: Date.now(),
      platform: "onebot",
      selfId: "1",
      channelId: "private:9",
      isDirect: true,
      messageId: "m-session",
      content: "在吗",
      userId: "42",
      author: { nick: "Miaow" },
    } as unknown as Session;

    const event = new StandardHandler().handle(session);
    expect(event?.type).toBe("ishiki.message.created");
    expect(event?.type === "ishiki.message.created" && event.data.isDirect).toBe(true);
    expect(runtime.route(event!)?.domain).toEqual({ form: "channel", platform: "onebot", selfId: "1", channelId: "private:9" });
  });

  it("names each channel directory after the account and the channel", () => {
    expect(readdirSync(path.join(root, "scenes")).sort()).toEqual(["onebot_1_group_2", "onebot_1_private_9"]);
  });
});

describe("profile loading", () => {
  let root: string;

  /** 写一份最小 profile.yml。 */
  const writeProfile = (directory: string, patterns: string[] = []) => {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(
      path.join(root, directory, "profile.yml"),
      ["model: test:model", "scenes:", "  dms:", "    sid: onebot:1", "    whitelist:", ...patterns.map((pattern) => `      - "${pattern}"`)].join("\n"),
    );
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-profiles-"));
    writeProfile("neko", ["private:*"]);
    mkdirSync(path.join(root, "broken"), { recursive: true });
    writeFileSync(path.join(root, "broken", "profile.yml"), "scenes: [");
    mkdirSync(path.join(root, "dangling"), { recursive: true });
    // 有 model 却没有 scenes 又不声明 cross：整份目录跳过
    writeFileSync(path.join(root, "dangling", "profile.yml"), "model: test:model");
    mkdirSync(path.join(root, "empty"), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("loads a profile from its directory, using the directory name as its id", () => {
    const items = loadProfiles(root, logger);
    const neko = items.find((item) => item.id === "neko")!;

    expect(neko.specs.map((spec) => spec.name)).toEqual(["dms"]);
    expect(neko.specs[0]!.sid).toBe("onebot:1");
    // 坏掉的目录只跳过它自己：YAML 读不动、缺 scenes、没有 profile.yml 各记一条，其余 profile 照常
    expect(items.map((item) => item.id)).toEqual(["neko"]);
    expect(logs.some((line) => line.includes("broken"))).toBe(true);
    expect(logs.some((line) => line.includes("empty"))).toBe(true);
    expect(logs.some((line) => line.includes("is not cross"))).toBe(true);
  });

  it("keeps a profile whose scene lists no channel: it simply claims nothing", () => {
    const none = mkdtempSync(path.join(os.tmpdir(), "ishiki-none-"));
    mkdirSync(path.join(none, "idle"), { recursive: true });
    writeFileSync(path.join(none, "idle", "profile.yml"), ["model: test:model", "scenes:", "  dms:", "    sid: onebot:1", "    whitelist: []"].join("\n"));

    const [item] = loadProfiles(none, logger);
    expect(item!.specs).toHaveLength(1);

    const profiles = load(none);
    expect(profiles[0]!.route(message("direct", "private:9", "a"))).toBeUndefined();

    rmSync(none, { recursive: true, force: true });
  });

  it("skips a profile whose channel another profile already claims", () => {
    const clutter = mkdtempSync(path.join(os.tmpdir(), "ishiki-clash-"));
    const write = (directory: string) => {
      mkdirSync(path.join(clutter, directory), { recursive: true });
      writeFileSync(
        path.join(clutter, directory, "profile.yml"),
        ["model: test:model", "scenes:", "  dms:", "    sid: onebot:1", "    whitelist:", "      - '*'"].join("\n"),
      );
    };

    write("a");
    write("b");

    const mark = logs.length;
    // 目录名排序在前的是 a：频道先归它；b 撞同一频道，加载期整体跳过
    const items = loadProfiles(clutter, logger);
    expect(items.map((item) => item.id)).toEqual(["a"]);
    expect(logs.slice(mark).some((line) => line.includes("profile skipped"))).toBe(true);

    rmSync(clutter, { recursive: true, force: true });
  });

  it("skips a profile whose own two scenes claim the same channel", () => {
    const self = mkdtempSync(path.join(os.tmpdir(), "ishiki-self-clash-"));
    mkdirSync(path.join(self, "neko"), { recursive: true });
    writeFileSync(
      path.join(self, "neko", "profile.yml"),
      [
        "model: test:model",
        "scenes:",
        "  a:",
        "    sid: onebot:1",
        "    whitelist:",
        "      - 'group:*'",
        "  b:",
        "    sid: onebot:1",
        "    whitelist:",
        "      - 'group:1'",
      ].join("\n"),
    );

    const mark = logs.length;
    expect(loadProfiles(self, logger)).toEqual([]);
    expect(logs.slice(mark).some((line) => line.includes("profile skipped"))).toBe(true);

    rmSync(self, { recursive: true, force: true });
  });
});

/** 按给定配置展开出 spec 的 typing，用来验算 profile 与 scene 覆写的优先级。 */
function resolveTyping(typing?: Record<string, number>, sceneTyping?: Record<string, number>) {
  return resolveProfile(
    {
      model: "m",
      ...(typing === undefined ? {} : { typing }),
      scenes: { s: { sid: "onebot:1", whitelist: ["private:*"], ...(sceneTyping === undefined ? {} : { typing: sceneTyping }) } },
    },
    "p",
  ).specs[0]!.typing;
}

describe("typing config", () => {
  it("fills the profile's unwritten fields and falls back to the built-in defaults", () => {
    expect(resolveTyping({ baseDelay: 1 })).toEqual({ baseDelay: 1, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
    expect(resolveTyping()).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("lets a scene override single fields without wiping the profile", () => {
    // scene 里的 typing 是局部覆写：没写的字段必须留在 profile 的值上
    expect(resolveTyping({ baseDelay: 100, charPerSecond: 7, minDelay: 300, maxDelay: 900 }, { charPerSecond: 12 })).toEqual({
      baseDelay: 100,
      charPerSecond: 12,
      minDelay: 300,
      maxDelay: 900,
    });
    expect(resolveTyping(undefined, { minDelay: 50 })).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 50, maxDelay: 4000 });
  });
});

/** 按给定配置展开出 spec 的 failover，用来验算 profile 与 scene 覆写的优先级。 */
function resolveFailover(failover?: Record<string, unknown>, sceneFailover?: Record<string, unknown>) {
  return resolveProfile(
    {
      model: "m",
      ...(failover === undefined ? {} : { failover }),
      scenes: { s: { sid: "onebot:1", whitelist: ["private:*"], ...(sceneFailover === undefined ? {} : { failover: sceneFailover }) } },
    },
    "p",
  ).specs[0]!.failover;
}

describe("failover config", () => {
  it("都没写时：跑完一轮候选，500ms 起退避，只在端点不可用时换人", () => {
    expect(resolveFailover()).toEqual({ backoffMs: 500, failoverOn: "unavailable" });
  });

  it("scene 只写一个字段，不动 profile 的其余字段", () => {
    expect(resolveFailover({ attempts: 3 }, { backoffMs: 100 })).toEqual({ attempts: 3, backoffMs: 100, failoverOn: "unavailable" });
    expect(resolveFailover(undefined, { failoverOn: "any" })).toEqual({ backoffMs: 500, failoverOn: "any" });
  });
});

/** 合法的 v4 用量：字段齐全，值都是 0。 */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** 一段最小作答：正文加收尾。 */
function textStream(text: string): ReadableStream<LanguageModelV4StreamPart> {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** 存储里 assistant 说过的正文。 */
async function said(scene: AgentRuntime): Promise<string> {
  const entries = await scene.storage.read();
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.data)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 一台桩端点：`fail` 的整次调用就失败。 */
const endpoint = (fail: boolean) =>
  new MockLanguageModelV4({
    provider: "stub",
    modelId: "m",
    doStream: async () => {
      if (fail) throw new Error("这台端点挂了");
      return { stream: textStream("在") };
    },
  });

/** 真网关加桩端点：候选顺序与熔断走 gateway 自己的代码。 */
function makeGateway(first: MockLanguageModelV4, second: MockLanguageModelV4): Gateway {
  return createGateway({
    config: {
      providers: {
        a: { api: "stub", apiKey: "unused", models: [{ id: "m" }] },
        b: { api: "stub", apiKey: "unused", models: [{ id: "m" }] },
      },
      groups: { fast: { strategy: "failover", models: ["a:m", "b:m"], circuitBreaker: { failureThreshold: 9, cooldownSeconds: 60 } } },
    },
    apis: {
      stub: (setup) => {
        // 桩端点只伺候 languageModel；另两个接口用不到，直接抛，不假装能返回。
        const provider: ProviderV4 = {
          specificationVersion: "v4",
          languageModel: () => (setup.id === "a" ? first : second),
          embeddingModel: () => {
            throw new Error("这台桩端点不管 embedding");
          },
          imageModel: () => {
            throw new Error("这台桩端点不管 image");
          },
        };
        return provider;
      },
    },
  });
}

/** 一份最小 profile：私聊能唤醒，模型与降级配置由参数给。 */
function makeRuntime(directory: string, model: string, gateway: Gateway, failover?: Record<string, unknown>): ProfileRuntime {
  const resolved = resolveProfile(
    {
      model,
      ...(failover === undefined ? {} : { failover }),
      context: { engine: "standard", standard: { maxTokens: 10_000 } },
      wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
      scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } },
    },
    "failover",
  );
  return new ProfileRuntime({
    id: resolved.id,
    root: directory,
    specs: resolved.specs,
    extensions: resolved.extensions,
    ctx,
    gateway,
    debugStream: false,
    logger,
  });
}

/** 一台会抖的端点：前 `failTimes` 次调用连不上，之后照常作答。 */
const flakyEndpoint = (failTimes: number) => {
  let calls = 0;
  return new MockLanguageModelV4({
    provider: "stub",
    modelId: "m",
    doStream: async () => {
      calls += 1;
      if (calls <= failTimes) {
        // 线上那一次的形状：连不上端点，没有 statusCode，`isRetryable` 为 true。
        throw new APICallError({
          message: "Cannot connect to API: ",
          url: "https://stub.invalid/v1/models/m:streamGenerateContent?alt=sse",
          requestBodyValues: {},
          isRetryable: true,
          cause: new Error("connect ETIMEDOUT"),
        });
      }
      return { stream: textStream("在") };
    },
  });
};

describe("failover wiring", () => {
  it("model 是组名时第一个候选失败由第二个顶上；普通引用没有这一层", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ishiki-failover-"));
    const gateway = makeGateway(endpoint(true), endpoint(false));
    const mark = logs.length;
    // 后半段的普通引用会真的失败一次，那份 stderr 回显同 `turn failed` 断言重复。
    const unmute = muteSdkErrors();

    try {
      const group = makeRuntime(root, "fast", gateway);
      const served = group.route(message("direct", "private:11", "f1"))!;
      await served.deliver(message("direct", "private:11", "f1"));
      await served.idle();

      expect(await said(served)).toBe("在");
      expect(logs.slice(mark).some((line) => line.includes("turn failed"))).toBe(false);

      // 普通引用不进组：同一个端点坏了，这一轮就是坏的
      const plain = makeRuntime(root, "a:m", gateway);
      const alone = plain.route(message("direct", "private:12", "f2"))!;
      await alone.deliver(message("direct", "private:12", "f2"));
      await alone.idle();

      expect(await said(alone)).toBe("");
      expect(logs.slice(mark).some((line) => line.includes("turn failed"))).toBe(true);

      await group.stop();
      await plain.stop();
      rmSync(root, { recursive: true, force: true });
    } finally {
      unmute();
    }
  });

  it("单候选配了 attempts：线上那种连不上端点，重试一次就救回来了", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ishiki-failover-"));
    // 模型是普通引用、组里只有它一个成员：没有第二个人可换，靠的是同一个端点重试。
    const gateway = makeGateway(flakyEndpoint(1), endpoint(false));
    const runtime = makeRuntime(root, "a:m", gateway, { attempts: 2, backoffMs: 1 });

    const scene = runtime.route(message("direct", "private:21", "f3"))!;
    await scene.deliver(message("direct", "private:21", "f3"));
    await scene.idle();

    expect(await said(scene)).toBe("在");

    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });
});
