import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { APICallError, MockLanguageModelV4, createCustomMessage, type LanguageModelV4StreamPart, type ProviderV4 } from "@yesimagent/core";
import { createGateway, type Gateway } from "@yesimagent/gateway";
import { sleep, type Context, type Logger, type Session } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProfileConfig, resolveProfile } from "../src/profile.js";
import { ProfileRuntime, loadProfiles, type SceneRuntime } from "../src/runtime.js";
import { StandardHandler } from "../src/session-handler.js";

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
const ctx = { bots: { "onebot:1": { platform: "onebot", selfId: "1" } } } as unknown as Context;

const config = ProfileConfig({
  id: "neko",
  presets: {
    base: {
      model: "test:model",
      context: { engine: "standard", standard: { maxChars: 10_000 } },
      // 不认 @ 也不认引用，于是群里的消息唤不醒它、私聊能。
      wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
    },
  },
  scenes: {
    rooms: { preset: "base", sid: "onebot:1", whitelist: ["group:*"] },
    dms: { preset: "base", sid: "onebot:1", whitelist: ["private:*"] },
  },
});

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
    runtime = new ProfileRuntime({ id: "neko", directory: root, specs: resolveProfile(config, "neko"), ctx, gateway, logger });
  });

  afterAll(async () => {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a scene on demand, one per channel, and reuses it", () => {
    const dm = runtime.route(message("direct", "private:9", "a"));
    expect(dm?.channelId).toBe("private:9");
    expect(runtime.route(message("direct", "private:9", "b"))).toBe(dm);
    expect(runtime.route(message("group", "group:2", "c"))).not.toBe(dm);
  });

  it("wakes on a direct message and keeps the channel's own stream", async () => {
    const dm = runtime.route(message("direct", "private:9", "a"))!;
    dm.deliver(message("direct", "private:9", "a"));
    await dm.idle();

    expect(calls.streams).toBe(1);
    expect(logs.some((line) => line.includes("turn failed"))).toBe(true);
    expect((await dm.storage.read()).some((entry) => entry.type === "message")).toBe(true);
  });

  it("records a message the wakeup rule ignores without waking", async () => {
    const room = runtime.route(message("group", "group:2", "c"))!;
    room.deliver(message("group", "group:2", "c"));
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

  it("reads a channel's lines without creating or waking it", async () => {
    const lines = await runtime.peek("onebot:1", "group:2", 10);
    expect(lines.some((line) => line.includes("#m-c"))).toBe(true);
    // 本 profile 名下、还没说过话的频道：空记录
    expect(await runtime.peek("onebot:1", "private:7", 10)).toEqual([]);
    // 不属于本 profile 的频道：与空记录区分开
    expect(await runtime.peek("other:9", "group:2", 10)).toBeUndefined();
  });

  it("writes an idle stimulus into the target's stream without spending a turn on it", async () => {
    const dm = runtime.route(message("direct", "private:9", "a"))!;
    const report = runtime.dispatch(dm, [{ channelId: "group:2" }], { reason: "想问一句", content: "刚才那边说了什么" });
    expect(report).toEqual({ delivered: 1, refused: [] });

    const room = runtime.route(message("group", "group:2", "c"))!;
    await sleep(20);
    // 只送达不叫醒：落盘是 fire-and-forget 的，落完也不该多花一次模型调用
    expect(calls.streams).toBe(1);
    expect((await room.storage.read()).some((entry) => entry.type === "message" && entry.data.type === "ishiki.inner_stimulus")).toBe(true);
  });

  it("wakes the target only when the stimulus is urgent", async () => {
    const dm = runtime.route(message("direct", "private:9", "a"))!;
    const report = runtime.dispatch(dm, [{ channelId: "group:2" }], { reason: "想问一句", content: "刚才那边说了什么", urgency: "urgent" });
    expect(report).toEqual({ delivered: 1, refused: [] });

    const room = runtime.route(message("group", "group:2", "c"))!;
    await room.idle();
    expect(calls.streams).toBe(2);
  });

  it("mounts an unseen target from its spec: one claim per channel, so no ambiguity is possible", async () => {
    const dm = runtime.route(message("direct", "private:9", "a"))!;
    const report = runtime.dispatch(dm, [{ channelId: "group:77" }], { reason: "r", content: "c" });

    expect(report).toEqual({ delivered: 1, refused: [] });
    const target = runtime.route(message("group", "group:77", "f"))!;
    expect(target.channelId).toBe("group:77");
    // idle 的落盘不跟调用方同步：等它真的写完，别把半成品目录留给收尾
    await vi.waitFor(async () => {
      expect((await target.storage.read()).some((entry) => entry.type === "message")).toBe(true);
    });
  });

  it("refuses a stimulus it cannot address: source channel, disconnected account, unclaimed channel", () => {
    const dm = runtime.route(message("direct", "private:9", "a"))!;

    // 目标频道即来源频道
    expect(runtime.dispatch(dm, [{ channelId: "private:9" }], { reason: "r", content: "c" }).refused[0].error).toContain("source channel");
    // 目标账号不在线
    expect(runtime.dispatch(dm, [{ sid: "other:1", channelId: "x" }], { reason: "r", content: "c" }).delivered).toBe(0);
    // 没有任何 spec 认领的频道
    expect(runtime.dispatch(dm, [{ channelId: "guild:7" }], { reason: "r", content: "c" }).refused[0].error).toContain("not configured");
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
    expect(runtime.route(event!)?.channelId).toBe("private:9");
  });

  it("names each channel directory after the account and the channel", () => {
    expect(readdirSync(path.join(root, "scenes")).sort()).toEqual(["onebot_1_group_2", "onebot_1_group_77", "onebot_1_private_9"]);
  });
});

