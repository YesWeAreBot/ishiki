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
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, Service, sleep, type Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContextEngine, type ContextEngineInstance, type ContextEngineOptions, type ContextEngines } from "../../src/context/engine.js";
import type { RuntimePlugin, RuntimePluginFactory, RuntimeScope } from "../../src/extension.js";
import Ishiki from "../../src/index.js";
import { activateProfiles, loadProfiles, type AgentRuntime, type ProfileRuntime } from "../../src/runtime.js";

/** 观察用引擎的参数表：它没有参数，声明出来是为了走通 `ContextEngine<"...">` 的约束。 */
declare module "../../src/context/engine.js" {
  interface ContextEngines {
    "neko-tools/spy": Record<string, never>;
  }
}

// ── 社区扩展包 ──

/** 每次工厂收到的坐标与配置：内核实际交出去的东西，断言只落在这些事实上。 */
const calls: Array<{ domain: AgentRuntime["domain"]; home: string; config: unknown }> = [];

/** 拆卸记录：实例停止时按逆序执行，每个包一条。 */
const disposed: string[] = [];

/** 一件包贡献的工具：只用来证明它进了模型目录，不需要真的被调用。 */
const lookup = tool({
  description: "查一点东西。",
  inputSchema: jsonSchema<{ keyword: string }>({ type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] }),
  execute: async () => ({ hits: [] }),
});

/**
 * 一个只记账的扩展包：`ctx.ishiki.agent.use()` 登记 `ishiki.ext.neko-tools`，工厂在每个实例诞生时
 * 被叫一次。包自己解释 `config`，内核只负责原样递过来。
 */
function extensionPackage(pkg = "neko-tools", contribute?: (scope: RuntimeScope) => Pick<RuntimePlugin, "extendTools" | "extendInstructions">) {
  function nekoTools(ctx: Context) {
    const factory: RuntimePluginFactory = (scope) => {
      calls.push({ domain: scope.domain, home: scope.home, config: scope.config });
      return {
        ...contribute?.(scope),
        name: `ishiki.${pkg}`,
        stop: () => {
          disposed.push(pkg);
        },
      };
    };
    // 归属声明：服务随这条 fiber 走。漏绑的话服务会活到 ishiki 自己 dispose。
    ctx.on("dispose", ctx.ishiki.agent.use(pkg, factory));
  }
  // 用了 ctx.ishiki 就得在 inject 里写明，否则 cordis 每次取用都记一条 not-registered 警告。
  nekoTools.inject = ["ishiki"];
  return nekoTools;
}

// ── 测试装配台 ──

const logs: string[] = [];
const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: (message: string) => logs.push(`warn ${message}`),
  error: (message: string) => logs.push(`error ${message}`),
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

const SCENES = ["scenes:", "  dms:", "    sid: onebot:1", "    whitelist: ['private:9']"];
const WAKEUP = "wakeup: { engine: standard, standard: { direct: true, atSelf: false, quoteSelf: false, keywords: [] } }";

/** 普通 profile：一频道一实例，认领一个私聊。`extends` 按 YAML 片段原样写进 profile 顶层。 */
function writePlain(root: string, directory: string, extendsYaml: readonly string[] = []): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(path.join(root, directory, "profile.yml"), ["model: test:model", ...extendsYaml, WAKEUP, ...SCENES].join("\n"));
}

