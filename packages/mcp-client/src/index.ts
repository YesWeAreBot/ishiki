import path from "node:path";

import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, ResourceError, ResourcePayload, ResourceUrl, SchemeHandler, type ExtensionContext } from "koishi-plugin-ishiki";

import { ProfilePool } from "./pool.js";

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

  public [Service.invoke](_config: unknown, context: ExtensionContext) {
    const pool = this.pool(context);
    // mcp://<server>/<resource-uri>；同样由该池兜底解析任意自定义 scheme 资源。
    const dospose = context.resources?.attach(new McpResourceHandler(pool));
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
  private pool(context: ExtensionContext): ProfilePool {
    const existing = this.pools.get(context.root);
    if (existing !== undefined) return existing;

    const pool = new ProfilePool(context.root, this.fallback, this.logger);
    this.pools.set(context.root, pool);
    context.fiber.on("dispose", () => {
      this.pools.delete(context.root);
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

/**
 * `mcp://<server>/<resource-uri>` — remote resources from the connected MCP
 * servers. The wrapped URI is arbitrary and may carry colons, slashes, or
 * query strings of its own, so the scheme is opaque: the tail is taken
 * verbatim from `rawTail`, with no view or selector parsing.
 */
class McpResourceHandler implements SchemeHandler {
  readonly scheme = "mcp";
  readonly opaque = true;

  public constructor(private readonly pool: ProfilePool) {}

  async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const serverName = url.authority;
    const resourceUri = url.rawTail.replace(/^\//, "");
    if (!serverName || resourceUri.length === 0) {
      throw new ResourceError("invalid_resource_uri", `mcp URL requires server and resource URI: mcp://<server>/<resource-uri>`);
    }
    const content = await this.pool.readResource(serverName, resourceUri);
    if (content.blob !== undefined) {
      const bytes = Buffer.from(content.blob, "base64");
      return { url: url.href, bytes: new Uint8Array(bytes), mediaType: content.mimeType, size: bytes.byteLength };
    }
    const text = content.text ?? `[${content.mimeType ?? "unknown"} resource: ${resourceUri}]`;
    return { url: url.href, content: text, mediaType: content.mimeType ?? "text/plain", size: Buffer.byteLength(text) };
  }
}

export default McpClientExtension;
