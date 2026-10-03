import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, MockLanguageModelV4 } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, Logger, Service, sleep } from "koishi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ContextEngine, type ContextEngineInstance, type ContextEngines, type ContextEngineOptions } from "../../src/context/engine.js";
import Ishiki from "../../src/index.js";
import type { EngineConfig } from "../../src/profile.js";
import { activateProfiles, loadProfiles, type ProfileRuntime } from "../../src/runtime.js";
import { ToolcallEngine } from "../../src/toolcall/engine.js";
import { WakeupEngine } from "../../src/wakeup/engine.js";

/** 变体参数表：社区包用 `declare module` 增强声明它的那个模块。 */
declare module "../../src/context/engine.js" {
  interface ContextEngines {
    "neko-tools/rolling": RollingRuntimeConfig;
    rolling: RollingRuntimeConfig;
  }
}

/** 运行参数：来自 profile/scene 的 `context.<engine>`；provider 的插件级配置另有其物。 */
interface RollingRuntimeConfig {
  timeout?: number;
}

/** provider 侧的插件配置：构造服务时给，与 profile/scene 无关。 */
interface RollingPluginConfig {
  endpoint: string;
}

/** 运行体：把两层配置都摆出来，供用例分别断言。 */
class RollingContextInstance implements ContextEngineInstance {
  constructor(
    public readonly config: RollingRuntimeConfig,
    public readonly endpoint: string,
  ) {}

  instructions = (): string => `上下文由 rolling 引擎组装（${this.endpoint}/${this.config.timeout}）。`;
}

/** 变体被实例化的次数：装配确实走到了社区包提供的 provider。 */
const built = { instances: 0 };

/** 一个社区包的引擎 provider：变体名即服务名，插件级配置由它自己持有。 */
class RollingContextEngine extends ContextEngine<"neko-tools/rolling"> {
  constructor(
    ctx: Context,
    private readonly plugin: RollingPluginConfig,
  ) {
    super(ctx, "neko-tools/rolling");
  }

  public [Service.invoke](config: EngineConfig<Pick<ContextEngines, "neko-tools/rolling">>, _options: ContextEngineOptions): ContextEngineInstance {
    built.instances += 1;
    return new RollingContextInstance({ timeout: config["neko-tools/rolling"]?.timeout ?? 0 }, this.plugin.endpoint);
  }
}

/** 无包前缀的变体：名字里有没有 `/` 都不影响准入。 */
class PlainContextEngine extends ContextEngine<"rolling"> {
  constructor(
    ctx: Context,
    private readonly plugin: RollingPluginConfig,
  ) {
    super(ctx, "rolling");
  }

  public [Service.invoke](config: EngineConfig<Pick<ContextEngines, "rolling">>, _options: ContextEngineOptions): ContextEngineInstance {
    built.instances += 1;
    return new RollingContextInstance({ timeout: config.rolling?.timeout ?? 0 }, this.plugin.endpoint);
  }
}

/**
 * 一个最小的社区扩展包：Koishi 插件，提供 `ishiki.ext.neko-tools` 服务与两个上下文引擎 provider。
 * 每次调用生成新的插件对象——cordis 对同一个插件对象重复 apply 会判重。
 */
function extensionPackage(plugin: RollingPluginConfig = { endpoint: "provider-value" }) {
  function nekoTools(ctx: Context) {
    // 这个包没有 `extends` 加法，只有引擎 provider：服务上挂一个什么都不做的工厂。
    ctx.on(
      "dispose",
      ctx.ishiki.agent.use("neko-tools", () => undefined),
    );
    new RollingContextEngine(ctx, plugin);
    new PlainContextEngine(ctx, plugin);
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

const gateway = {
  languageModel: () =>
    new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("本用例不跑真流");
      },
    }),
  groups: () => [],
} as unknown as Gateway;

function message(channelId: string, id: string) {
  return createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "1",
    channelId,
    isDirect: true,
    messageId: `m-${id}`,
    content: id,
    user: { id: "42", name: "Miaow" },
  });
}

interface ProfileOptions {
  /** 该 profile 使用的上下文引擎；缺省即内置的 standard。 */
  context?: string;
}

