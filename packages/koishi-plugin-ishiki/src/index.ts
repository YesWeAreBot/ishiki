import { existsSync, promises as fs, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Agent } from "@yesimagent/core";
import { createGateway, Gateway, GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema } from "koishi";
import { parse } from "yaml";

import { createDumpFetch } from "./debug.js";
import { parseProfileConfig } from "./profiles.js";
import { ProfileRuntime } from "./runtime.js";
import {} from "./types.js";

class Ishiki {
  static name = "ishiki";
  static inject = [];

  public ctx: Context;
  public config: Ishiki.Config;
  public logger: Logger;

  private gateway: Gateway;
  private runtimes: ProfileRuntime[] = [];

  constructor(ctx: Context, config: Ishiki.Config) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("ishiki");
    this.logger.level = config.logLevel ?? Logger.INFO;

    const modelConfigFile = path.resolve(this.ctx.baseDir, this.config.dataPath, "models.yaml");
    if (!existsSync(modelConfigFile)) {
      mkdirSync(path.dirname(modelConfigFile), { recursive: true });
      writeFileSync(modelConfigFile, "");
    }
    const modelConfigContent = readFileSync(modelConfigFile, "utf-8");
    const modelConfig = (parse(modelConfigContent) as GatewayConfig) ?? {};
    this.logger.info(`--- Model Config ---\n${JSON.stringify(modelConfig, null, 2)}`);
    this.gateway = createGateway({
      config: modelConfig,
      fetch: this.config.dumpRequests
        ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.ctx.baseDir, this.config.dataPath, "debug") })
        : undefined,
    });
    for (const model of this.gateway.models()) {
      this.logger.info(model);
    }

    ctx.on("ready", async () => {
      const profilesFile = path.resolve(this.ctx.baseDir, this.config.profilesPath);
      if (!existsSync(profilesFile)) {
        this.logger.warn(`Profiles file not found: ${profilesFile}`);
        return;
      }

      const profilesContent = await fs.readFile(profilesFile, "utf-8");
      const profilesConfig = parseProfileConfig(profilesContent);
      this.logger.info(`--- Validated Profiles Config ---\n${JSON.stringify(profilesConfig, null, 2)}`);

      for (const profile of profilesConfig.profiles) {
        const runtime = new ProfileRuntime(this.ctx, {
          profile,
          gateway: this.gateway,
          profilesPath: this.config.profilesPath,
          logLevel: this.config.logLevel,
        });
        this.runtimes.push(runtime);
        await runtime.start();
      }

      this.logger.info("Ishiki plugin is ready.");
    });

    ctx.on("dispose", async () => {
      for (const runtime of this.runtimes) await runtime.stop();
      this.runtimes = [];
    });
  }
}

namespace Ishiki {
  export interface Config {
    dataPath: string;
    profilesPath: string;
    dumpRequests: boolean;
    logLevel: number;
  }
  export const Config: Schema<Ishiki.Config> = Schema.object({
    dataPath: Schema.string().role("path").description("数据存储路径").default("data/ishiki"),
    profilesPath: Schema.string().role("path").description("配置文件路径").default("data/ishiki/profiles.yaml"),
    dumpRequests: Schema.boolean().description("是否将请求数据保存到本地").default(false),
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default Ishiki;
