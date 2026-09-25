import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createGateway, type Gateway, type GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema, Service, type Session } from "koishi";
import { parse } from "yaml";

import { createDumpFetch } from "./debugger.js";
import { loadProfiles, type ProfileRuntime } from "./runtime.js";
import { StandardHandler } from "./session-handler.js";

class Ishiki extends Service<Ishiki.Config> {
  static name = "ishiki";
  static inject = [];

  public logger: Logger;

  private readonly dataRoot: string;
  private readonly gateway: Gateway;
  private readonly handler = new StandardHandler();
  private readonly profiles: ProfileRuntime[] = [];

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
    this.logger.info(`--- Model Config ---\n${JSON.stringify(modelConfig, null, 2)}`);
    this.gateway = createGateway({
      config: modelConfig,
      fetch: this.config.dumpRequests ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.dataRoot, "requests") }) : undefined,
    });

    ctx.on("ready", () => this.load());
    ctx.on("internal/session", (session) => void this.onSession(session));
    ctx.on("dispose", async () => {
      await Promise.all(this.profiles.map((profile) => profile.stop()));
      this.profiles.length = 0;
    });
  }

  /** 装载：展开每个 profile 的工厂，建出它们的运行态。实例本身按需诞生。 */
  private load(): void {
    const profilesRoot = path.resolve(this.dataRoot, "profiles");
    if (!existsSync(profilesRoot)) {
      this.logger.warn(`Profiles directory not found: ${profilesRoot}`);
      return;
    }

    let loaded: ProfileRuntime[];
    try {
      loaded = loadProfiles(profilesRoot, { ctx: this.ctx, gateway: this.gateway, logger: this.logger });
    } catch (error) {
      this.logger.error(`profile loading failed, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.profiles.push(...loaded);
    for (const profile of loaded) this.logger.info(`profile "${profile.id}" loaded: ${profile.specs.length} scene spec(s)`);
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
        scene.deliver(event);
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

export default Ishiki;
