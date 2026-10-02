import path from "node:path";

import { Context, Logger, Schema } from "koishi";
// `ctx.ishiki` 与 `ishiki.ext.*` 的类型增强在这个包里，引入它才看得见挂载面。
import {} from "koishi-plugin-ishiki";

import { ProfilePool } from "./pool.js";
import type { OutputLimits } from "./server.js";

/**
 * MCP 客户端扩展包。
 *
 * 服务器不在 Koishi 控制台配，写在文件里：`<dataPath>/.mcp.json` 是基线，
 * `<dataPath>/profiles/<目录名>/mcp.json` 存在时完全替换它。`dataPath` 取自内核服务，
 * 插件不再另配一份——两份路径迟早会有一份过期。形状见包内
 * `resources/mcp.schema.json`，字段语义见 `resources/README.md`。
 *
 * 连接按 profile 建立，同 profile 的所有频道实例共享一组。handler 是同步的（内核的约定），
 * 建池同步完成、握手并发进行；两个加法钩子是 async 的，等握手收尾再交工具面与提示词，
 * 所以模型第一次开口时就看到完整目录，不必逐轮生长。
 */
class IshikiMcpClient {
  public static name = "ishiki-mcp-client";
  public static usage = "把 MCP 服务器的工具接入 ishiki 视窗；服务器在 .mcp.json 里配置";
  // 用到 ctx.ishiki 就得在 inject 里写明，否则 cordis 每次取用都记一条 not-registered 警告。
  public static inject = ["ishiki"];

  private readonly logger: ReturnType<Context["logger"]>;
  /** profile 目录到它那组连接的映射；进程内只有这一份。 */
  private readonly pools = new Map<string, ProfilePool>();

  constructor(ctx: Context, config: IshikiMcpClient.Config) {
    this.logger = ctx.logger(IshikiMcpClient.name);
    this.logger.level = config.logLevel;

    const fallback = path.join(ctx.ishiki.dataPath, ".mcp.json");
    this.logger.info(`mcp-client loaded, fallback config ${fallback}`);

    // 连接的建立不挂在 ready 上：扩展服务要在 profile 的 fiber 里就位，
    // 挂 ready 会让它比 profile 装载晚一拍。
    const dispose = ctx.ishiki.provide("mcp-client", (_profileConfig, runtime) => {
      const { root } = runtime;
      this.logger.info(`mcp-client mounted for ${root}`);
      let pool = this.pools.get(root);
      if (pool === undefined) {
        pool = new ProfilePool(root, fallback, config.limits, this.logger);
        this.pools.set(root, pool);
      }
      pool.hold();
      return {
        // 等握手收尾再交工具面：模型第一次开口时就该看到完整目录，而不是逐轮长出来。
        // `connecting` 是建池那一刻开跑的那个 Promise，settled 之后再等只是一个微任务；
        // 它不 reject（每个 server 的成败在池里各自 catch），上限是 SDK 的默认请求超时（60 秒）。
        extendTools: async () => {
          await pool.connecting;
          return pool.tools();
        },
        extendInstructions: async () => {
          await pool.connecting;
          return pool.instructions();
        },
        dispose: () => {
          this.pools.delete(root);
          return pool.release();
        },
      };
    });

    ctx.on("dispose", async () => {
      dispose();
      await Promise.all([...this.pools.values()].map((pool) => pool.release()));
      this.pools.clear();
    });
  }
}

namespace IshikiMcpClient {
  export interface Config {
    limits: OutputLimits;
    logLevel: number;
  }

  /**
   * 单次工具调用的出口限额。
   *
   * 三个数字各有理由，少一个都不改：
   * - 单张上限与合计上限防的是解码与上下文两端的爆量。`ai` SDK 对 URL 资产另有下载上限，
   *   内联字节不经那一条。
   * - 字节最终会进 `events.jsonl`：工具消息被 `JSON.stringify` 后追加进不可变事实流，
   *   base64 在那里永久占盘，压不下来，所以单次调用的图片量必须在出口处封顶。
   * - 文本上限防的是解析协议与上下文引擎在文本侧拼装时挤掉整段窗口。
   *
   * 缺省值写在这里而不是各处的 `??`：这份是插件级单层配置，没有逐层合并的场合，
   * 用户在控制台看到的就是生效值。
   */
  export const limits: Schema<OutputLimits> = Schema.object({
    maxImageBytes: Schema.number()
      .description("单张图片的字节上限；超过的降级成一行说明")
      .default(5 * 1024 * 1024),
    maxTotalImageBytes: Schema.number()
      .description("单次调用里全部图片合计的字节上限")
      .default(10 * 1024 * 1024),
    maxImageCount: Schema.number().min(0).description("单次调用最多带几张图片").default(4),
    maxOutputChars: Schema.number().min(1).description("文本面的字符上限；超出的部分截断").default(30_000),
  });

  export const Config: Schema<Config> = Schema.object({
    // 服务器在文件里，这里配的只有出口限额与日志级别。数据根从内核服务读，不另配一份。
    limits,
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

// 命名空间随类合并，但要单独导出才能在测试里取到 `limits` 那份 Schema。
// export { IshikiMcpClient };
export default IshikiMcpClient;
