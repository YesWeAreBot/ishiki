import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";
import type { ToolSet } from "koishi-plugin-ishiki";

import { McpConfig, ServerConfig, type McpServer } from "./config.js";
import { McpConnection, type OutputLimits } from "./server.js";

/**
 * 一个 profile 的连接组。
 *
 * 作用域是 profile 而不是频道场景：同一 profile 的十几个频道实例共享一组 stdio 子进程，
 * 每个频道各起一份会成倍放大进程数与内存，工具目录却完全一样。
 *
 * 建池是同步的（读配置是同步 IO），连接是异步的：池一建好就并发握手，扩展包的钩子 await
 * {@link connecting} 再取工具面与提示词，所以首轮拿到的是握手收尾后的快照——连上的都在，
 * 失败的已经按各自那条 error 日志跳过。此后 server 报目录变更就地重建工具面，下一轮生效，
 * 不需要任何重新装配。
 */
export class ProfilePool {
  private readonly connections: McpConnection[] = [];
  /**
   * 握手收尾的 Promise：建池那一刻就开跑。每个 server 的成败各自 catch，所以它只 resolve；
   * 已经 settled 时 await 只是一个微任务，调用方每轮等它都是零成本。
   */
  public readonly connecting: Promise<void>;
  private users = 0;

  constructor(
    public readonly directory: string,
    private readonly fallback: string,
    private readonly limits: OutputLimits,
    private readonly logger: Logger,
  ) {
    const servers = readServers(directory, fallback, logger);
    this.connecting = this.connect(servers);
  }

  private async connect({ mcpServers, disabledServers, enabledServers }: McpConfig): Promise<void> {
    const total = Object.keys(mcpServers).length;
    /** 真要连的 server，按配置顺序；关掉的与坏配置在这里就筛掉，不占握手时间。 */
    const pending: Array<{ name: string; server: McpServer }> = [];
    for (const [name, raw] of Object.entries(mcpServers)) {
      // 白名单压过一切：它存在的意义就是强行打开别处关掉的 server，所以先判它。
      if (disabledServers.includes(name) && !enabledServers.includes(name)) {
        this.logger.info(`mcp server "${name}" is disabled`);
        continue;
      }
      let server;
      try {
        server = ServerConfig(raw);
      } catch (error) {
        this.logger.error(`mcp server "${name}" is misconfigured: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!server.enabled && !enabledServers.includes(name)) {
        this.logger.info(`mcp server "${name}" is disabled`);
        continue;
      }
      pending.push({ name, server });
    }

    // 并发握手：stdio server 常要现场解析或装依赖（uvx 起 python server 是秒级），串行会把总时长加成各自之和。
    // Promise.all 保序，落回 connections 的顺序仍是配置顺序——提示词增量按它拼，不该由谁先连上决定。
    const connected = await Promise.all(
      pending.map(async ({ name, server }) => {
        try {
          const connection = await McpConnection.connect(name, server, this.limits, this.logger);
          this.logger.info(`mcp server "${name}" connected`);
          return connection;
        } catch (error) {
          this.logger.error(`mcp server "${name}" connection failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      }),
    );
    this.connections.push(...connected.filter((connection): connection is McpConnection => connection !== undefined));

    // 逐条结果上面已经报过；这里是这一组的落点，一眼看出配了几个、连上几个。
    // 一个都没配就不报，那条「not found / 0 server(s)」已经说明白了。
    if (total > 0) this.logger.info(`mcp pool for ${this.directory}: ${this.connections.length}/${total} servers connected`);
  }

  /** 登记一个使用者。每个频道实例挂载时一次。 */
  public hold(): void {
    this.users += 1;
  }

  /** 本组当前提供的全部工具。每轮由内核现取，所以只在这里拼一次。 */
  public tools(): ToolSet {
    return Object.assign({}, ...this.connections.map((connection) => connection.tools));
  }

  /** 各 server 自述的说明，拼成提示词增量。 */
  public instructions(): string | undefined {
    const texts = this.connections.map((connection) => connection.instructions).filter((text): text is string => text !== undefined && text.length > 0);
    return texts.length === 0 ? undefined : texts.join("\n\n");
  }

  /** 放掉一个使用者；归零时关掉整组。连接仍在进行就先等它完，免得关一半。 */
  public async release(): Promise<void> {
    this.users -= 1;
    if (this.users > 0) return;
    await this.connecting;
    await Promise.all(this.connections.map((connection) => connection.close()));
    this.logger.info(`mcp connections closed for ${this.directory}`);
  }
}

/**
 * 读一个 profile 的 mcp 配置。
 *
 * profile 目录下有 `mcp.json` 就用它，没有就落回数据根那份——完全替换，不是叠加。
 * 两处都没有时给一份空配置：这个 profile 就是没有 MCP 工具，不算错误。
 */
function readServers(directory: string, fallback: string, logger: Logger): McpConfig {
  const candidates = [path.join(directory, "mcp.json"), fallback];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      // JSON.parse 的结果直接交给 Schema：形状的判定全在那边，这里不预判。
      const config = McpConfig(JSON.parse(readFileSync(file, "utf8")) as McpConfig);
      logger.info(`mcp config for ${directory} loaded from ${file}: ${Object.keys(config.mcpServers).length} server(s)`);
      return config;
    } catch (error) {
      logger.error(`mcp config ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`);
      return { mcpServers: {}, disabledServers: [], enabledServers: [] };
    }
  }
  // 两处都没有不是错误：这个 profile 就是没有 MCP 工具，但要说一声，并列出找过的路径。
  logger.info(`mcp config for ${directory} not found, tried ${candidates.join(" and ")}`);
  return { mcpServers: {}, disabledServers: [], enabledServers: [] };
}
