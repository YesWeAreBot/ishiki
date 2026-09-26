import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4, createCustomMessage, createEntry } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { sleep, type Context, type Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { renderLine, StandardContextEngine } from "../src/context/index.js";
import { FootprintIndex, FOOTPRINT_WINDOW_MS, HOT_TRANSFER_WINDOW_MS } from "../src/footprint.js";
import { ProfileConfig, resolveProfile } from "../src/profile.js";
import { ProfileRuntime } from "../src/runtime.js";

const logger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

// 轮次必然失败（不跑真流），但消息条目与装配行为照常发生，与既有 scene-runtime.spec 一致。
const model = new MockLanguageModelV4({
  doStream: async () => {
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
      // 私聊必醒；群聊只认关键词，用来构造 interacted=true 的足迹。
      wakeup: { engine: "standard", standard: { direct: true, atSelf: false, quoteSelf: false, keywords: ["猫猫"] } },
    },
  },
  scenes: {
    rooms: { preset: "base", sid: "onebot:1", whitelist: ["group:*"] },
    dms: { preset: "base", sid: "onebot:1", whitelist: ["private:*"] },
  },
});

function message(kind: "direct" | "group", channelId: string, id: string, at = Date.now(), userId = "42") {
  return createCustomMessage("ishiki.message.created", {
    timestamp: at,
    platform: "onebot",
    selfId: "1",
    channelId,
    isDirect: kind === "direct",
    messageId: `m-${id}`,
    content: id,
    user: { id: userId, name: "Miaow" },
  });
}

function streamOf(root: string, needle: string): string {
  const dir = readdirSync(path.join(root, "scenes")).find((name) => name.includes(needle));
  expect(dir).toBeDefined();
  return readFileSync(path.join(root, "scenes", dir!, "events.jsonl"), "utf8");
}

describe("FootprintIndex", () => {
  it("records the latest scene per user and drops stale entries on lookup", () => {
    const index = new FootprintIndex();
    const now = Date.now();

    index.record("42", { sid: "onebot:1", channelId: "group:2", timestamp: now }, true);
    expect(index.lookup("42", FOOTPRINT_WINDOW_MS, now)!.channelId).toBe("group:2");

    // 覆盖：最近的场景顶掉旧的
    index.record("42", { sid: "onebot:1", channelId: "private:9", timestamp: now }, false);
    expect(index.lookup("42", FOOTPRINT_WINDOW_MS, now + 1)!.channelId).toBe("private:9");

    // 过期：最后一次记录超出窗口后不再命中
    expect(index.lookup("42", FOOTPRINT_WINDOW_MS, now + FOOTPRINT_WINDOW_MS + 1)).toBeUndefined();
  });

  it("hot transfer only fires from a recent group interaction, never from a dm source", () => {
    const index = new FootprintIndex();
    const now = Date.now();

    // 群聊互动 → 命中
    index.record("42", { sid: "onebot:1", channelId: "group:2", timestamp: now }, true);
    expect(index.hotTransfer("42", now + 1000)!.channelId).toBe("group:2");

    // 没互动过 → 不挂载
    index.record("43", { sid: "onebot:1", channelId: "group:2", timestamp: now }, false);
    expect(index.hotTransfer("43", now + 1000)).toBeUndefined();

    // 源是私聊 → 不挂载（私聊内容不进任何别处）
    index.record("44", { sid: "onebot:1", channelId: "private:9", timestamp: now }, true);
    expect(index.hotTransfer("44", now + 1000)).toBeUndefined();

    // 超出热迁移窗口 → 不挂载
    index.record("45", { sid: "onebot:1", channelId: "group:2", timestamp: now }, true);
    expect(index.hotTransfer("45", now + HOT_TRANSFER_WINDOW_MS + 1)).toBeUndefined();
  });
});

