import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";
import type { ResourceCenter, ToolSet } from "koishi-plugin-ishiki";

import { McpConfig, ServerConfig, type McpServer } from "./config.js";
import { McpConnection, type OutputLimits, type OutputSpiller } from "./server.js";

export class ProfilePool {
  private readonly connections: McpConnection[] = [];
  public readonly connecting: Promise<void>;
  private users = 0;
  private spiller?: OutputSpiller;

  constructor(
    public readonly directory: string,
    private readonly fallback: string,
    private readonly limits: OutputLimits,
    private readonly logger: Logger,
  ) {
    const servers = readServers(directory, fallback, logger);
    this.connecting = this.connect(servers);
  }

  /** Attach the calling runtime's resource center so truncated output spills to its artifacts. */
  public setResources(resources: ResourceCenter | undefined): void {
    this.spiller = resources
      ? {
          spill: async (tool, content) => {
            const url = await resources.artifactSpill(tool, content);
            return { url, sandboxPath: `/artifacts/${url.slice("artifact://".length)}` };
          },
        }
      : undefined;
    for (const connection of this.connections) connection.spiller = this.spiller;
  }

  private async connect({ mcpServers, disabledServers, enabledServers }: McpConfig): Promise<void> {
    const total = Object.keys(mcpServers).length;
    const pending: Array<{ name: string; server: McpServer }> = [];
    for (const [name, raw] of Object.entries(mcpServers)) {
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

    const connected = await Promise.all(
      pending.map(async ({ name, server }) => {
        try {
          const connection = await McpConnection.connect(name, server, this.limits, this.logger, this.spiller);
          this.logger.info(`mcp server "${name}" connected`);
          return connection;
        } catch (error) {
          this.logger.error(`mcp server "${name}" connection failed: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      }),
    );
    this.connections.push(...connected.filter((connection): connection is McpConnection => connection !== undefined));

    if (total > 0) this.logger.info(`mcp pool for ${this.directory}: ${this.connections.length}/${total} servers connected`);
  }

  public tools(): ToolSet {
    return Object.assign({}, ...this.connections.map((connection) => connection.tools));
  }

  public instructions(): string | undefined {
    const texts = this.connections.map((connection) => connection.instructions).filter((text): text is string => text !== undefined && text.length > 0);
    return texts.length === 0 ? undefined : texts.join("\n\n");
  }

  public async close(): Promise<void> {
    await this.connecting;
    await Promise.all(this.connections.map((connection) => connection.close()));
    this.logger.info(`mcp connections closed for ${this.directory}`);
  }
}

function readServers(directory: string, fallback: string, logger: Logger): McpConfig {
  const candidates = [path.join(directory, "mcp.json"), fallback];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const config = McpConfig(JSON.parse(readFileSync(file, "utf8")) as McpConfig);
      logger.info(`mcp config for ${directory} loaded from ${file}: ${Object.keys(config.mcpServers).length} server(s)`);
      return config;
    } catch (error) {
      logger.error(`mcp config ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`);
      return { mcpServers: {}, disabledServers: [], enabledServers: [] };
    }
  }
  logger.info(`mcp config for ${directory} not found, tried ${candidates.join(" and ")}`);
  return { mcpServers: {}, disabledServers: [], enabledServers: [] };
}
