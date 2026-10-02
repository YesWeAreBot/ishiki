import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "koishi";
import { jsonSchema, tool, type ToolResultOutput, type ToolSet } from "koishi-plugin-ishiki";

import type { McpServer } from "./config.js";

/** 单次工具调用的出口限额；缺省值由插件配置补上（见 `IshikiMcpClient.limits`）。 */
export interface OutputLimits {
  /** 单张图片的字节上限。 */
  maxImageBytes: number;
  /** 单次调用里全部图片合计的字节上限。 */
  maxTotalImageBytes: number;
  /** 单次调用最多带几张图片。 */
  maxImageCount: number;
  /** 文本面的字符上限。 */
  maxOutputChars: number;
}

/** 一条连接：本 server 的 client、它当前提供的工具，以及那点发布说明。 */
export class McpConnection {
  /** 该 server 自述的用途说明；取不到就是 undefined，不占提示词。 */
  public instructions?: string;

  /** 当前提供的工具，按对外名字排好序。每轮工具面重算时读它。 */
  public tools: ToolSet = {};

  private closed = false;

  private constructor(
    public readonly name: string,
    private readonly client: Client,
    private readonly server: McpServer,
    private readonly limits: OutputLimits,
    private readonly logger: Logger,
  ) {}

  /** 连一个 server；失败抛错，由调用方记一条日志并跳过这一个。 */
  public static async connect(name: string, server: McpServer, limits: OutputLimits, logger: Logger): Promise<McpConnection> {
    const client = new Client({ name, version: "1.0.0" });
    switch (server.type) {
      case "stdio":
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: server.env, cwd: server.cwd }));
        break;
      case "http":
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
        break;
      case "sse":
        await client.connect(new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
        break;
      default:
        // 类型是封闭的联合，走到这里只可能是有人绕过了 Schema 塞进来一份别的东西。
        throw new TypeError(`unsupported transport: ${(server as McpServer).type}`);
    }

    const connection = new McpConnection(name, client, server, limits, logger);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      // 目录变了就地重建：内核每轮现取工具面，下一轮自然生效，不需要重新装配什么。
      await connection.refresh();
    });
    await connection.refresh();
    return connection;
  }

  /** 重新列一次工具。server 报目录变更时调用，也是连接建立后的第一步。 */
  private async refresh(): Promise<void> {
    const listed = await this.client.listTools();
    const tools: ToolSet = {};
    const used = new Set<string>();
    for (const declared of listed.tools) {
      const exposed = uniqueName(`${this.name}-${safeName(declared.name)}`, used);
      tools[exposed] = tool({
        description: declared.description,
        // MCP 声明的输入 schema 本来就是标准 JSON Schema，原样交给 core。
        inputSchema: jsonSchema(declared.inputSchema as Record<string, unknown>),
        execute: (params) => this.call(declared.name, params),
        // 内容面自己裁：core 见到非字符串的返回值会 JSON.stringify，图片字节会被它烤成一坨。
        toModelOutput: ({ output }) => renderOutput(output as McpBlock[], this.limits),
      });
    }
    this.tools = Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)));
    this.logger.debug(`mcp server "${this.name}" exposes ${Object.keys(this.tools).join(", ") || "no tools"}`);
    if (this.server.instructions) this.instructions = this.client.getInstructions();
  }

  /** 调一次工具。server 报的错原样抛出去，让 core 记成 `error-text`。 */
  private async call(toolName: string, params: unknown): Promise<McpBlock[]> {
    this.logger.debug(`mcp tool "${this.name}/${toolName}" called`);
    const result = await this.client.callTool(
      { name: toolName, arguments: structuredClone(params as Record<string, unknown>) },
      // 结果校验用 SDK 默认那份；只有请求时限是本次调用自己定的。
      undefined,
      this.server.timeout === undefined ? undefined : { timeout: this.server.timeout },
    );
    const content = (result.content ?? []) as McpBlock[];
    if (result.isError) throw new Error(content.map((block) => block.text ?? `[${block.type}]`).join("\n"));
    return content;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
    this.logger.debug(`mcp server "${this.name}" disconnected`);
  }
}

/** MCP 的内容块：只认协议定义的这几种形状，其余按未知处理。 */
interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * 工具结果转成 core 的内容面：文本原样，图片交字节。
 *
 * 字节走 `content` 的 `file` 部件而不是文本：`native` 引擎下 `ai` SDK 直接把它序列化成
 * 多模态部件，解析协议各家族也按部件投递。写成文字就等于把图片丢一次。
 *
 * 超出限额的那几张降级成一行说明而不是丢弃：模型知道有过这张图，比看到空结果强。
 */
function renderOutput(blocks: McpBlock[], limits: OutputLimits): ToolResultOutput {
  const parts: NonNullable<Extract<ToolResultOutput, { type: "content" }>["value"]> = [];
  let images = 0;
  let totalBytes = 0;
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      lines.push(block.text ?? "");
      continue;
    }
    if (block.type !== "image") {
      lines.push(`[${block.type}]`);
      continue;
    }

    const mediaType = block.mimeType?.toLowerCase();
    const bytes = block.data === undefined ? undefined : decodeImage(block.data, limits.maxImageBytes);
    if (mediaType === undefined || bytes === undefined) {
      lines.push("[图片：数据无效或大小超出限制]");
      continue;
    }
    if (images >= limits.maxImageCount || totalBytes + bytes.byteLength > limits.maxTotalImageBytes) {
      lines.push("[图片：超出本次调用的图片限额]");
      continue;
    }
    images += 1;
    totalBytes += bytes.byteLength;
    parts.push({ type: "file", mediaType, data: { type: "data", data: bytes } });
  }

  const text = lines.join("\n").trim().slice(0, limits.maxOutputChars);
  if (text.length > 0) parts.unshift({ type: "text", text });
  return { type: "content", value: parts };
}

/** 解一张内联图片；解码失败或超出单张上限时返回 undefined，不抛。 */
function decodeImage(base64: string, maxBytes: number): Uint8Array | undefined {
  if (base64.length === 0) return undefined;
  const bytes = Buffer.from(base64, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : undefined;
}

/** 非 `[A-Za-z0-9_-]` 的字符折成 `_`；全折没了退回 `mcp`，名字不能为空。 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "mcp";
}

/** 清洗后的名字再撞名就加数字后缀：同一 server 里两个工具清洗后同名是常事。 */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  const unique = `${base}_${suffix}`;
  used.add(unique);
  return unique;
}
