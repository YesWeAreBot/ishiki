import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "koishi";
import { jsonSchema, tool, ResourceError, type ToolSet } from "koishi-plugin-ishiki";

import type { McpServer } from "./config.js";

export class McpConnection {
  public instructions?: string;

  public tools: ToolSet = {};

  private closed = false;

  private constructor(
    public readonly name: string,
    private readonly client: Client,
    private readonly server: McpServer,
    private readonly logger: Logger,
  ) {}

  public static async connect(name: string, server: McpServer, logger: Logger): Promise<McpConnection> {
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

    const connection = new McpConnection(name, client, server, logger);
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
        outputSchema: jsonSchema<McpBlock[]>({
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              text: { type: "string" },
              data: { type: "string", description: "Base64 media bytes" },
              mimeType: { type: "string" },
              resource: {
                type: "object",
                properties: { uri: { type: "string" }, text: { type: "string" }, blob: { type: "string" }, mimeType: { type: "string" } },
              },
            },
            required: ["type"],
            additionalProperties: true,
          },
        }),
        toModelOutput: ({ output }) => ({ type: "json", value: output as never }),
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
}

interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
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
