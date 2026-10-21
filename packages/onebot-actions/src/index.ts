import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, type ExtensionContext } from "koishi-plugin-ishiki";

import type { Backend, Mode } from "./catalog/types.js";
import { MediaPublisher } from "./media.js";
import { CatalogScheme } from "./scheme.js";
import { createTools, instructions } from "./tools.js";

export interface OneBotConfig {
  backend: Backend;
  mode: Mode;
  maxInlineBytes: number;
  resourceBaseUrl: string;
  denyActions: string[];
  logLevel: number;
}

export const OneBotConfig: Schema<OneBotConfig> = Schema.object({
  backend: Schema.union(["napcat", "snowluma"]).description("协议后端：两个实现的动作集合与参数形状不同，目录和只读判定都按它选择。").required(),
  mode: Schema.union(["docs", "read", "write"]).description("工具档位。docs 只提供目录查询；read 增加只读动作执行；write 增加全部动作执行。").default("read"),
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
  logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
});

class OneBotExtension extends Extension<OneBotConfig> {
  static inject = ["ishiki"];
  public readonly Schema = OneBotConfig;

  /** 每个 profile 一份发布器：同一 profile 的 runtime 共享同一组临时 URL。 */
  private readonly publishers = new Map<string, MediaPublisher>();

  constructor(ctx: Context, config: OneBotConfig) {
    super(ctx, "onebot-actions");
    this.logger.level = config.logLevel;
  }

  public [Service.invoke](config: OneBotConfig, context: ExtensionContext) {
    const publisher = this.publisher(context);
    const options = {
      ctx: context.fiber,
      domain: context.domain,
      backend: config.backend,
      mode: config.mode,
      deny: config.denyActions,
      resources: context.resources,
      publisher,
      maxInlineBytes: config.maxInlineBytes,
      baseUrl: config.resourceBaseUrl.length > 0 ? config.resourceBaseUrl : undefined,
      logger: context.logger,
    };

    const dispose = context.resources.attach(new CatalogScheme(config.backend));
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

export default OneBotExtension;
