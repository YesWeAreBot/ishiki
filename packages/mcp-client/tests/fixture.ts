import { createServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
export const NOTES = Buffer.from("笔记正文", "utf8");

export const BLOCKS: CallToolResult["content"] = [
  { type: "text", text: "看这里" },
  { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
  { type: "resource", resource: { uri: "memo://note", mimeType: "text/markdown", blob: NOTES.toString("base64") } },
  { type: "resource_link", uri: "https://example.com/report.pdf", name: "report.pdf", mimeType: "application/pdf" },
];

export interface McpFixture {
  readonly url: string;
  readonly resourceUris: string[];
  close(): Promise<void>;
}

/** Stateless MCP transports belong to one HTTP request, including initialization notifications. */
export async function startMcpServer(): Promise<McpFixture> {
  const resourceUris: string[] = [];
  const active = new Set<Server>();
  const http = createServer(async (request, response) => {
    const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
    active.add(server);
    response.once("close", () => {
      active.delete(server);
      void server.close();
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "look", description: "看一眼", inputSchema: { type: "object", properties: { what: { type: "string" } } } },
        { name: "peek", description: "瞄一眼", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: BLOCKS }));
    server.setRequestHandler(ReadResourceRequestSchema, async (input): Promise<ReadResourceResult> => {
      const uri = input.params.uri;
      resourceUris.push(uri);
      if (uri.endsWith(".png")) return { contents: [{ uri, mimeType: "image/*", blob: PNG.toString("base64") }] };
      return { contents: [{ uri, mimeType: "text/markdown", text: NOTES.toString("utf8") }] };
    });
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    resourceUris,
    close: async () => {
      await Promise.all([...active].map((server) => server.close()));
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