describe("cross-scene wiring in ProfileRuntime", () => {
  let root: string;
  let runtime: ProfileRuntime;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ishiki-footprint-"));
    runtime = new ProfileRuntime({ id: "neko", directory: root, specs: resolveProfile(config, "neko"), ctx, gateway, logger });
  });

  afterAll(async () => {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("mounts group context on a dm scene after a keyword interaction, and never writes it to disk", async () => {
    const now = Date.now();
    // 群聊关键词互动：触发一轮（轮次失败无妨），足迹记为 interacted=true，落盘可供 peek。
    const room = runtime.route(message("group", "group:2", "猫猫在吗", now - 60_000))!;
    room.deliver(message("group", "group:2", "猫猫在吗", now - 60_000));
    await room.idle();

    // 用户跳进私聊：route 时应完成热迁移判定并挂上易失前情。
    const dm = runtime.route(message("direct", "private:9", "在吗", now))!;
    await vi.waitFor(() => {
      expect((dm as unknown as { pendingCross?: unknown }).pendingCross).toBeDefined();
    });
    expect((dm as unknown as { pendingCross: { channelId: string } }).pendingCross.channelId).toBe("group:2");

    // 投递后装配消费：挂载只存在一次，且不落盘。
    dm.deliver(message("direct", "private:9", "在吗", now));
    await dm.idle();

    const dmStream = streamOf(root, "private_9");
    expect(dmStream).not.toContain("cross_scene_context");
    expect(dmStream).toContain("在吗");
    expect(streamOf(root, "group_2")).toContain("猫猫在吗");
  });

  it("leaves no footprint trace when the user never interacted in a group", async () => {
    const now = Date.now();
    // 群消息不含关键词：唤醒不触发，足迹 interacted=false。
    const room = runtime.route(message("group", "group:3", "天气不错", now - 60_000, "77"))!;
    room.deliver(message("group", "group:3", "天气不错", now - 60_000, "77"));
    await sleep(30);

    const dm = runtime.route(message("direct", "private:8", "在吗", now, "77"))!;
    expect((dm as unknown as { pendingCross?: unknown }).pendingCross).toBeUndefined();
  });
});

describe("engine-level volatile mount", () => {
  it("mounts the cross context once at assembly time, then it is gone", async () => {
    let pending: { channelId: string; elapsedMs: number; lines: readonly string[] } | undefined = {
      channelId: "group:2",
      elapsedMs: 120_000,
      lines: ["[14:00] Miaow(42) #m-1: 刚刚那个方案", "[14:01] Neko(1) #m-2: 倾向方案 A"],
    };
    const engine = new StandardContextEngine({
      logger,
      pullCrossContext: () => {
        const take = pending;
        pending = undefined;
        return take;
      },
    });
    engine.init({ storage: { read: async () => [], append: async () => undefined } } as never);

    const first = await engine.transformEntries([createEntry("message", message("direct", "private:9", "在吗"))]);
    const text = JSON.stringify(first);
    expect(text).toContain("cross_scene_context");
    expect(text).toContain("倾向方案 A");
    expect(text).toContain(String.raw`channel=\"group:2\"`);

    // 第二次装配：已取走，不再出现
    const second = await engine.transformEntries([createEntry("message", message("direct", "private:9", "还在吗"))]);
    expect(JSON.stringify(second)).not.toContain("cross_scene_context");
  });
});

describe("footprint hint rendering", () => {
  it("appends an activity hint to message lines from another channel", async () => {
    const index = new FootprintIndex();
    const now = Date.now();
    index.record("42", { sid: "onebot:1", channelId: "group:2", timestamp: now - 5 * 60_000 }, true);

    const hint = (userId: string, currentChannelId: string): string | undefined => {
      const hit = index.lookup(userId);
      if (hit === undefined || hit.channelId === currentChannelId) return undefined;
      return `${Math.max(1, Math.round((now - hit.timestamp) / 60_000))}分钟前在频道 ${hit.channelId} 活跃过`;
    };

    // 同频道：不给线索
    expect(renderLine(message("group", "group:2", "在吗", now), hint)).not.toContain("<!--");
    // 异频道：行尾带线索
    const line = renderLine(message("direct", "private:9", "在吗", now), hint);
    expect(line).toContain("<!--");
    expect(line).toContain("group:2");
  });
});
