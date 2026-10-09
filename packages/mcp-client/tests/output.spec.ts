import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expect, it } from "vitest";

import { processOutput } from "../../koishi-plugin-ishiki/src/attachment/output.js";
import { ResourceCenter } from "../../koishi-plugin-ishiki/src/resources/center.js";
import { McpConnection } from "../src/server.js";

it("keeps real MCP text and image blocks intact until the outer conversion", async () => {
  const text = "long MCP text\n".repeat(3000);
  const image = "iVBORw0KGgo=";
  const blocks = [
    { type: "text" as const, text },
    { type: "image" as const, mimeType: "image/png", data: image },
  ];
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const mcp = new McpServer({ name: "fixture", version: "1.0" });
  mcp.registerTool("screenshot", { description: "test screenshot", inputSchema: {} }, async () => ({ content: blocks }));
  await mcp.connect(transport);
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-mcp-"));
  const center = new ResourceCenter("mcp", home);
  const connection = await McpConnection.connect(
    "fixture",
    { type: "http", url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, enabled: true, instructions: false },
    { debug() {} } as never,
  );
  try {
    const exposed = connection.tools["fixture-screenshot"]!;
    const output = await exposed.execute!({}, { toolCallId: "c", messages: [] });
    expect(output).toEqual(blocks);
    expect(exposed.outputSchema).toBeDefined();
    expect(await center.store.namespaces("artifact")).toEqual([]);
    const native = await exposed.toModelOutput!({ toolCallId: "c", input: {}, output });
    const processed = await processOutput(center, "fixture-screenshot", "c", output, native);
    expect(processed.items).toHaveLength(1);
    expect(JSON.stringify(processed.output)).not.toContain(image);
    expect(processed.output).toMatchObject({ type: "text", value: expect.stringContaining("long MCP text") });
    expect(output).toEqual(blocks);
  } finally {
    await connection.close();
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(home, { force: true, recursive: true });
  }
}, 15000);