/** 写一份 profile：用一个（可能是社区包提供的）上下文引擎变体。 */
function writeProfile(root: string, directory: string, options: ProfileOptions = {}): void {
  const { context = "standard" } = options;
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    ["model: test:model", `context: { engine: "${context}" }`, "scenes:", "  dms:", "    sid: onebot:1", "    whitelist: ['private:*']"].join("\n"),
  );
}

describe("内置引擎服务", () => {
  let dataDir: string;
  let root: Context;
  /** 宿主自己的日志走 koishi 的 Logger：挂一个目标，把 ishiki 服务写的记录收进用例。 */
  const records: string[] = [];

  beforeAll(async () => {
    Logger.targets.push({ record: (record) => records.push(`${record.type} ${record.content}`) });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-"));
    // 放一份空 models.yaml：缺文件时插件会自建并记一条 warn，那是真实行为，
    // 与这组用例无关，写好它就不必让输出里混着这条噪音。
    writeFileSync(path.join(dataDir, "models.yaml"), "");
    // 服务自己的 profiles 目录里放一份只用内置引擎的 profile：装载发生在 ready 期间，
    // 与内置 provider 的登记同一拍，缺服务会被记成 error——这两条断言就在这里守着。
    mkdirSync(path.join(dataDir, "profiles"), { recursive: true });
    writeProfile(path.join(dataDir, "profiles"), "builtin");
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, debugStream: false, logLevel: Logger.INFO });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("内置变体在 profile 装载前就位：一个变体一个服务，无需扩展包", () => {
    expect(root.get(ContextEngine.GetName("standard"))).toBeDefined();
    expect(root.get(ContextEngine.GetName("v3"))).toBeDefined();
    expect(root.get(WakeupEngine.GetName("standard"))).toBeDefined();
    expect(root.get(WakeupEngine.GetName("v3"))).toBeDefined();
    expect(root.get(WakeupEngine.GetName("jev"))).toBeDefined();
    for (const name of ["native", "v3", "hermes", "qwen3coder", "morph-xml", "yaml-xml"]) {
      expect(root.get(ToolcallEngine.GetName(name))).toBeDefined();
    }
  });

  it("只用内置引擎的 profile 立即激活，装载期不报缺失", async () => {
    // load() 由 ready 触发、不与 start() 同步：等它把 profile 装载完，两条断言才有观测面。
    await vi.waitFor(() => expect(records.some((line) => line.includes('profile "builtin" loaded'))).toBe(true), { timeout: 5000 });
    expect(records.some((line) => line.includes("missing required service"))).toBe(false);
    expect(records.some((line) => line.includes('profile "builtin" loaded: 1 scene spec(s)'))).toBe(true);
  });
});

describe("社区扩展包提供的引擎 provider", () => {
  let root: Context;

  beforeAll(async () => {
    // 服务自己的 profiles 目录留空：这些用例自己装载、自己实例化。
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-load-"));
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, debugStream: false, logLevel: 0 });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
  });

  it("provider 缺席时 profile 等待并记 error；就位后自动激活，卸载则停止，重载再重建", async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-rolling-"));
    writeProfile(own, "neko", { context: "neko-tools/rolling" });
    built.instances = 0;

    const profiles: ProfileRuntime[] = [];
    logs.length = 0;
    activateProfiles(loadProfiles(own, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);

    // 服务还没来：这条 fiber 登记着等，运行体尚未诞生；名字带包前缀也不再要求 extends 里写上包名
    expect(profiles).toHaveLength(0);
    expect(
      logs.some(
        (line) =>
          line.includes("[neko] missing required service") &&
          line.includes('"ishiki.engine.context.neko-tools/rolling"') &&
          line.includes("profile is waiting"),
      ),
    ).toBe(true);

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    // 实例随首个场景诞生，装配期不预建
    expect(built.instances).toBe(0);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    const first = profiles[0]!.route(message("private:7", "hi"));
    expect(first).toBeDefined();
    expect(built.instances).toBe(1);

    // provider 卸载：该 profile 的 fiber 复位，运行体停止并摘出路由表；包回来再重建
    pkg.dispose();
    await sleep(20);
    expect(profiles).toHaveLength(0);

    const again = root.plugin(extensionPackage());
    await sleep(20);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    expect(profiles[0]!.route(message("private:7", "hi"))).toBeDefined();
    expect(built.instances).toBe(2);

    await profiles[0]?.stop();
    again.dispose();
    rmSync(own, { recursive: true, force: true });
  });

  it("每个 AgentRuntime 各造一份运行体，provider 只做工厂", async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-instances-"));
    writeProfile(own, "neko", { context: "neko-tools/rolling" });
    built.instances = 0;

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(own, logger), profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);

    const first = profiles[0]!.route(message("private:7", "hi"));
    const second = profiles[0]!.route(message("private:8", "hi"));
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
    expect(built.instances).toBe(2);

    await profiles[0]!.stop();
    pkg.dispose();
    rmSync(own, { recursive: true, force: true });
  });
});

