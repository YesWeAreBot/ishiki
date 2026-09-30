import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MockLanguageModelV4,
  createCustomMessage,
  jsonSchema,
  simulateReadableStream,
  tool,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, Service, sleep, type Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Extension, ExtensionCoords } from "../src/extension.js";
import Ishiki from "../src/index.js";
import { activateProfiles, loadProfiles, type ProfileRuntime } from "../src/runtime.js";

// ── 社区扩展包 ──

/** 内核实际交出去的坐标：断言落在装配点给出的事实上。 */
const calls: ExtensionCoords[] = [];
/** 这个包这次怎么回答：加东西，还是说这个实例用不上我。 */
let answering: "add" | "decline" = "add";
/** 贡献的工具名；撞名用例把它改成内核工具名。 */
let probeName = "neko_probe";

/**
 * 一个只做加法的扩展包：在 `ishiki.ext.neko-tools` 服务上暴露 `extend`。
 * 每次调用生成新的插件对象——cordis 对同一个插件对象重复 apply 会判重。
 */
function extensionPackage() {
  return function nekoTools(ctx: Context) {
    class NekoTools extends Service {
      constructor(c: Context) {
        super(c, "ishiki.ext.neko-tools");
      }

      extend(coords: ExtensionCoords): Extension | undefined {
        calls.push(coords);
        if (answering === "decline") return undefined;
        return {
          tools: {
            [probeName]: tool({
              description: "探测",
              inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
              execute: async () => "ok",
            }),
          },
          instructions: "本实例启用了 neko-tools。",
        };
      }
    }
    new NekoTools(ctx);
  };
}

// ── 测试装配台 ──

const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
}

/** 一个按脚本作答的模型，并把每轮实际送进模型的提示词与工具目录留下来：装配成了什么样只能从这两样上验。 */
function scripted(prompts: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (request: LanguageModelV4CallOptions) => {
      prompts.push(JSON.stringify({ prompt: request.prompt, tools: request.tools ?? [] }));
      return { stream: simulateReadableStream({ chunks: textStep("好") }) };
    },
  });
}

/** 该轮送给模型的工具目录。 */
function toolCatalog(prompts: string[]): string[] {
  const tools: LanguageModelV4FunctionTool[] = JSON.parse(prompts.at(-1) ?? "{}").tools;
  return tools.map((entry) => entry.name);
}

/** 该轮送进模型的全部文本：系统提示词与事实行都在里面。 */
function promptText(prompts: string[]): string {
  const prompt: LanguageModelV4Prompt = JSON.parse(prompts.at(-1) ?? "{}").prompt;
  return prompt
    .flatMap((message) => (typeof message.content === "string" ? [message.content] : message.content.map((part) => (part.type === "text" ? part.text : ""))))
    .join("\n");
}

function message(channelId: string, id: string, selfId = "1") {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId,
    channelId,
    isDirect: channelId.startsWith("private:"),
    messageId: `m-${id}`,
    content: id,
    user: { id: "42", name: "Miaow" },
  });
}

/** 普通 preset：一频道一实例，认领一个私聊。 */
function writePlain(root: string, directory: string, id: string, withPackage: boolean): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    [
      `id: ${id}`,
      "presets:",
      "  chat:",
      "    model: test:model",
      ...(withPackage ? ["    extends: [neko-tools]"] : []),
      "    wakeup: { engine: standard, standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } }",
      "    scenes:",
      "      dms:",
      "        sid: onebot:1",
      "        whitelist: ['private:9']",
    ].join("\n"),
  );
}

/** 聚合 preset：preset 自身即生效单位，claims 认领两个账号下的频道。 */
function writeCross(root: string, directory: string, id: string, withPackage: boolean): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    [
      `id: ${id}`,
      "presets:",
      "  lounge:",
      "    model: test:model",
      "    cross: true",
      ...(withPackage ? ["    extends: [neko-tools]"] : []),
      "    wakeup: { engine: standard, standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } }",
      "    claims:",
      '      "onebot:1": { whitelist: ["private:9", "group:2"] }',
      '      "onebot:2": { whitelist: ["group:7"] }',
    ].join("\n"),
  );
}

interface Stand {
  prompts: string[];
  profiles: ProfileRuntime[];
  /** 摘掉扩展包：fiber 复位，装载出的 profile 一并停止。 */
  dispose: () => void;
}

/** 收尾：先让在飞的落盘落地，再停实例、摘包、扔目录。 */
async function close(rig: Stand, dir: string): Promise<void> {
  await sleep(20);
  await Promise.all(rig.profiles.map((profile) => profile.stop()));
  rig.dispose();
  rmSync(dir, { recursive: true, force: true });
}

