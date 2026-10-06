import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "koishi";
import { jsonSchema, tool, type ToolResultOutput, type ToolSet } from "koishi-plugin-ishiki";

import type { McpServer } from "./config.js";

export interface OutputLimits {
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxImageCount: number;
  maxOutputChars: number;
}

export class McpConnection {
  public instructions?: string;

  public tools: ToolSet = {};

  private closed = false;

  private constructor(
    public readonly name: string,
    private readonly client: Client,
    private readonly server: McpServer,
    private readonly limits: OutputLimits,
    private readonly logger: Logger,
  ) {}

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
        throw new TypeError(`unsupported transport: ${(server as McpServer).type}`);
    }

    const connection = new McpConnection(name, client, server, limits, logger);
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await connection.refresh();
    });
    await connection.refresh();
    return connection;
  }

  private async refresh(): Promise<void> {
    const listed = await this.client.listTools();
    const tools: ToolSet = {};
    const used = new Set<string>();
    for (const declared of listed.tools) {
      const exposed = uniqueName(`${this.name}-${safeName(declared.name)}`, used);
      tools[exposed] = tool({
        description: declared.description,
        inputSchema: jsonSchema(declared.inputSchema as Record<string, unknown>),
        execute: (params) => this.call(declared.name, params),
        toModelOutput: ({ output }) => renderOutput(output as McpBlock[], this.limits),
      });
    }
    this.tools = Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)));
    this.logger.debug(`mcp server "${this.name}" exposes ${Object.keys(this.tools).join(", ") || "no tools"}`);
    if (this.server.instructions) this.instructions = this.client.getInstructions();
  }

  private async call(toolName: string, params: unknown): Promise<McpBlock[]> {
    this.logger.debug(`mcp tool "${this.name}/${toolName}" called`);
    const result = await this.client.callTool(
      { name: toolName, arguments: structuredClone(params as Record<string, unknown>) },
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

interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

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

function decodeImage(base64: string, maxBytes: number): Uint8Array | undefined {
  if (base64.length === 0) return undefined;
  const bytes = Buffer.from(base64, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : undefined;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "mcp";
}

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
