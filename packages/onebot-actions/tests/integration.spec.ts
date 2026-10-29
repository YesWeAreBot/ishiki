import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import Server from "@koishijs/plugin-server";
import { App, Service, type Logger } from "koishi";
import { ResourceCenter, type ExtensionContext, type ToolSet } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import OneBotExtension, { OneBotExtensionConfig, type OneBotExtensionConfig as Config } from "../src/index.js";

const silent = { warn() {}, info() {}, debug() {}, error() {}, level: 1 } as unknown as Logger;

interface Recorded {
  action: string;
  params: Record<string, unknown>;
}

let app: App;
let home: string;
let calls: Recorded[];

beforeEach(async () => {
  app = new App();
  app.plugin(Server, { host: "127.0.0.1", port: 51420, maxPort: 51500 });
  await app.start();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-onebot-int-"));
  calls = [];
  const bot = {
    sid: "onebot:10000",
    internal: {
      _request: async (action: string, params: Record<string, unknown>) => {
        calls.push({ action, params });
        return { status: "ok", retcode: 0, data: { echo: action } };
      },
    },
  };
  (app.bots as unknown as Record<string, unknown>)["onebot:10000"] = bot;
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await app.stop();
});

function config(overrides: Partial<Config> = {}): Config {
  return OneBotExtensionConfig({ backend: "napcat", mode: "read", maxInlineBytes: 1024, resourceBaseUrl: "", denyActions: [], ...overrides }) as Config;
}

function context(domain: ExtensionContext["domain"], resources: ResourceCenter): ExtensionContext {
  return { runtimeId: "rt", domain, home, root: home, fiber: app, logger: silent, resources };
}

async function assemble(
  overrides: Partial<Config> = {},
): Promise<{ tools: ToolSet; instructions: string; resources: ResourceCenter; stop: () => Promise<void> }> {
  const settings = config(overrides);
  const extension = new OneBotExtension(app, { defaultBackend: "napcat", defaultMode: "read", logLevel: 1 });
  const resources = new ResourceCenter("rt", home);
  const instance = extension[Service.invoke](settings, context({ mode: "channel", platform: "onebot", selfId: "10000", channelId: "group:1" }, resources));
  if (instance === undefined) throw new Error("extension returned no instance");
  return {
    tools: await instance.extendTools!(),
    instructions: (await instance.extendInstructions?.()) ?? "",
    resources,
    stop: async () => {
      await instance.stop?.();
    },
  };
}

describe("extension assembly", () => {
  it("registers the catalog scheme and exposes the mode's tools", async () => {
    const assembled = await assemble();
    expect(Object.keys(assembled.tools).sort()).toEqual(["get_action", "list_actions", "list_categories", "query_action", "search_actions"]);
    expect(assembled.instructions).toContain("onebot://actions");
    const page = await assembled.resources.resolve("onebot://actions/get_group_info");
    if (page.type !== "text") throw new Error("expected text resource");
    expect(page.text).toContain("# get_group_info");

    await assembled.stop();
    await expect(assembled.resources.resolve("onebot://actions")).rejects.toThrow(/scheme/);
  });

  it("hides execution tools in docs mode", async () => {
    const assembled = await assemble({ mode: "docs" });
    expect(assembled.tools.query_action).toBeUndefined();
    expect(assembled.tools.invoke_action).toBeUndefined();
    await assembled.stop();
  });
});

describe("live execution", () => {
  it("executes through the real bot and returns the envelope", async () => {
    const assembled = await assemble();
    const tool = assembled.tools.query_action as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    const result = await tool.execute({ action: "get_group_info", params: { group_id: "42" } }, {});
    expect(calls).toEqual([{ action: "get_group_info", params: { group_id: "42" } }]);
    expect(result).toMatchObject({ status: "ok", retcode: 0 });
    await assembled.stop();
  });

  it("publishes declared media over the Koishi HTTP service for the protocol端 to fetch", async () => {
    await fs.writeFile(path.join(home, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const assembled = await assemble({ mode: "read" });
    const tool = assembled.tools.query_action as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    await tool.execute({ action: "ocr_image", params: { image: "local://shot.png" } }, {});

    const url = calls[0]!.params.image;
    expect(url).toBeTypeOf("string");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ishiki-onebot\//);
    const response = await fetch(url as string);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await assembled.stop();
  });

  it("inlines media as base64 when the parameter has no http transport", async () => {
    await fs.writeFile(path.join(home, "a.png"), Buffer.from([0x89, 0x50]));
    const assembled = await assemble({ mode: "write" });
    const tool = assembled.tools.invoke_action as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    await tool.execute({ action: "send_msg", params: { message: [{ type: "image", data: { file: "local://a.png" } }] } }, {});
    expect(calls[0]!.params).toEqual({ message: [{ type: "image", data: { file: "base64://iVA=" } }] });
    await assembled.stop();
  });

  it("refuses write actions in read mode even when called directly", async () => {
    const assembled = await assemble({ mode: "read" });
    const tool = assembled.tools.query_action as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    await expect(tool.execute({ action: "set_group_ban", params: { group_id: "1", user_id: "2", duration: 60 } }, {})).rejects.toThrow(/有副作用/);
    expect(calls).toEqual([]);
    await assembled.stop();
  });
});
