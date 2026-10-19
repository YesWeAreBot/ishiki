import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { ToolConflictError } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfilePool } from "../src/pool.js";
import { McpConnection } from "../src/server.js";
import { BLOCKS, NOTES, PNG, startMcpServer, type McpFixture } from "./fixture.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

interface SchemaNode {
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  items?: SchemaNode;
}

/** 声明 schema 是否有一条显式分支描述这个块：判别字段命中且必需字段都在。 */
function describes(schema: SchemaNode, block: { type: string }): boolean {
  return (schema.items?.anyOf ?? []).some((branch) => {
    const discriminant = branch.properties?.type ?? {};
    const names = [discriminant.const, ...(discriminant.enum ?? [])].filter((name): name is string => typeof name === "string");
    return names.includes(block.type) && (branch.required ?? []).every((key) => key in block);
  });
}

let fixture: McpFixture;

beforeEach(async () => {
  fixture = await startMcpServer();
});

afterEach(async () => {
  await fixture.close();
});

describe("MCP tools", () => {
  it("keeps execute raw and converts only in toModelOutput", async () => {
    const connection = await McpConnection.connect("t", { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true }, silent);
    try {
      const tool = connection.tools.t_look;
      expect(tool).toBeDefined();
      expect(Object.keys(connection.tools)).toEqual(["t_look", "t_peek"]);

      const output = await tool!.execute!({ what: "pic" }, { toolCallId: "c1", messages: [] });
      // execute 交回平台原始块：不替换媒体、不截断、不生成任何引用。
      expect(output).toEqual(BLOCKS);

      const converted = tool!.toModelOutput!({ toolCallId: "c1", input: { what: "pic" }, output });
      expect(converted).toEqual({
        type: "content",
        value: [
          { type: "text", text: "看这里" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: PNG.toString("base64") } },
          { type: "file", mediaType: "text/markdown", data: { type: "data", data: NOTES.toString("base64") } },
          { type: "text", text: "[resource link: https://example.com/report.pdf]" },
        ],
      });

      // 声明的 output schema 必须覆盖 execute 真正交回的每种块。
      const { jsonSchema } = tool!.outputSchema as unknown as { jsonSchema: SchemaNode };
      for (const block of BLOCKS) expect(describes(jsonSchema, block)).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("falls back to the tool index when a server has no instructions", async () => {
    const connection = await McpConnection.connect("t", { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true }, silent);
    try {
      expect(connection.summary).toBe("### t\nTools: t_look, t_peek");
    } finally {
      await connection.close();
    }
  });

  it("drops the server name prefix when prefix is false", async () => {
    const connection = await McpConnection.connect(
      "t",
      { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true, prefix: false },
      silent,
    );
    try {
      expect(Object.keys(connection.tools)).toEqual(["look", "peek"]);
      expect(connection.summary).toBe("### t\nTools: look, peek");
    } finally {
      await connection.close();
    }
  });

  it("uses a custom string prefix", async () => {
    const connection = await McpConnection.connect(
      "t",
      { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true, prefix: "mcp" },
      silent,
    );
    try {
      expect(Object.keys(connection.tools)).toEqual(["mcp_look", "mcp_peek"]);
    } finally {
      await connection.close();
    }
  });

  it("denies tools by their raw names before prefixing", async () => {
    const connection = await McpConnection.connect(
      "t",
      { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true, prefix: "mcp", deny: ["peek"] },
      silent,
    );
    try {
      expect(Object.keys(connection.tools)).toEqual(["mcp_look"]);
      expect(connection.summary).toBe("### t\nTools: mcp_look");
    } finally {
      await connection.close();
    }
  });

  it("applies prefix and deny from a profile mcp.json", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ishiki-mcp-tools-"));
    await writeFile(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: { t: { type: "http", url: fixture.url, prefix: "mcp", deny: ["peek"] } } }));
    const pool = new ProfilePool(directory, path.join(directory, "fallback.json"), silent);
    try {
      await pool.connecting;
      expect(Object.keys(pool.tools())).toEqual(["mcp_look"]);
    } finally {
      await pool.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects identical exposed names from different servers", async () => {
    const second = await startMcpServer();
    const directory = await mkdtemp(path.join(os.tmpdir(), "ishiki-mcp-tools-"));
    await writeFile(
      path.join(directory, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          a: { type: "http", url: fixture.url, prefix: false },
          b: { type: "http", url: second.url, prefix: false },
        },
      }),
    );
    const pool = new ProfilePool(directory, path.join(directory, "fallback.json"), silent);
    try {
      await pool.connecting;
      expect(() => pool.tools()).toThrow(ToolConflictError);
    } finally {
      await pool.close();
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the tool index independent from server instructions", async () => {
    const withIndex = await McpConnection.connect(
      "t",
      { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: false, toolIndex: true },
      silent,
    );
    try {
      expect(withIndex.summary).toBe("### t\nTools: t_look, t_peek");
    } finally {
      await withIndex.close();
    }

    const withoutIndex = await McpConnection.connect(
      "t",
      { type: "http", url: fixture.url, headers: {}, enabled: true, instructions: true, toolIndex: false },
      silent,
    );
    try {
      expect(withoutIndex.summary).toBeUndefined();
    } finally {
      await withoutIndex.close();
    }
  });
});
