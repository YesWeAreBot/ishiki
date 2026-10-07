import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "koishi";
import { jsonSchema, tool, ResourceError, type ToolResultOutput, type ToolSet } from "koishi-plugin-ishiki";

import type { McpServer } from "./config.js";

export interface OutputLimits {
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxImageCount: number;
  maxOutputChars: number;
}

/** Receives truncated tool output and tool-returned media; wired to the runtime's resource center. */
export interface OutputSpiller {
  spill(tool: string, content: string): Promise<{ url: string; sandboxPath: string }>;
  /** Persist a tool-returned image and return its asset:// URL. */
  sinkImage?(tool: string, bytes: Uint8Array, mediaType: string): Promise<string>;
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

  /** Truncated text output spills here when the calling runtime provides a resource center. */
  public spiller?: OutputSpiller;

  public static async connect(name: string, server: McpServer, limits: OutputLimits, logger: Logger, spiller?: OutputSpiller): Promise<McpConnection> {
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
    connection.spiller = spiller;
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
        toModelOutput: ({ output }) => this.render(output as McpBlock[], exposed),
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

  /** Read a resource from this server; text and base64 blobs both supported. */
  public async readResource(resourceUri: string): Promise<{ uri: string; text?: string; blob?: string; mimeType?: string }> {
    const result = await this.client.readResource({ uri: resourceUri });
    const first = result.contents[0];
    if (!first) throw new ResourceError("resource_not_found", `mcp resource not found: ${resourceUri}`);
    if ("blob" in first) return { uri: first.uri, blob: first.blob, mimeType: first.mimeType };
    return { uri: first.uri, text: first.text, mimeType: first.mimeType };
  }

  private async render(blocks: McpBlock[], exposedTool: string): Promise<ToolResultOutput> {
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
      const bytes = block.data === undefined ? undefined : decodeImage(block.data, this.limits.maxImageBytes);
      if (mediaType === undefined || bytes === undefined) {
        lines.push("[图片：数据无效或大小超出限制]");
        continue;
      }
      if (images >= this.limits.maxImageCount || totalBytes + bytes.byteLength > this.limits.maxTotalImageBytes) {
        lines.push("[图片：超出本次调用的图片限额]");
        continue;
      }
      images += 1;
      totalBytes += bytes.byteLength;
      if (this.spiller?.sinkImage) {
        // 图片固化成 asset：上下文里只留 URL，模型要看图时再 read。
        const assetUrl = await this.spiller.sinkImage(exposedTool, bytes, mediaType);
        lines.push(`[image: ${assetUrl}]`);
      } else {
        parts.push({ type: "file", mediaType, data: { type: "data", data: bytes } });
      }
    }

    const joined = lines.join("\n").trim();
    let text = joined.slice(0, this.limits.maxOutputChars);
    if (joined.length > this.limits.maxOutputChars && this.spiller !== undefined) {
      try {
        const { url, sandboxPath } = await this.spiller.spill(exposedTool, joined);
        text += `\n[输出超出 ${this.limits.maxOutputChars} 字符，已截断] 完整输出：${url}（read 它，或在沙箱里访问 ${sandboxPath}）`;
      } catch (error) {
        this.logger.warn(`mcp spill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (text.length > 0) parts.unshift({ type: "text", text });
    return { type: "content", value: parts };
  }
}

interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
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
