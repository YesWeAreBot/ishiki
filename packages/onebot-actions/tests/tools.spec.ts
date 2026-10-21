import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Bot, Logger } from "koishi";
import { ResourceCenter, ResourceError, type ResourcePayload, type SchemeHandler } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Mode } from "../src/catalog/types.js";
import { MediaPublisher } from "../src/media.js";
import { CatalogScheme } from "../src/scheme.js";
import { createTools, type ToolOptions } from "../src/tools.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

let home: string;
let resources: ResourceCenter;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-onebot-tools-"));
  resources = new ResourceCenter("rt", home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

interface Recorded {
  action: string;
  params: Record<string, unknown>;
}

function fakeBot(calls: Recorded[], options: { retcode?: number } = {}): Bot {
  const request = async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    return { status: options.retcode === 0 ? "ok" : "failed", retcode: options.retcode ?? 0, data: { action } };
  };
  return { sid: "onebot:10000", internal: { _request: request } } as unknown as Bot;
}

function options(overrides: Partial<ToolOptions> & { bot?: Bot } = {}): ToolOptions {
  const calls: Recorded[] = [];
  const bot = overrides.bot ?? fakeBot(calls);
  return {
    ctx: { bots: { "onebot:10000": bot }, get: () => undefined } as never,
    domain: { mode: "channel", platform: "onebot", selfId: "10000", channelId: "group:1" },
    backend: "napcat",
    mode: "write",
    deny: [],
    resources,
    publisher: new MediaPublisher(),
    maxInlineBytes: 1024,
    logger: silent,
    ...overrides,
  };
}

async function call(tools: Record<string, unknown>, name: string, input: unknown): Promise<unknown> {
  const entry = tools[name] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return entry.execute(input, {});
}

describe("tool surface by mode", () => {
  it("exposes documentation tools in every mode", () => {
    for (const mode of ["docs", "read", "write"] as Mode[]) {
      const tools = createTools(options({ mode }));
      expect(Object.keys(tools).sort()).toEqual(
        mode === "docs"
          ? ["get_action", "list_actions", "list_categories", "search_actions"]
          : mode === "read"
            ? ["get_action", "list_actions", "list_categories", "query_action", "search_actions"]
            : ["get_action", "invoke_action", "list_actions", "list_categories", "query_action", "search_actions"],
      );
    }
  });

  it("adds an account field only in cross mode", () => {
    const channel = createTools(options({ mode: "write" })).query_action as { inputSchema: unknown };
    const cross = createTools(
      options({ mode: "write", domain: { mode: "cross", channels: new Map([["onebot:10000", { include: ["group:*"], exclude: [] }]]) } as never }),
    ).query_action as { inputSchema: unknown };
    expect(JSON.stringify(channel.inputSchema)).not.toContain('"account"');
    expect(JSON.stringify(cross.inputSchema)).toContain('"account"');
  });
});

describe("documentation tools", () => {
  it("lists actions filtered by category", async () => {
    const tools = createTools(options({ mode: "docs" }));
    const result = (await call(tools, "list_actions", { category: "消息" })) as { count: number; actions: Array<{ name: string }> };
    expect(result.count).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.name !== "send_group_sign")).toBe(true);
  });

  it("resolves an alias in get_action", async () => {
    const tools = createTools(options({ mode: "docs" }));
    const result = (await call(tools, "get_action", { name: "ArkSharePeer" })) as { text: string };
    expect(result.text).toContain("# share_peer");
  });

  it("rejects unknown actions in get_action", async () => {
    const tools = createTools(options({ mode: "docs" }));
    await expect(call(tools, "get_action", { name: "nope" })).rejects.toThrow(/未知动作/);
  });

  it("searches by parameter name", async () => {
    const tools = createTools(options({ mode: "docs" }));
    const result = (await call(tools, "search_actions", { query: "message_seq" })) as { count: number };
    expect(result.count).toBeGreaterThan(0);
  });

  it("lists categories with counts", async () => {
    const tools = createTools(options({ mode: "docs" }));
    const result = (await call(tools, "list_categories", {})) as Array<{ category: string; count: number }>;
    expect(result.length).toBeGreaterThan(3);
  });
});

