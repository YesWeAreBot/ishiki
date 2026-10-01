import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createGateway, type Gateway, type GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema, Service, type Session } from "koishi";
import { parse } from "yaml";

import { ClassicContextEngine, StandardContextEngine } from "./context/index.js";
import { createDumpFetch } from "./debugger.js";
import { type Disposer, type ExtensionHandler } from "./extension.js";
import * as runtime from "./runtime.js";
import { StandardHandler } from "./session-handler.js";
import {
  ClassicToolcallEngine,
  HermesToolcallEngine,
  MorphXmlToolcallEngine,
  NativeToolcallEngine,
  Qwen3CoderToolcallEngine,
  YamlXmlToolcallEngine,
} from "./toolcall/index.js";
import { loadParser } from "./toolcall/parser.js";
import { loadCodemode } from "./tools/codemode.js";
import { ClassicWakeupEngine, JevWakeupEngine, StandardWakeupEngine } from "./wakeup/index.js";

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

    // 内置引擎变体：一个变体一个 provider Service，构造即登记，服务名即准入。
    // 必须排在 ready 监听之前：provider 的登记也挂在 ready 上，先挂的先跑，profile 装载时
    // 才看得到这些服务，preset 的引擎依赖不会先落进等待态。

    // Context 引擎族
    ctx.plugin(StandardContextEngine);
    ctx.plugin(ClassicContextEngine);

    // 唤醒引擎族
    ctx.plugin(StandardWakeupEngine);
    ctx.plugin(ClassicWakeupEngine);
    ctx.plugin(JevWakeupEngine);

    // 工具调用引擎族
    ctx.plugin(NativeToolcallEngine);
    ctx.plugin(ClassicToolcallEngine);
    ctx.plugin(HermesToolcallEngine);
    ctx.plugin(Qwen3CoderToolcallEngine);
    ctx.plugin(MorphXmlToolcallEngine);
    ctx.plugin(YamlXmlToolcallEngine);

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
      const profiles = runtime.loadProfiles(profilesRoot, this.logger);
      runtime.activateProfiles(profiles, this.profiles, { ctx: this.ctx, gateway: this.gateway, logger: this.logger });
    } catch (error) {
      this.logger.error(`profile loading failed, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  /**
   * 登记一个扩展包，启用 `ishiki.ext.<name>` 服务。
   *
   * `handler` 在 AgentRuntime 构造期间、`createAgent` 之前对每个实例叫一次，同步；它的返回值是
   * 这次挂载的拆卸函数，实例停止时逆序执行。加法只能经 `runtime.addTools()` / `runtime.addInstructions()`，
   * 坐标在 `runtime.ctx` / `runtime.domain` / `runtime.directory` 上。这个实例用不上就什么都不调。
   *
   * 返回值是**注册**拆卸函数，移除这个包的服务——与 `handler` 的返回是两件事，别混。
   * 服务挂在这条 fiber 上，归属由调用方声明：`ctx.on("dispose", dispose)`。漏绑不会立刻泄漏，
   * 但服务会跟着 Ishiki 走完，不随调用方那条 fiber 消失。
   */
  public provide(name: string, handler: ExtensionHandler): Disposer {
    const fiber = this.ctx.plugin(
      class extends Service {
        get handler() {
          return handler;
        }
        constructor(ctx: Context) {
          super(ctx, `ishiki.ext.${name}`, true);
        }
      },
    );
    // `dispose()` 返回的是这条 fiber 状态是否变了，调用方不关心：它要的是「这个包的服务没了」。
    return () => {
      fiber.dispose();
    };
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

// 社区包需要的东西：扩展挂载面、运行体契约，以及 `declare module` 增强用的参数表接口。
// 扩展走 `ctx.ishiki.provide(name, handler)`；引擎走继承 provider 基类，服务名由基类的静态 `GetName` 给出。
export { ContextEngine, type ContextEngineInstance, type ContextEngineOptions, type ContextEngines } from "./context/index.js";
export type { ClaimedAccount, InstanceDomain } from "./domain.js";
export { extensionServiceName, type Disposer, type ExtensionHandler } from "./extension.js";
export type { AgentRuntime } from "./runtime.js";
export { ToolcallEngine, type ToolcallEngineInstance, type ToolcallEngines } from "./toolcall/index.js";
export { WakeupEngine, type WakeupDecision, type WakeupEngineDeps, type WakeupEngineInstance, type WakeupEngines } from "./wakeup/index.js";

export default Ishiki;
