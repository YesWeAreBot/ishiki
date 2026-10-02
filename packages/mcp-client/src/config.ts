import { Schema } from "koishi";

/**
 * 校验走两级，因为坏配置的代价不该一样大：
 *
 * - 顶层（{@link McpConfig}）形状不对，这份文件整份丢弃——`mcpServers` 不是字典时
 *   后面的键值对无从谈起，继续解析只会得到一堆垃圾。
 * - 单个 server（{@link ServerConfig}）形状不对，只跳过这一个，其余照连。
 *
 * 所以顶层把 `mcpServers` 的值声明成 `Schema.any()`：一条写错的 `command` 不至于把整份配置打死，
 * 真正的校验在每个 server 上单独做。
 */

/** 三个传输共有的字段。`instructions` 关掉的只是提示词，工具照给。 */
const ServerBase = Schema.object({
  /** 是否连这个 server。`false` 表示完全不连。 */
  enabled: Schema.boolean().default(true),
  /** 单次请求的超时（毫秒），交给 SDK 的 `RequestOptions.timeout`；0 表示不限。 */
  timeout: Schema.number(),
  /** 该 server 用 `getInstructions()` 声明的说明要不要进提示词。 */
  instructions: Schema.boolean().default(true),
});

/** stdio：起子进程，用标准输入输出通信。`type` 可省，缺省按 stdio。 */
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

/** streamable HTTP：一次请求一个响应，或升级成 SSE 流。 */
export interface McpHttpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  instructions: boolean;
}

/** 旧版 SSE，只为兼容仍在跑的 server 保留；新配置写 `http`。 */
export interface McpSseServer {
  type: "sse";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeout?: number;
  instructions: boolean;
}

/**
 * 一个 server 的完整形状，按 `type` 判别。
 *
 * 三个分支的必填字段都带 `.required()`：schemastery 的 `.required()` 只在 object 上标记整体，
 * 字段级的强制要写在这里。少了它，`{ "url": "…" }` 会被 stdio 分支放行、补出空 `args` 与 `env`，
 * 然后在连接时以一个更难懂的方式失败。
 */
export type McpServer = McpStdioServer | McpHttpServer | McpSseServer;

export const ServerConfig: Schema<McpServer> = Schema.intersect([
  ServerBase,
  Schema.union([
    Schema.object({
      type: Schema.union(["stdio"]).default("stdio"),
      command: Schema.string().required(),
      args: Schema.array(Schema.string()).default([]),
      // env 只覆盖，不继承父进程环境：SDK 的 `getDefaultEnvironment()` 给的是一份白名单。
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

/** 一份 mcp 配置文件的形状：哪些 server、哪些不开、哪些强行开。 */
export interface McpConfig {
  mcpServers: Record<string, McpServer>;
  /** 名单里的 server 一律不连，压过其余任何设置。 */
  disabledServers: string[];
  /** 白名单：强行打开名单里的 server，压过 `enabled: false`。 */
  enabledServers: string[];
}

export const McpConfig: Schema<McpConfig> = Schema.object({
  mcpServers: Schema.dict(Schema.any()).default({}),
  disabledServers: Schema.array(Schema.string()).default([]),
  enabledServers: Schema.array(Schema.string()).default([]),
});