describe("execution", () => {
  it("passes params through and returns the envelope", async () => {
    const calls: Recorded[] = [];
    const tools = createTools(options({ bot: fakeBot(calls), mode: "read" }));
    const result = await call(tools, "query_action", { action: "get_group_info", params: { group_id: "123" } });
    expect(calls).toEqual([{ action: "get_group_info", params: { group_id: "123" } }]);
    expect(result).toMatchObject({ retcode: 0, data: { action: "get_group_info" } });
  });

  it("sends the backend's own wire name for a folded alias", async () => {
    const calls: Recorded[] = [];
    const tools = createTools(options({ bot: fakeBot(calls), mode: "write" }));
    await call(tools, "invoke_action", { action: "share_peer", params: { user_id: "1" } });
    expect(calls[0]!.action).toBe("ArkSharePeer");

    const snow = createTools(options({ bot: fakeBot(calls), mode: "write", backend: "snowluma" }));
    await call(snow, "invoke_action", { action: "ArkSharePeer", params: { user_id: "1" } });
    expect(calls[1]!.action).toBe("share_peer");
  });

  it("surfaces a business failure as an ordinary result", async () => {
    const tools = createTools(options({ bot: fakeBot([], { retcode: 1200 }), mode: "read" }));
    const result = (await call(tools, "query_action", { action: "get_group_info", params: { group_id: "1" } })) as { retcode: number; status: string };
    expect(result.retcode).toBe(1200);
    expect(result.status).toBe("failed");
  });

  it("refuses a write action through query_action", async () => {
    const tools = createTools(options({ mode: "read" }));
    await expect(call(tools, "query_action", { action: "set_group_ban", params: { group_id: "1", user_id: "2", duration: 60 } })).rejects.toThrow(/有副作用/);
  });

  it("refuses execution outside the matching mode", async () => {
    const docs = createTools(options({ mode: "docs" }));
    expect(docs.query_action).toBeUndefined();
    expect(docs.invoke_action).toBeUndefined();

    const read = createTools(options({ mode: "read" }));
    expect(read.invoke_action).toBeUndefined();
  });

  it("honours denyActions and the built-in deny list", async () => {
    const denied = createTools(options({ mode: "write", deny: ["set_group_ban"] }));
    await expect(call(denied, "invoke_action", { action: "set_group_ban", params: {} })).rejects.toThrow(/denyActions/);

    // 别名同样能被拦下：配置里写哪个写法都生效。
    const byAlias = createTools(options({ mode: "write", deny: ["ArkSharePeer"] }));
    await expect(call(byAlias, "invoke_action", { action: "share_peer", params: {} })).rejects.toThrow(/denyActions/);

    const builtin = createTools(options({ mode: "write" }));
    await expect(call(builtin, "invoke_action", { action: "bot_exit" })).rejects.toThrow(/默认禁用/);
    await expect(call(builtin, "invoke_action", { action: "send_packet", params: {} })).rejects.toThrow(/默认禁用/);
  });

  it("rejects an action outside the configured backend", async () => {
    const tools = createTools(options({ mode: "read", backend: "snowluma" }));
    await expect(call(tools, "query_action", { action: "get_guild_list" })).rejects.toThrow(/未知动作/);
  });

  it("requires and validates account in cross mode", async () => {
    const cross = options({
      mode: "read",
      domain: { mode: "cross", channels: new Map([["onebot:10000", { include: ["group:*"], exclude: [] }]]) } as never,
    });
    const tools = createTools(cross);
    await expect(call(tools, "query_action", { action: "get_group_info" })).rejects.toThrow(/需要 account/);
    await expect(call(tools, "query_action", { action: "get_group_info", account: "onebot:99999" })).rejects.toThrow(/不在该 profile/);
  });

  it("reports a missing request channel", async () => {
    const tools = createTools(options({ bot: { sid: "onebot:10000", internal: {} } as unknown as Bot, mode: "read" }));
    await expect(call(tools, "query_action", { action: "get_group_info" })).rejects.toThrow(/请求通道/);
  });

  it("reports a disconnected bot", async () => {
    const tools = createTools(options({ mode: "read", ctx: { bots: {}, get: () => undefined } as never }));
    await expect(call(tools, "query_action", { action: "get_group_info" })).rejects.toThrow(/未连接/);
  });

  it("converts resource URLs before the request", async () => {
    await fs.writeFile(path.join(home, "a.png"), Buffer.from([0x89, 0x50]));
    const calls: Recorded[] = [];
    const tools = createTools(options({ bot: fakeBot(calls), mode: "write" }));
    await call(tools, "invoke_action", {
      action: "send_msg",
      params: { message: [{ type: "image", data: { file: "local://a.png" } }] },
    });
    expect(calls[0]!.params).toEqual({ message: [{ type: "image", data: { file: "base64://iVA=" } }] });
  });
});

describe("catalog resource", () => {
  it("serves the index and one action page", async () => {
    const scheme = new CatalogScheme("napcat");
    const index = scheme.resolve("onebot://actions");
    if (index.type !== "text") throw new Error("expected text");
    expect(index.text).toContain("# OneBot 动作目录 (NapCat)");

    const page = scheme.resolve("onebot://actions/get_group_info");
    if (page.type !== "text") throw new Error("expected text");
    expect(page.text).toContain("# get_group_info");
  });

  it("rejects unknown resources and actions from the other backend", () => {
    const scheme = new CatalogScheme("napcat");
    expect(() => scheme.resolve("onebot://other")).toThrow(ResourceError);
    expect(() => scheme.resolve("onebot://actions/fetch_sys_faces")).toThrow(ResourceError);
    expect(() => scheme.resolve("onebot://actions/a/b")).toThrow(ResourceError);
  });

  it("resolves through the resource center after attach", async () => {
    const handler: SchemeHandler = new CatalogScheme("snowluma");
    const dispose = resources.attach(handler);
    const payload: ResourcePayload = await resources.resolve("onebot://actions");
    expect(payload.type).toBe("text");
    dispose();
    await expect(resources.resolve("onebot://actions")).rejects.toBeInstanceOf(ResourceError);
  });
});
