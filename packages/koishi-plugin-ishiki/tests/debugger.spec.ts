import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MockLanguageModelV4,
  createCustomMessage,
  simulateReadableStream,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, sleep, type Logger } from "koishi";
import { describe, expect, it } from "vitest";

import Ishiki from "../src/index.js";
import { activateProfiles, loadProfiles, type ProfileRuntime } from "../src/runtime.js";

const logger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** 两个分片的同一条文本流：连起来看是 `好喵`，分开写就是两行。 */
function textStep(): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: "好" },
    { type: "text-delta", id: "text-1", delta: "喵" },
    { type: "text-end", id: "text-1" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
}

function scripted(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (_request: LanguageModelV4CallOptions) => ({ stream: simulateReadableStream({ chunks: textStep() }) }),
  });
}

function message(id: string) {
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

/** 服务实例上的两样私有物：装载出的 profile，以及它们各自记着的开关；运行时读得到。 */
function profilesOf(ctx: Context): ProfileRuntime[] {
  const service: unknown = ctx.get("ishiki");
  if (service === null || typeof service !== "object" || !("profiles" in service)) throw new Error("ishiki service is not mounted");
  const profiles: unknown = service.profiles;
  if (!Array.isArray(profiles)) throw new Error("ishiki service carries no profile list");
  const list: ProfileRuntime[] = profiles;
  return list;
}

function debugStreamOf(profile: ProfileRuntime): boolean {
  const value: unknown = Reflect.get(profile, "debugStream");
  if (typeof value !== "boolean") throw new Error("ProfileRuntime carries no debugStream flag");
  return value;
}

function writePlain(root: string, directory: string): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    [
      "model: test:model",
      "wakeup: { engine: standard, standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } }",
      "scenes:",
      "  dms:",
      "    sid: onebot:1",
      "    whitelist: ['private:9']",
    ].join("\n"),
  );
}

/** 在给定的一段里接管标准输出：这段里写进去的每一行都是被验的对象。 */
async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return text;
}

/** 挂一个实例、走完一轮，把这一轮写到标准输出的东西收回来。 */
async function streamOf(root: Context, debugStream: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-debug-scene-"));
  writePlain(dir, "neko");
  const gateway = { languageModel: () => scripted(), groups: () => [] } as unknown as Gateway;
  const profiles: ProfileRuntime[] = [];
  activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, debugStream, logger });
  await sleep(20);
  const scene = profiles[0]!.route(message("hi"))!;
  const out = await capture(async () => {
    await scene.deliver(message("hi"));
    await scene.idle();
  });
  await Promise.all(profiles.map((profile) => profile.stop()));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

describe("debugStream", () => {
  it("开关从配置一路到实例，打开时 stream 分片连续写出，关闭时一行都不写", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-debug-"));
    writePlain(path.join(dataDir, "profiles"), "neko");
    const root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, debugStream: true, logLevel: 0 });
    await root.start();
    // 装载挂在 ready 上，且要先备好两个 ESM 库；等它落地再读。
    await sleep(500);

    try {
      // 服务那一段：配置里的开关落到 ProfileRuntime 上。
      const profiles = profilesOf(root);
      expect(profiles).toHaveLength(1);
      expect(debugStreamOf(profiles[0]!)).toBe(true);

      // 运行体那一段：真轮次的分片按到达顺序写出来，同一条流接在一起。
      expect(await streamOf(root, true)).toContain("[ishiki:debug] text text-1 > 好喵");
      expect(await streamOf(root, false)).toBe("");
    } finally {
      await root.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