describe("profile loading", () => {
  let root: string;

  /** 写一份最小 profile.yml。 */
  const writeProfile = (directory: string, id: string | undefined, patterns: string[] = []) => {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(
      path.join(root, directory, "profile.yml"),
      [
        ...(id === undefined ? [] : [`id: ${id}`]),
        "presets:",
        "  base:",
        "    model: test:model",
        "scenes:",
        "  dms:",
        "    preset: base",
        "    sid: onebot:1",
        "    whitelist:",
        ...patterns.map((pattern) => `      - "${pattern}"`),
      ].join("\n"),
    );
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-profiles-"));
    writeProfile("neko", undefined, ["private:*"]);
    mkdirSync(path.join(root, "broken"), { recursive: true });
    writeFileSync(path.join(root, "broken", "profile.yml"), "scenes: [");
    mkdirSync(path.join(root, "dangling"), { recursive: true });
    writeFileSync(
      path.join(root, "dangling", "profile.yml"),
      ["presets:", "  base:", "    model: test:model", "scenes:", "  dms:", "    preset: nowhere", "    sid: onebot:1"].join("\n"),
    );
    mkdirSync(path.join(root, "empty"), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("loads a profile from its directory, using the directory name as a fallback id", () => {
    const profiles = loadProfiles(root, { ctx, gateway, logger });

    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    expect(profiles[0].specs.map((spec) => spec.name)).toEqual(["dms"]);
    expect(profiles[0].specs[0].sid).toBe("onebot:1");
    // 坏掉的目录只跳过它自己：YAML 读不动、没有 profile.yml、preset 悬空，各记一条，其余 profile 照常
    expect(logs.some((line) => line.includes("broken"))).toBe(true);
    expect(logs.some((line) => line.includes("empty"))).toBe(true);
    expect(logs.some((line) => line.includes("unknown preset"))).toBe(true);
  });

  it("keeps a profile whose scene lists no channel: it simply claims nothing", () => {
    const none = mkdtempSync(path.join(os.tmpdir(), "ishiki-none-"));
    mkdirSync(path.join(none, "idle"), { recursive: true });
    writeFileSync(
      path.join(none, "idle", "profile.yml"),
      ["presets:", "  base:", "    model: test:model", "scenes:", "  dms:", "    preset: base", "    sid: onebot:1"].join("\n"),
    );

    const profiles = loadProfiles(none, { ctx, gateway, logger });
    expect(profiles[0].specs).toHaveLength(1);
    expect(profiles[0].route(message("direct", "private:9", "a"))).toBeUndefined();

    rmSync(none, { recursive: true, force: true });
  });

  it("loads overlapping profiles instead of proving channel ownership", () => {
    const clutter = mkdtempSync(path.join(os.tmpdir(), "ishiki-clash-"));
    const write = (directory: string, id: string) => {
      mkdirSync(path.join(clutter, directory), { recursive: true });
      writeFileSync(
        path.join(clutter, directory, "profile.yml"),
        [
          `id: ${id}`,
          "presets:",
          "  base:",
          "    model: test:model",
          "scenes:",
          "  dms:",
          "    preset: base",
          "    sid: onebot:1",
          "    whitelist:",
          "      - '*'",
        ].join("\n"),
      );
    };

    write("a", "same");
    write("b", "other");

    const profiles = loadProfiles(clutter, { ctx, gateway, logger });
    expect(profiles.map((profile) => profile.id).sort()).toEqual(["other", "same"]);
    // 两个 profile 都认领同一频道：谁接管由派发顺序决定，加载期不再判冲突
    const event = message("group", "group:2", "clash");
    expect(profiles.filter((profile) => profile.route(event) !== undefined)).toHaveLength(2);

    rmSync(clutter, { recursive: true, force: true });
  });
});

/** 按给定配置展开出 spec 的 typing，用来验算预设与覆写的优先级。 */
function resolveTyping(typing?: Record<string, number>, sceneTyping?: Record<string, number>) {
  return resolveProfile(
    ProfileConfig({
      presets: { base: { model: "m", ...(typing === undefined ? {} : { typing }) } },
      scenes: { s: { preset: "base", sid: "onebot:1", ...(sceneTyping === undefined ? {} : { typing: sceneTyping }) } },
    } as never),
    "p",
  )[0].typing;
}

describe("typing config", () => {
  it("fills the preset's unwritten fields and falls back to the built-in defaults", () => {
    expect(resolveTyping({ baseDelay: 1 })).toEqual({ baseDelay: 1, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
    expect(resolveTyping()).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("lets a scene override single fields without wiping the preset", () => {
    // scene 里的 typing 是局部覆写：没写的字段必须留在 preset 的值上
    expect(resolveTyping({ baseDelay: 100, charPerSecond: 7, minDelay: 300, maxDelay: 900 }, { charPerSecond: 12 })).toEqual({
      baseDelay: 100,
      charPerSecond: 12,
      minDelay: 300,
      maxDelay: 900,
    });
    expect(resolveTyping(undefined, { minDelay: 50 })).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 50, maxDelay: 4000 });
  });
});

/** 按给定配置展开出 spec 的 failover，用来验算预设与覆写的优先级。 */
function resolveFailover(failover?: Record<string, unknown>, sceneFailover?: Record<string, unknown>) {
  return resolveProfile(
    ProfileConfig({
      presets: { base: { model: "m", ...(failover === undefined ? {} : { failover }) } },
      scenes: { s: { preset: "base", sid: "onebot:1", ...(sceneFailover === undefined ? {} : { failover: sceneFailover }) } },
    } as never),
    "p",
  )[0].failover;
}

describe("failover config", () => {
  it("都没写时：跑完一轮候选，500ms 起退避，只在端点不可用时换人", () => {
    expect(resolveFailover()).toEqual({ backoffMs: 500, failoverOn: "unavailable" });
  });

  it("scene 只写一个字段，不动 preset 的其余字段", () => {
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
async function said(scene: SceneRuntime): Promise<string> {
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
function gatewayOf(first: MockLanguageModelV4, second: MockLanguageModelV4): Gateway {
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
function runtimeOf(directory: string, model: string, gateway: Gateway, failover?: Record<string, unknown>): ProfileRuntime {
  const specs = resolveProfile(
    ProfileConfig({
      id: "failover",
      presets: {
        base: {
          model,
          ...(failover === undefined ? {} : { failover }),
          context: { engine: "standard", standard: { maxChars: 10_000 } },
          wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } },
        },
      },
      scenes: { dms: { preset: "base", sid: "onebot:1", whitelist: ["private:*"] } },
    }),
    "failover",
  );
  return new ProfileRuntime({ id: "failover", directory, specs, ctx, gateway, logger });
}

describe("failover wiring", () => {
  it("model 是组名时第一个候选失败由第二个顶上；普通引用没有这一层", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ishiki-failover-"));
    const gateway = gatewayOf(endpoint(true), endpoint(false));
    const mark = logs.length;

    const group = runtimeOf(root, "fast", gateway);
    const served = group.route(message("direct", "private:11", "f1"))!;
    served.deliver(message("direct", "private:11", "f1"));
    await served.idle();

    expect(await said(served)).toBe("在");
    expect(logs.slice(mark).some((line) => line.includes("turn failed"))).toBe(false);

    // 普通引用不进组：同一个端点坏了，这一轮就是坏的
    const plain = runtimeOf(root, "a:m", gateway);
    const alone = plain.route(message("direct", "private:12", "f2"))!;
    alone.deliver(message("direct", "private:12", "f2"));
    await alone.idle();

    expect(await said(alone)).toBe("");
    expect(logs.slice(mark).some((line) => line.includes("turn failed"))).toBe(true);

    await group.stop();
    await plain.stop();
    rmSync(root, { recursive: true, force: true });
  });

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

  it("单候选配了 attempts：线上那种连不上端点，重试一次就救回来了", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ishiki-failover-"));
    // 模型是普通引用、组里只有它一个成员：没有第二个人可换，靠的是同一个端点重试。
    const gateway = gatewayOf(flakyEndpoint(1), endpoint(false));
    const runtime = runtimeOf(root, "a:m", gateway, { attempts: 2, backoffMs: 1 });

    const scene = runtime.route(message("direct", "private:21", "f3"))!;
    scene.deliver(message("direct", "private:21", "f3"));
    await scene.idle();

    expect(await said(scene)).toBe("在");

    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });
});
