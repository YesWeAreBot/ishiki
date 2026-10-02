import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { McpConfig, ServerConfig, type McpConfig as McpConfigShape, type McpServer } from "../src/config.js";

/**
 * 运行时那份 Schema 与 `resources/mcp.schema.json` 是同一形状的两份声明。
 * 它们不会互相引用，只能靠这里对账：改了一边忘了另一边，编辑器放过但运行时报错。
 */

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode & { enum?: string[] }>;
  required?: string[];
  allOf?: JsonSchemaNode[];
}

interface SchemaDocument {
  properties?: Record<string, JsonSchemaNode>;
  $defs?: Record<string, JsonSchemaNode>;
}

function readResource(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../resources/${name}`, import.meta.url)), "utf8");
}

const SCHEMA = JSON.parse(readResource("mcp.schema.json")) as SchemaDocument;
const EXAMPLE = JSON.parse(readResource("mcp.example.json")) as { mcpServers: Record<string, unknown> };

/** 一个传输的字段名，按声明排好序。JSON Schema 里共有的那几个也在这一段重复声明过，取并集。 */
function ownFields(def: string): string[] {
  const node = SCHEMA.$defs?.[def];
  const own = node?.allOf?.[1] ?? node;
  return Object.keys(own?.properties ?? {});
}

/** 运行时 Schema 实际接受的字段：从一次通过校验的输出上读。 */
function accepted(raw: Record<string, unknown>): string[] {
  // Schema 的入参类型就是解析结果本身；字段名从校验结果上读，形状的判定全交给它。
  return Object.keys(ServerConfig(raw as unknown as McpServer));
}

/** 校验应当被拒的形状：过 `unknown` 再交给 Schema，让它自己报出不收。 */
function rejects(raw: unknown): boolean {
  try {
    ServerConfig(raw as McpServer);
  } catch {
    return true;
  }
  return false;
}

/** 三个传输共有的字段；JSON Schema 声明在 `serverBase` 并在各传输里重复，运行时由 base 段填上。 */
const BASE_FIELDS = ["enabled", "instructions", "timeout"];

describe("配置的两份声明对得上", () => {
  it("顶层字段名一致", () => {
    expect(Object.keys(SCHEMA.properties ?? {}).sort()).toEqual(["$schema", "disabledServers", "enabledServers", "mcpServers"]);
    // `$schema` 只给编辑器看，运行时 Schema 不收它。
    expect(Object.keys(McpConfig({} as McpConfigShape)).sort()).toEqual(["disabledServers", "enabledServers", "mcpServers"]);
  });

  it("三个传输各自的字段名一致", () => {
    // 每个字段都给值：可选且无缺省值的键（cwd / timeout）缺席时不落在校验结果上，
    // 那样比出来的只是「这次写了什么」，不是「这份配置收什么」。
    for (const [def, raw] of [
      ["stdioServer", { command: "x", args: [], env: {}, cwd: ".", timeout: 1, enabled: true, instructions: true }],
      ["httpServer", { type: "http", url: "http://a", headers: {}, timeout: 1, enabled: true, instructions: true }],
      ["sseServer", { type: "sse", url: "http://a", headers: {}, timeout: 1, enabled: true, instructions: true }],
    ] as const) {
      expect(accepted(raw).sort(), `${def} 的字段名与 JSON Schema 不一致`).toEqual([...new Set([...ownFields(def), ...BASE_FIELDS])].sort());
    }
  });

  it("type 的枚举值一致", () => {
    expect(SCHEMA.$defs?.stdioServer?.allOf?.[1]?.properties?.type?.enum).toEqual(["stdio"]);
    expect(SCHEMA.$defs?.httpServer?.allOf?.[1]?.properties?.type?.enum).toEqual(["http"]);
    expect(SCHEMA.$defs?.sseServer?.allOf?.[1]?.properties?.type?.enum).toEqual(["sse"]);
  });

  it("必填清单一致", () => {
    expect(SCHEMA.$defs?.stdioServer?.allOf?.[1]?.required).toEqual(["command"]);
    expect(SCHEMA.$defs?.httpServer?.allOf?.[1]?.required).toEqual(["type", "url"]);
    expect(SCHEMA.$defs?.sseServer?.allOf?.[1]?.required).toEqual(["type", "url"]);
    // 运行时按传输分流，`type` 缺席不落到 http 分支上去。
    expect(rejects({ type: "http" })).toBe(true);
    expect(rejects({ command: "x", type: "http" })).toBe(true);
  });

  it("样例配置里每个 server 都过得了运行时 Schema", () => {
    for (const [name, raw] of Object.entries(EXAMPLE.mcpServers)) {
      expect(() => ServerConfig(raw as McpServer), `样例里的 ${name} 过不了运行时 Schema`).not.toThrow();
    }
  });
});
