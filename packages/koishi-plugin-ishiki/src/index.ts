import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createGateway, type Gateway, type GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema, Service, type Session } from "koishi";
import { parse } from "yaml";

import * as contextEngines from "./context/index.js";
import { createDumpFetch } from "./debugger.js";
import * as runtime from "./runtime.js";
import { StandardHandler } from "./session-handler.js";
import * as toolcallEngines from "./toolcall/index.js";
import { loadParser } from "./toolcall/parser.js";
import { loadCodemode } from "./tools/codemode.js";
import * as wakeupEngines from "./wakeup/index.js";

class Ishiki extends Service<Ishiki.Config> {
  static name = "ishiki";
  static inject = [];

  public logger: Logger;

  private readonly dataRoot: string;
  private readonly gateway: Gateway;
  private readonly handler = new StandardHandler();
  private readonly profiles: runtime.ProfileRuntime[] = [];

  constructor(ctx: Context, config: Ishiki.Config) {
    super(ctx, "ishiki");
    this.config = config;
    this.logger = ctx.logger("ishiki");
    this.logger.level = config.logLevel;

    this.dataRoot = path.resolve(ctx.baseDir, config.dataPath);
    const modelConfigFile = path.resolve(this.dataRoot, "models.yaml");
    if (!existsSync(modelConfigFile)) {
      this.logger.warn(`Model config file not found: ${modelConfigFile}, creating an empty one.`);
      mkdirSync(path.dirname(modelConfigFile), { recursive: true });
      writeFileSync(modelConfigFile, "");
    }
    const modelConfig = (parse(readFileSync(modelConfigFile, "utf-8")) as GatewayConfig) ?? {};
    this.gateway = createGateway({
      config: modelConfig,
      fetch: this.config.dumpRequests ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.dataRoot, "requests") }) : undefined,
    });

    ctx.on("ready", () => void this.load());
    ctx.on("internal/session", (session) => void this.onSession(session));
    ctx.on("dispose", async () => {
      await Promise.all(this.profiles.map((profile) => profile.stop()));
      this.profiles.length = 0;
    });
  }

  /** 装载：先备好工具调用解析库，再展开每个 profile 的工厂。实例本身按需诞生。 */
  private async load(): Promise<void> {
    const profilesRoot = path.resolve(this.dataRoot, "profiles");
    if (!existsSync(profilesRoot)) {
      this.logger.warn(`Profiles directory not found: ${profilesRoot}`);
      return;
    }

    // 协议引擎与代码模式要这两个 ESM 库；在装载任何 profile 之前备好，免得装配场景时才发现。
    // 装载完成前本服务不接事件。
    try {
      await loadParser();
      await loadCodemode();
    } catch (error) {
      this.logger.error(`toolcall runtime unavailable, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    try {
      runtime.activateProfiles(runtime.loadProfiles(profilesRoot, this.logger), this.profiles, { ctx: this.ctx, gateway: this.gateway, logger: this.logger });
    } catch (error) {
      this.logger.error(`profile loading failed, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 注册面：社区扩展在 apply 期同步登记自己的引擎变体。社区变体的名字写成 `包名/名字`，
   * 只有 `extends` 选中该包的 preset 用得上（无前缀的名字是内建变体，不受此门控）；
   * 注册随调用方的插件生命周期撤销——cordis 把这里的 `this.ctx` 绑在调用方作用域上，
   * 包卸载时变体一并消失，不会留下悬空的注册。
   *
   * 走服务命名空间而不是根导出：包外若把本包装成普通依赖会出现第二份模块实例，写进另一张
   * 注册表并静默失效；绑定运行中的服务实例没有这个问题。
   */
  public registerContextEngine<K extends keyof contextEngines.ContextEngines>(
    name: K,
    create: (config: contextEngines.ContextEngines[K], options: contextEngines.ContextEngineOptions) => contextEngines.ContextEngine<K>,
  ): void {
    this.ctx.effect(() => contextEngines.registerContextEngine(name, create));
  }

  public registerWakeupEngine<K extends keyof wakeupEngines.WakeupEngines>(
    name: K,
    create: (config: wakeupEngines.WakeupEngines[K], deps: wakeupEngines.WakeupEngineDeps) => wakeupEngines.WakeupEngine<K>,
  ): void {
    this.ctx.effect(() => wakeupEngines.registerWakeupEngine(name, create));
  }

  public registerToolcallEngine<K extends keyof toolcallEngines.ToolcallEngines>(
    name: K,
    create: (config: toolcallEngines.ToolcallEngines[K]) => toolcallEngines.ToolcallEngine<K>,
  ): void {
    this.ctx.effect(() => toolcallEngines.registerToolcallEngine(name, create));
  }

  /** 平台事件进门：自家回声丢掉，其余交给它归属的那个场景。 */
  private async onSession(session: Session): Promise<void> {
    if (session.userId !== undefined && session.userId === session.selfId) return;

    const event = this.handler.handle(session);
    if (event === undefined) return;

    for (const profile of this.profiles) {
      try {
        const scene = profile.route(event);
        if (scene === undefined) continue;
        await scene.deliver(event);
      } catch (error) {
        this.logger.warn(`routing failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      return;
    }
  }
}

namespace Ishiki {
  export interface Config {
    dataPath: string;
    dumpRequests: boolean;
    logLevel: number;
  }
  export const Config: Schema<Ishiki.Config> = Schema.object({
    dataPath: Schema.string().role("path").description("数据存储路径").default("data/ishiki"),
    dumpRequests: Schema.boolean().description("是否将请求数据保存到本地").default(false),
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

declare module "koishi" {
  interface Context {
    ishiki: Ishiki;
  }
}

// 社区包需要的东西：继承用的基类与 `declare module` 增强用的参数表接口。
// 注册动词不走根导出——服务命名空间才是入口，见 `Ishiki.registerContextEngine` 的注释。
export { ContextEngine, type ContextEngineOptions, type ContextEngines } from "./context/index.js";
export { ToolcallEngine, type ToolcallEngines } from "./toolcall/index.js";
export { WakeupEngine, type WakeupDecision, type WakeupEngineDeps, type WakeupEngines } from "./wakeup/index.js";

export default Ishiki;
