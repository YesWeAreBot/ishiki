import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, MockLanguageModelV4 } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import { Context, Service, sleep, type Logger } from "koishi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContextEngine, registerContextEngine } from "../src/context/index.js";
import Ishiki, { ContextEngine, type ContextEngines } from "../src/index.js";
import { activateProfiles, loadProfiles, type ProfileRuntime } from "../src/runtime.js";

/** 变体参数表：社区包用 `declare module` 增强，名字带包前缀。 */
declare module "../src/index.js" {
  interface ContextEngines {
    "neko-tools/rolling": { maxChars?: number };
    "probe/rolling": { maxChars?: number };
  }
}

/** 变体被实例化的痕迹：装配确实走到了社区包提供的实现。 */
const built = { engines: 0 };

class RollingEngine<K extends keyof ContextEngines> extends ContextEngine<K> {
  constructor(name: K, config: ContextEngines[K]) {
    super(name, config);
    built.engines += 1;
  }

  extendInstructions = (): string => "上下文由 rolling 引擎组装。";
}

/**
 * 一个最小的社区扩展包：Koishi 插件，提供 `ishiki.ext.neko-tools` 服务，登记一个上下文引擎变体。
 * 每次调用生成新的插件对象——cordis 对同一个插件对象重复 apply 会判重。
 */