describe("profile 的引擎依赖", () => {
  let root: Context;

  beforeAll(async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-deps-"));
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, debugStream: false, logLevel: 0 });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
  });

  it("scene 覆盖出的引擎计入依赖；缺的是它，兄弟 profile 照常运行", async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-scene-"));
    // 两个 profile：mixed 里一个 scene 覆盖出 rolling，plain 只用内置引擎。
    mkdirSync(path.join(own, "mixed"), { recursive: true });
    writeFileSync(
      path.join(own, "mixed", "profile.yml"),
      [
        "model: test:model",
        "scenes:",
        "  rooms:",
        "    sid: onebot:1",
        "    whitelist: ['group:9']",
        "    context: { engine: rolling }",
        "  dms:",
        "    sid: onebot:1",
        "    whitelist: ['private:7']",
      ].join("\n"),
    );
    mkdirSync(path.join(own, "plain"), { recursive: true });
    writeFileSync(
      path.join(own, "plain", "profile.yml"),
      ["model: test:model", "scenes:", "  rooms:", "    sid: onebot:1", "    whitelist: ['group:8']"].join("\n"),
    );

    // 依赖从展开后的 spec 扫描：profile 默认的 standard 与 scene 覆盖出来的 rolling 都在
    const loads = loadProfiles(own, logger);
    const mixed = loads.find((load) => load.id === "mixed")!;
    expect(mixed.services).toContain(ContextEngine.GetName("standard"));
    expect(mixed.services).toContain(ContextEngine.GetName("rolling"));

    const profiles: ProfileRuntime[] = [];
    logs.length = 0;
    activateProfiles(loads, profiles, { ctx: root, gateway, debugStream: false, logger });
    await sleep(20);

    // 整个 mixed profile 在等 rolling：它没被激活，两个频道都不路由；plain 不依赖它，照常工作
    expect(profiles.map((profile) => profile.id)).toEqual(["plain"]);
    expect(profiles[0]!.route(message("group:8", "hi"))).toBeDefined();
    expect(logs.some((line) => line.includes("[mixed] missing required service") && line.includes('"ishiki.engine.context.rolling"'))).toBe(true);

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    const active = profiles.find((profile) => profile.id === "mixed")!;
    expect(active.route(message("group:9", "hi"))).toBeDefined();
    expect(active.route(message("private:7", "hi"))).toBeDefined();

    // 包停用：只有依赖它的 mixed 复位，plain 不跟着停
    pkg.dispose();
    await sleep(20);
    expect(profiles.some((profile) => profile.id === "mixed")).toBe(false);
    expect(profiles[0]!.route(message("group:8", "hi"))).toBeDefined();

    await profiles[0]!.stop();
    rmSync(own, { recursive: true, force: true });
  });

  it("provider 插件配置与 profile 配置各归各的，运行体不共享", async () => {
    new RollingContextEngine(root, { endpoint: "provider-value" });
    await sleep(20);
    const provider = ContextEngine.GetService(root, "neko-tools/rolling");
    const first = provider({ engine: "neko-tools/rolling", "neko-tools/rolling": { timeout: 1000 } }, {} as ContextEngineOptions);
    const second = provider({ engine: "neko-tools/rolling", "neko-tools/rolling": { timeout: 2000 } }, {} as ContextEngineOptions);

    expect(first).not.toBe(second);
    expect((first as RollingContextInstance).endpoint).toBe("provider-value");
    expect((first as RollingContextInstance).config.timeout).toBe(1000);
    // 同一个 provider 供两个 profile 用：插件资源一份，运行参数各是各的
    expect((second as RollingContextInstance).config.timeout).toBe(2000);
    // 参数缺省时由引擎自己补，不拿插件配置冒充
    expect((provider({ engine: "neko-tools/rolling" }, {} as ContextEngineOptions) as RollingContextInstance).config.timeout).toBe(0);
  });
});