/** 聚合 profile：profile 自身即生效单位，claims 认领两个账号下的频道。 */
function writeCross(root: string, directory: string, extendsYaml: readonly string[] = []): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    [
      "model: test:model",
      "cross: true",
      ...extendsYaml,
      WAKEUP,
      "claims:",
      '  "onebot:1": { whitelist: ["private:9", "group:2"] }',
      '  "onebot:2": { whitelist: ["group:7"] }',
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

describe("扩展包的挂载：agent.use、拆卸与准入", () => {
  let dataDir: string;
  let root: Context;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-"));
    // 服务自己的 profiles 目录留空：这个用例自己装载、自己实例化。
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, debugStream: false, logLevel: 0 });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** 一份装配台：装好扩展包、装载 profile、备好记录提示词的模型。 */
  async function stand(dir: string, withPackage = true): Promise<Stand> {
    const fork = withPackage ? root.plugin(extensionPackage()) : undefined;
    await sleep(20);
    const prompts: string[] = [];
    const gateway = { languageModel: () => scripted(prompts), groups: () => [] } as unknown as Gateway;
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);
    return { prompts, profiles, dispose: () => fork?.dispose() };
  }

  it("agent.use 收到 profile 的 config 与实例坐标", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-plain-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:", "    config:", "      label: plain-pack"]);
    calls.length = 0;
    const rig = await stand(dir);
    try {
      expect(rig.profiles).toHaveLength(1);
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.config).toEqual({ label: "plain-pack" });
      expect(calls[0]!.domain).toEqual({ form: "channel", platform: "onebot", selfId: "1", channelId: "private:9" });
      // 目录是本实例的：包自己的文件放这儿，随实例生灭。
      expect(calls[0]!.home).toBe(scene.home);

      await scene.deliver(message("private:9", "hi"));
      await scene.idle();
    } finally {
      await close(rig, dir);
    }
  });

  it("聚合形态把认领的账号交给包，同一个实例只问一次", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-cross-"));
    writeCross(dir, "lounge", ["extends:", "  neko-tools:"]);
    calls.length = 0;
    const rig = await stand(dir);
    try {
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

  it("同一个包服务两个 profile：配置各归各的，一个停不影响另一个", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-shared-"));
    // 两份配置只有包配置与认领频道不同：同一个包被两个 profile 各挂一次。
    mkdirSync(path.join(dir, "chat"), { recursive: true });
    writeFileSync(
      path.join(dir, "chat", "profile.yml"),
      ["model: test:model", "extends:", "  neko-tools: { config: { label: chat-pack } }", WAKEUP, ...SCENES].join("\n"),
    );
    mkdirSync(path.join(dir, "roleplay"), { recursive: true });
    writeFileSync(
      path.join(dir, "roleplay", "profile.yml"),
      [
        "model: test:model",
        "extends:",
        "  neko-tools: { config: { label: roleplay-pack } }",
        WAKEUP,
        "scenes:",
        "  dms:",
        "    sid: onebot:1",
        "    whitelist: ['private:5']",
      ].join("\n"),
    );
    calls.length = 0;
    disposed.length = 0;
    const rig = await stand(dir);
    try {
      expect(rig.profiles.map((profile) => profile.id)).toEqual(["chat", "roleplay"]);
      const chat = rig.profiles.find((profile) => profile.id === "chat")!.route(message("private:9", "hi"))!;
      const roleplay = rig.profiles.find((profile) => profile.id === "roleplay")!.route(message("private:5", "hi"))!;
      expect(chat).not.toBe(roleplay);
      expect(calls.map((call) => call.config)).toEqual([{ label: "chat-pack" }, { label: "roleplay-pack" }]);

      // 两个实例的挂载互不相干：停掉一个只拆它那一次，另一个照常跑。
      await chat.stop();
      expect(disposed).toEqual(["neko-tools"]);
      await roleplay.deliver(message("private:5", "still"));
      await roleplay.idle();
    } finally {
      await close(rig, dir);
    }
  });

  it("enable: false：不依赖、不等待、不调用，缺包也不报错", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-off-"));
    writePlain(dir, "neko", ["extends:", "  never-installed:", "    enable: false"]);
    calls.length = 0;
    logs.length = 0;
    // 这个 profile 要的包根本没装：不装包也应当照常激活。
    const rig = await stand(dir, false);
    try {
      expect(rig.profiles[0]!.route(message("private:9", "hi"))).toBeDefined();
      expect(calls).toHaveLength(0);
      expect(logs.some((line) => line.includes("missing required service"))).toBe(false);
      expect(logs.some((line) => line.includes("never-installed"))).toBe(false);
    } finally {
      await close(rig, dir);
    }
  });

  it("缺包时 profile 等待；包就位自动激活，卸载则停止并拆卸，重载再重建", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-cycle-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:"]);
    calls.length = 0;
    disposed.length = 0;
    logs.length = 0;

    const prompts: string[] = [];
    const gateway = { languageModel: () => scripted(prompts), groups: () => [] } as unknown as Gateway;
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);
    // 服务还没来：这条 fiber 登记着等，运行体尚未诞生。
    expect(profiles).toHaveLength(0);
    expect(
      logs.some((line) => line.includes("[neko] missing required service") && line.includes('"ishiki.ext.neko-tools"') && line.includes("profile is waiting")),
    ).toBe(true);

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    expect(profiles[0]!.route(message("private:9", "hi"))).toBeDefined();
    expect(calls).toHaveLength(1);

    // 卸载：该 profile 的 fiber 复位，实例停止并逆序拆掉包的挂载
    pkg.dispose();
    await sleep(20);
    expect(profiles).toHaveLength(0);
    expect(disposed).toEqual(["neko-tools"]);

    const again = root.plugin(extensionPackage());
    await sleep(20);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    expect(profiles[0]!.route(message("private:9", "hi"))).toBeDefined();
    expect(calls).toHaveLength(2);

    await profiles[0]?.stop();
    again.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("注册拆卸函数移除本包的服务；重复调用无害，也不牵连别的包", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-unregister-"));
    writePlain(dir, "neko", ["extends:", "  first:", "  second:"]);
    disposed.length = 0;
    const holds: { unregister?: () => void | Promise<void> } = {};

    // 两条服务各归各的拆卸函数：拆掉 first 不该带走 second。
    const holder = root.plugin(
      Object.assign(
        (ctx: Context) => {
          holds.unregister = ctx.ishiki.agent.use("first", () => undefined);
          ctx.on(
            "dispose",
            ctx.ishiki.agent.use("second", () => undefined),
          );
        },
        { inject: ["ishiki"] },
      ),
    );
    await sleep(20);

    const profiles: ProfileRuntime[] = [];
    const prompts: string[] = [];
    const gateway = { languageModel: () => scripted(prompts), groups: () => [] } as unknown as Gateway;
    activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);
    // 两个包都在位，profile 照常激活。
    expect(profiles[0]!.route(message("private:9", "hi"))).toBeDefined();

    // 服务本身可调用：没有 `{ factory }` 包装，取出来直接就是工厂。
    expect(typeof root.get("ishiki.ext.first")).toBe("function");
    holds.unregister!();
    holds.unregister!();
    await sleep(20);

    expect(root.get("ishiki.ext.first")).toBeUndefined();
    expect(root.get("ishiki.ext.second")).toBeDefined();
    // first 缺席，依赖它的 profile 复位并摘出路由表：同一个频道不再有归属。
    expect(profiles).toHaveLength(0);

    await profiles[0]?.stop();
    holder.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("工厂中途抛错：已收到的停止函数逆序回滚，实例不落表", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-rollback-"));
    writePlain(dir, "neko", ["extends:", "  first:", "  second:", "  third:"]);
    disposed.length = 0;

    const packs = root.plugin(
      Object.assign(
        (ctx: Context) => {
          ctx.on(
            "dispose",
            ctx.ishiki.agent.use("first", () => ({
              name: "ishiki.first",
              stop: () => {
                disposed.push("first");
              },
            })),
          );
          ctx.on(
            "dispose",
            ctx.ishiki.agent.use("second", () => ({
              name: "ishiki.second",
              stop: () => {
                disposed.push("second");
              },
            })),
          );
          ctx.on(
            "dispose",
            ctx.ishiki.agent.use("third", () => {
              throw new Error("这个包装不上");
            }),
          );
        },
        { inject: ["ishiki"] },
      ),
    );
    await sleep(20);

    const profiles: ProfileRuntime[] = [];
    const gateway = { languageModel: () => scripted([]), groups: () => [] } as unknown as Gateway;
    activateProfiles(loadProfiles(dir, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);

    expect(() => profiles[0]!.route(message("private:9", "hi"))).toThrow(/这个包装不上/);
    // 先挂的后拆：second 在 first 之前。
    expect(disposed).toEqual(["second", "first"]);
    // 装配失败不该留下能路由的实例：同一个频道再来一次还是抛。
    expect(() => profiles[0]!.route(message("private:9", "again"))).toThrow(/这个包装不上/);

    await profiles[0]?.stop();
    packs.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("重复 stop 不重复拆卸：拆卸函数随实例走一次", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-restop-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:"]);
    disposed.length = 0;
    const rig = await stand(dir);
    try {
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      await scene.stop();
      await scene.stop();
      expect(disposed).toEqual(["neko-tools"]);
    } finally {
      await close(rig, dir);
    }
  });

  it("只登记扩展、不提供引擎：两套 Service 互不要求", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-enginefree-"));
    // 这个 profile 用内置引擎，一个社区引擎服务都不依赖。
    writePlain(dir, "neko", ["extends:", "  neko-tools:"]);
    calls.length = 0;
    const rig = await stand(dir);
    try {
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      await scene.deliver(message("private:9", "hi"));
      await scene.idle();
      // 内核工具面原样可用：登记扩展不牵动装配。
      expect(toolCatalog(rig.prompts)).toContain("send_message");
      expect(calls).toHaveLength(1);
    } finally {
      await close(rig, dir);
    }
  });

  it("上下文引擎造出来时看到的是本实例的坐标", async () => {
    const seen: ContextEngineOptions[] = [];
    /** 只记下 options 的观察用引擎：它不参与渲染，只证明依赖传到位的时刻。 */
    class SpyContextEngine extends ContextEngine<"neko-tools/spy"> {
      constructor(c: Context) {
        super(c, "neko-tools/spy");
      }

      public [Service.invoke](
        _config: { engine: "neko-tools/spy"; "neko-tools/spy"?: Partial<ContextEngines["neko-tools/spy"]> },
        options: ContextEngineOptions,
      ): ContextEngineInstance {
        seen.push(options);
        return {};
      }
    }
    const spy = root.plugin((c: Context) => {
      new SpyContextEngine(c);
    });
    await sleep(20);

    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-ctxdeps-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:", "context:", '  engine: "neko-tools/spy"']);
    try {
      const rig = await stand(dir);
      try {
        rig.profiles[0]!.route(message("private:9", "hi"));
        expect(seen).toHaveLength(1);
        // 目录是本 profile 的目录：引擎要读的记忆块、模板都在这儿之下。
        expect(seen[0]!.directory).toBe(path.join(dir, "neko"));
        expect(seen[0]!.domain).toEqual({ form: "channel", platform: "onebot", selfId: "1", channelId: "private:9" });
      } finally {
        await close(rig, dir);
      }
    } finally {
      spy.dispose();
    }
  });

  it("包的工具与提示词每轮现取：进工具目录、进提示词，内容跨轮可变", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-add-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:"]);
    let round = 0;
    const pack = root.plugin(
      extensionPackage("neko-tools", () => ({
        extendTools: () => ({ lookup }),
        extendInstructions: () => `第 ${++round} 轮的临时规则`,
      })),
    );
    await sleep(20);
    // 这条用例自己装包，stand 不再装默认那一份。
    const rig = await stand(dir, false);
    try {
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      await scene.deliver(message("private:9", "hi"));
      await scene.idle();
      expect(toolCatalog(rig.prompts)).toContain("lookup");
      expect(rig.prompts.at(-1)).toContain("第 1 轮的临时规则");

      // 内核不缓存钩子的结果：第二轮拿到的是包这一轮给的那份。
      await scene.deliver(message("private:9", "again"));
      await scene.idle();
      expect(rig.prompts.at(-1)).toContain("第 2 轮的临时规则");
    } finally {
      await close(rig, dir);
      pack.dispose();
    }
  });

  it("与内核工具撞名：错误落在轮次里，不拦住实例诞生", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-contrib-clash-"));
    writePlain(dir, "neko", ["extends:", "  neko-tools:"]);
    logs.length = 0;
    const pack = root.plugin(extensionPackage("neko-tools", () => ({ extendTools: () => ({ send_message: lookup }) })));
    await sleep(20);
    const rig = await stand(dir, false);
    try {
      // 实例照常诞生：工具面在轮次里才合并，撞名不是装配失败。
      const scene = rig.profiles[0]!.route(message("private:9", "hi"))!;
      await scene.deliver(message("private:9", "hi"));
      await scene.idle();
      expect(logs.some((line) => line.includes("turn failed"))).toBe(true);
    } finally {
      await close(rig, dir);
      pack.dispose();
    }
  });
});
