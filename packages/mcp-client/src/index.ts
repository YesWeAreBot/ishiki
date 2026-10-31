import path from "node:path";

import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, type ExtensionHost } from "koishi-plugin-ishiki";

import { ProfilePool } from "./pool.js";
import { McpResourceHandler } from "./resource-schemes.js";

class McpClientExtension extends Extension {
  static inject = ["ishiki"];
  // 没有实例配置：连接池参数全部来自插件配置（Config），static Schema 缺省即透传。

  private readonly pools = new Map<string, ProfilePool>();
  private readonly fallback: string;

  constructor(ctx: Context, config: McpClientExtension.Config) {
    super(ctx, "mcp-client");
    this.logger.level = config.logLevel;
    this.fallback = path.join(ctx.ishiki.dataPath, ".mcp.json");
    this.logger.info(`mcp-client loaded, fallback config ${this.fallback}`);
  }

  public [Service.invoke](host: ExtensionHost, _config: unknown) {
    const pool = this.pool(host);
    // mcp://<server>/<resource-uri>：包装的 URI 原样交给对应 server，不做任何拆分。
    const dospose = host.resources?.attach(new McpResourceHandler(pool));
    return {
      name: "ishiki.mcp-client",
      extendTools: async () => {
        await pool.connecting;
        return pool.tools();
      },
      extendInstructions: async () => {
        await pool.connecting;
        return pool.instructions() || "";
      },
      stop: () => {
        dospose?.();
      },
    };
  }

  /** 同一 profile 的所有 runtime 共享一个连接池，池子随 profile fiber 注销而关闭。 */
  private pool(host: ExtensionHost): ProfilePool {
    const existing = this.pools.get(host.root);
    if (existing !== undefined) return existing;

    const pool = new ProfilePool(host.root, this.fallback, this.logger);
    this.pools.set(host.root, pool);
    host.fiber.on("dispose", () => {
      this.pools.delete(host.root);
      void pool.close();
    });
    return pool;
  }
}

namespace McpClientExtension {
  export interface Config {
    logLevel: number;
  }

  export const Config: Schema<Config> = Schema.object({
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default McpClientExtension;
