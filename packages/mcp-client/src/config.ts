import { Schema } from "koishi";

const ServerBase = Schema.object({
  enabled: Schema.boolean().default(true),
  timeout: Schema.number(),
  instructions: Schema.boolean().default(true),
});

export interface McpStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  timeout?: number;
  instructions: boolean;
}

export interface McpHttpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  instructions: boolean;
}

export interface McpSseServer {
  type: "sse";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  instructions: boolean;
}

export type McpServer = McpStdioServer | McpHttpServer | McpSseServer;

export const ServerConfig: Schema<McpServer> = Schema.intersect([
  ServerBase,
  Schema.union([
    Schema.object({
      type: Schema.union(["stdio"]).default("stdio"),
      command: Schema.string().required(),
      args: Schema.array(Schema.string()).default([]),
      env: Schema.dict(Schema.string()).default({}),
      cwd: Schema.string(),
    }),
    Schema.object({
      type: Schema.union(["http"]).required(),
      url: Schema.string().required(),
      headers: Schema.dict(Schema.string()).default({}),
    }),
    Schema.object({
      type: Schema.union(["sse"]).required(),
      url: Schema.string().required(),
      headers: Schema.dict(Schema.string()).default({}),
    }),
  ]),
]);

export interface McpConfig {
  mcpServers: Record<string, McpServer>;
  disabledServers: string[];
  enabledServers: string[];
}

export const McpConfig: Schema<McpConfig> = Schema.object({
  mcpServers: Schema.dict(Schema.any()).default({}),
  disabledServers: Schema.array(Schema.string()).default([]),
  enabledServers: Schema.array(Schema.string()).default([]),
});
