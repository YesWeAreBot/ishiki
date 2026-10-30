import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, type ExtensionContext } from "koishi-plugin-ishiki";

import type { Backend, Mode } from "./catalog/types.js";
import { MediaPublisher } from "./media.js";
import { CatalogScheme } from "./scheme.js";
import { createTools, instructions } from "./tools.js";

export interface OneBotExtensionConfig {
  backend?: Backend;
  mode?: Mode;
  maxInlineBytes: number;
  resourceBaseUrl: string;
  denyActions: string[];
}

export const OneBotExtensionConfig: Schema<OneBotExtensionConfig> = Schema.object({
  backend: Schema.union(["napcat", "snowluma"]).description("协议后端：两个实现的动作集合与参数形状不同，目录和只读判定都按它选择。"),
  mode: Schema.union(["docs", "read", "write"]).description("工具档位。docs 只提供目录查询；read 增加只读动作执行；write 增加全部动作执行。"),
  maxInlineBytes: Schema.number()
    .min(1)
    .description("资源 URL 转 base64:// 的字节上限；超过时报错，不做截断。")
    .default(8 * 1024 * 1024),
  resourceBaseUrl: Schema.string()
    .description("协议端访问 Koishi HTTP 服务用的 origin，例如 http://host.docker.internal:5140。留空时使用 Koishi 自己的 selfUrl。")
    .default(""),
  denyActions: Schema.array(Schema.string())
    .description("额外禁用的动作名（规范名或别名）。内置的 bot_exit、set_restart、send_packet 等始终禁用。")
    .default([]),
});

class OneBotExtension extends Extension<OneBotExtensionConfig> {
  static readonly name = "onebot-actions";
  static readonly usage = ``;
  static inject = ["ishiki"];
  public readonly Schema = OneBotExtensionConfig;

  /** 每个 profile 一份发布器：同一 profile 的 runtime 共享同一组临时 URL。 */
  private readonly publishers = new Map<string, MediaPublisher>();
  private readonly defaultBackend: Backend;
  private readonly defaultMode: Mode;

  constructor(ctx: Context, config: OneBotExtension.Config) {
    super(ctx, "onebot-actions");
    this.defaultBackend = config.defaultBackend;
    this.defaultMode = config.defaultMode;
    this.logger.level = config.logLevel;
  }

  public [Service.invoke](config: OneBotExtensionConfig, context: ExtensionContext) {
    const backend = config.backend ?? this.defaultBackend;
    const mode = config.mode ?? this.defaultMode;
    const publisher = this.publisher(context);
    const options = {
      ctx: context.fiber,
      domain: context.domain,
      backend,
      mode,
      deny: config.denyActions,
      resources: context.resources,
      publisher,
      maxInlineBytes: config.maxInlineBytes,
      baseUrl: config.resourceBaseUrl.length > 0 ? config.resourceBaseUrl : undefined,
      logger: context.logger,
    };

    const dispose = context.resources.attach(new CatalogScheme(backend));
    return {
      name: "ishiki.onebot-actions",
      extendTools: async () => createTools(options),
      extendInstructions: async () => instructions(options),
      stop: async () => {
        dispose();
      },
    };
  }

  /** 发布器挂在 profile fiber 上：profile 注销时它与 HTTP 路由一起失效。 */
  private publisher(context: ExtensionContext): MediaPublisher {
    const existing = this.publishers.get(context.root);
    if (existing !== undefined) return existing;
    const publisher = new MediaPublisher();
    this.publishers.set(context.root, publisher);
    context.fiber.on("dispose", () => {
      this.publishers.delete(context.root);
    });
    return publisher;
  }
}

namespace OneBotExtension {
  export interface Config {
    defaultBackend: Backend;
    defaultMode: Mode;
    logLevel: number;
  }
  export const Config: Schema<Config> = Schema.object({
    defaultBackend: Schema.union(["napcat", "snowluma"])
      .description("协议后端：两个实现的动作集合与参数形状不同，目录和只读判定都按它选择。")
      .default("napcat"),
    defaultMode: Schema.union(["docs", "read", "write"])
      .description("工具档位。docs 只提供目录查询；read 增加只读动作执行；write 增加全部动作执行。")
      .default("read"),
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default OneBotExtension;
