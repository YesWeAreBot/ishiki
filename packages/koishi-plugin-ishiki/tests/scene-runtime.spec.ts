import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { sleep, type Context, type Logger, type Session } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProfileConfig, resolveProfile } from "../src/profile.js";
import { ProfileRuntime, loadProfiles } from "../src/runtime.js";
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
const gateway = { languageModel: () => model } as unknown as Gateway;
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