function extensionPackage() {
  return Object.assign(
    function nekoTools(ctx: Context) {
      class NekoTools extends Service {
        constructor(c: Context) {
          super(c, "ishiki.ext.neko-tools");
        }
      }
      new NekoTools(ctx);
      ctx.ishiki.registerContextEngine("neko-tools/rolling", (config) => new RollingEngine("neko-tools/rolling", config));
    },
    { inject: ["ishiki"] },
  );
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

/** 写一份 profile：preset 选中扩展包，并用它登记的上下文引擎变体。 */
function writeProfile(root: string, directory: string, id: string, extendsPackages = true): void {
  mkdirSync(path.join(root, directory), { recursive: true });
  writeFileSync(
    path.join(root, directory, "profile.yml"),
    [
      `id: ${id}`,
      "presets:",
      "  chat:",
      "    model: test:model",
      ...(extendsPackages ? ["    extends: [neko-tools]"] : []),
      '    context: { engine: "neko-tools/rolling" }',
      "    scenes:",
      "      dms:",
      "        sid: onebot:1",
      "        whitelist: ['private:*']",
    ].join("\n"),
  );
}

describe("社区扩展：注册面与 fiber 化的 profile", () => {
  let dataDir: string;
  let profilesRoot: string;
  let root: Context;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-"));
    // 服务自己的 profiles 目录留空：这个用例自己装载、自己实例化。
    profilesRoot = path.join(dataDir, "manual");
    mkdirSync(profilesRoot, { recursive: true });
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, logLevel: 0 });
    await root.start();
  });

  afterAll(async () => {
    await root.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("依赖的扩展服务缺席时 profile 不实例化，就位后自动装载", async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-load-"));
    writeProfile(own, "neko", "neko");

    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(own, logger), profiles, { ctx: root, gateway, logger });
    await sleep(20);
    // 服务还没来：fiber 停在非激活态，不报错也不加载
    expect(profiles).toHaveLength(0);

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    // 变体登记着、包也选中了：引擎随首个实例诞生，装配期不预建
    expect(built.engines).toBe(0);
    const first = profiles[0]!.route(message("private:7", "hi"));
    expect(first).toBeDefined();
    expect(built.engines).toBe(1);

    // 包停用：fiber 复位，profile 停止并移出；包回来再重建
    pkg.dispose();
    await sleep(20);
    expect(profiles).toHaveLength(0);

    const again = root.plugin(extensionPackage());
    await sleep(20);
    expect(profiles.map((profile) => profile.id)).toEqual(["neko"]);
    // fiber 重建后引擎重新随实例诞生：路由一次，计到 2
    expect(profiles[0]!.route(message("private:7", "hi"))).toBeDefined();
    expect(built.engines).toBe(2);

    await profiles[0]?.stop();
    again.dispose();
    rmSync(own, { recursive: true, force: true });
  });

  it("选中未扩展的变体：spec 被跳过并报出原因", async () => {
    const stray = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-stray-"));
    writeProfile(stray, "stray", "stray", false);

    logs.length = 0;
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(stray, logger), profiles, { ctx: root, gateway, logger });
    await sleep(20);

    // 准入在展开期拦截：整个 profile 装载失败，其余照常装载的原则由 loadProfiles 的 try 保证
    expect(profiles).toHaveLength(0);
    expect(logs.some((line) => line.includes("not listed in"))).toBe(true);

    rmSync(stray, { recursive: true, force: true });
  });

  it("注册随包的生命周期撤销：包停用后名字不再可用，同名可以再登记", async () => {
    const options = { logger };
    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    expect(() => createContextEngine({ engine: "neko-tools/rolling" }, options)).not.toThrow();

    pkg.dispose();
    await sleep(20);
    // 反注册挂在调用方的 effect 上：包停用即消失
    expect(() => createContextEngine({ engine: "neko-tools/rolling" }, options)).toThrow(/unknown context engine/);

    // 因此重装不撞「已登记」
    const again = root.plugin(extensionPackage());
    await sleep(20);
    expect(() => createContextEngine({ engine: "neko-tools/rolling" }, options)).not.toThrow();
    again.dispose();
  });

  it("装载出的 profile 能路由事件、起场景，扩展包提供的引擎就在里面", async () => {
    const own = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-route-"));
    writeProfile(own, "neko", "neko-route");

    const pkg = root.plugin(extensionPackage());
    await sleep(20);
    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(own, logger), profiles, { ctx: root, gateway, logger });
    await sleep(20);

    const scene = profiles[0]!.route(message("private:7", "hi"));
    expect(scene).toBeDefined();
    // 认领范围内的频道归同一个实例；范围外的不归它
    expect(profiles[0]!.route(message("private:7", "again"))).toBe(scene);
    expect(profiles[0]!.route(message("group:9", "out"))).toBeUndefined();

    await profiles[0]!.stop();
    pkg.dispose();
    rmSync(own, { recursive: true, force: true });
  });

  it("非扩展包提供的变体名不受 extends 门控", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "ishiki-ext-plain-"));
    mkdirSync(path.join(plain, "plain"), { recursive: true });
    writeFileSync(
      path.join(plain, "plain", "profile.yml"),
      ["presets:", "  chat:", "    model: test:model", "    scenes:", "      dms:", "        sid: onebot:1", "        whitelist: ['private:*']"].join("\n"),
    );

    const profiles: ProfileRuntime[] = [];
    activateProfiles(loadProfiles(plain, logger), profiles, { ctx: root, gateway, logger });
    await sleep(20);
    // 内建变体（无包前缀）不问 extends：空依赖的 profile 立即实例化
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.specs).toHaveLength(1);

    await profiles[0]!.stop();
    rmSync(plain, { recursive: true, force: true });
  });

  it("注册动词直接返回撤销函数：调用后名字不再可用，重名抛错", () => {
    const options = { logger };
    const dispose = registerContextEngine("probe/rolling", (config) => new RollingEngine("probe/rolling", config));
    expect(() => createContextEngine({ engine: "probe/rolling" }, options)).not.toThrow();

    dispose();
    expect(() => createContextEngine({ engine: "probe/rolling" }, options)).toThrow(/unknown context engine/);

    const again = registerContextEngine("probe/rolling", (config) => new RollingEngine("probe/rolling", config));
    expect(() => registerContextEngine("probe/rolling", (config) => new RollingEngine("probe/rolling", config))).toThrow(/already registered/);
    again();
  });
});