describe("扩展包的贡献物：装配点、形态与准入", () => {
  let dataDir: string;
  let root: Context;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-"));
    // 服务自己的 profiles 目录留空：这个用例自己装载、自己实例化。
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, logLevel: 0 });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** 一份装配台：装好扩展包、装载 profile、备好记录提示词的模型。 */
  async function stand(dir: string, withPackage: boolean): Promise<Stand> {
    const fork = withPackage ? root.plugin(extensionPackage()) : undefined;
    await sleep(20);
    const prompts: string[] = [];
    const gateway = { languageModel: () => scripted(prompts), groups: () => [] } as unknown as Gateway;
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, logger });
    await sleep(20);
    return { prompts, profiles, dispose: () => fork?.dispose() };
  }

  it("选中的包把工具与提示词加进实例，单频道形态给的是那个具体频道", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-plain-"));
    writePlain(dir, "neko", "neko", true);
    calls.length = 0;
    answering = "add";
    probeName = "neko_probe";
    const rig = await stand(dir, true);
    try {
      expect(rig.profiles).toHaveLength(1);
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      expect(calls.map((coords) => coords.domain)).toEqual([{ form: "channel", platform: "onebot", selfId: "1", channelId: "private:9" }]);

      await scene.deliver(message("private:9", "hi"));
      await scene.idle();

      // 模型看到的东西：包的工具在目录里、内核自己的工具没被挤掉、包那段文字在系统提示里。
      expect(toolCatalog(rig.prompts)).toContain("neko_probe");
      expect(toolCatalog(rig.prompts)).toContain("send_message");
      expect(promptText(rig.prompts)).toContain("本实例启用了 neko-tools。");
    } finally {
      await close(rig, dir);
    }
  });

  it("聚合形态把认领的账号交给包，同一个实例只问一次", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-cross-"));
    writeCross(dir, "lounge", "lounge", true);
    calls.length = 0;
    answering = "add";
    const rig = await stand(dir, true);
    try {
      expect(rig.profiles).toHaveLength(1);
      const profile = rig.profiles[0]!;
      const scene = profile.route(message("private:9", "hi"))!;

      expect(calls).toHaveLength(1);
      const domain = calls[0]!.domain;
      expect(domain.form).toBe("cross");
      if (domain.form !== "cross") throw new Error("聚合实例的形态不是 cross");
      expect(domain.accounts.map((account) => account.sid)).toEqual(["onebot:1", "onebot:2"]);
      expect(domain.accounts.map((account) => account.claim.whitelist)).toEqual([["private:9", "group:2"], ["group:7"]]);

      // 认领范围内的另一个频道归同一个实例，不再问包一次
      expect(profile.route(message("group:2", "again"))).toBe(scene);
      expect(calls).toHaveLength(1);
    } finally {
      await close(rig, dir);
    }
  });

  it("包说用不上、或没被选中时，模型看到的工具面相同", async () => {
    const declinedDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-declined-"));
    const absentDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-absent-"));
    writePlain(declinedDir, "neko", "neko", true);
    writePlain(absentDir, "plain", "plain", false);
    calls.length = 0;
    answering = "decline";
    probeName = "neko_probe";
    const declined = await stand(declinedDir, true);
    const absent = await stand(absentDir, false);
    try {
      expect(declined.profiles).toHaveLength(1);
      expect(absent.profiles).toHaveLength(1);

      const turned = declined.profiles[0]!.route(message("private:9", "hi"))!;
      await turned.deliver(message("private:9", "hi"));
      await turned.idle();
      const plain = absent.profiles[0]!.route(message("private:9", "hi"))!;
      await plain.deliver(message("private:9", "hi"));
      await plain.idle();

      expect(declined.prompts).toHaveLength(1);
      expect(absent.prompts).toHaveLength(1);
      expect(toolCatalog(declined.prompts)).not.toContain("neko_probe");
      expect(promptText(declined.prompts)).not.toContain("本实例启用了 neko-tools。");
      expect(toolCatalog(absent.prompts)).toEqual(toolCatalog(declined.prompts));
    } finally {
      await close(declined, declinedDir);
      await close(absent, absentDir);
    }
  });

  it("与内核工具撞名：装配点直接抛错", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-clash-"));
    writePlain(dir, "neko", "neko", true);
    calls.length = 0;
    answering = "add";
    probeName = "send_message";
    const rig = await stand(dir, true);
    try {
      expect(rig.profiles).toHaveLength(1);
      expect(() => rig.profiles[0]!.route(message("private:9", "hi"))).toThrow(/already provided/);
    } finally {
      probeName = "neko_probe";
      await close(rig, dir);
    }
  });
});
