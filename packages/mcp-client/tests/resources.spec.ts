import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { ResourceError } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfilePool } from "../src/pool.js";
import { McpResourceHandler } from "../src/resource-schemes.js";
import { NOTES, PNG, startMcpServer, type McpFixture } from "./fixture.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

let fixture: McpFixture;
let directory: string;
let pool: ProfilePool;

beforeEach(async () => {
  fixture = await startMcpServer();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-mcp-resource-"));
  // 走生产装配：真实 mcp.json → ProfilePool 连接 → 真实 readResource。
  await fs.writeFile(path.join(directory, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { type: "http", url: fixture.url } } }));
  pool = new ProfilePool(directory, path.join(directory, "fallback.json"), silent);
  await pool.connecting;
});

afterEach(async () => {
  await pool.close();
  await fixture.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("mcp resource URL", () => {
  it("passes the wrapped URI to its server verbatim, query and nested scheme included", async () => {
    const url = "mcp://fixture/notes://a/b.md?view=meta&offset=3:9#intro";
    const payload = await new McpResourceHandler(pool).resolve(url);
    expect(fixture.resourceUris).toEqual(["notes://a/b.md?view=meta&offset=3:9#intro"]);
    expect(payload).toMatchObject({
      type: "text",
      url,
      text: NOTES.toString("utf8"),
      mediaType: "text/markdown",
      size: NOTES.byteLength,
    });
  });

  it("returns remote media as live files carrying the raw bytes", async () => {
    const url = "mcp://fixture/art://pic.png";
    const payload = await new McpResourceHandler(pool).resolve(url);
    expect(fixture.resourceUris).toEqual(["art://pic.png"]);
    expect(payload).toMatchObject({ type: "file", url, mediaType: "image/png", size: PNG.byteLength, immutable: false });
    if (payload.type !== "file") throw new Error(`expected a file payload, got ${payload.type}`);
    expect([...payload.bytes]).toEqual([...PNG]);
  });

  it("rejects URLs without a server or a wrapped URI before contacting any server", async () => {
    const handler = new McpResourceHandler(pool);
    await expect(handler.resolve("mcp://fixture")).rejects.toBeInstanceOf(ResourceError);
    await expect(handler.resolve("mcp:///resource")).rejects.toBeInstanceOf(ResourceError);
    expect(fixture.resourceUris).toEqual([]);
  });
});
