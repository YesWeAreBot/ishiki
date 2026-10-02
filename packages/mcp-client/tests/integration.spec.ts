import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Context, sleep, type Logger } from "koishi";
import Ishiki, { type Extension } from "koishi-plugin-ishiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import IshikiMcpClient from "../src/index.js";
import { ProfilePool } from "../src/pool.js";
import type { OutputLimits } from "../src/server.js";

/** 起一个真 stdio 子进程的 MCP server；参数原样进它，出来的行为由用例断言。 */
const SERVER = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

/** 测试台上的一个 profile 目录，写一份 mcp.json 就返回它。 */
function writeConfig(directory: string, config: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ishiki-mcp-"));
  mkdirSync(path.join(dir, directory), { recursive: true });
  writeFileSync(path.join(dir, directory, "mcp.json"), JSON.stringify(config, null, 2));
  return dir;
}

/** 一条 stdio server 配置：`command` 起这个 fixture，其余是本次用例要看的东西。 */
function stdio(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [SERVER], ...extra };
}

/** 连上了就算就绪：工具面是逐轮生长的快照，握手何时完成对用例不可见。 */
async function ready(pool: ProfilePool, names: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (names.every((name) => name in pool.tools())) return;
    await sleep(50);
  }
}

const logs: string[] = [];
const logger = {
  info: () => undefined,
  debug: () => undefined,
  warn: (message: string) => logs.push(`warn ${message}`),
  error: (message: string) => logs.push(`error ${message}`),
} as unknown as Logger;

/**
 * 测试台上的出口限额：过一遍插件自己那份 Schema，与用户在控制台看到的形状与缺省值相同。
 * 缺省值真的补上了才算数——绕过 Schema 手写一份数字，用例就跑在另一个配置上了。
 */
// Schema 的入参类型就是解析结果本身；缺省值由它补上。
const LIMITS: OutputLimits = IshikiMcpClient.limits({} as OutputLimits);

describe("MCP 客户端：配置、工具面与生命周期", () => {
  it("数据根的配置在 profile 没有自己的文件时生效", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio() } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-echo", "echo-shot"]);
      expect(Object.keys(pool.tools())).toEqual(["echo-echo", "echo-shot"]);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("profile 自己的 mcp.json 完全替换数据根那份", async () => {
    const root = writeConfig("neko", { mcpServers: { root: stdio() } });
    const profile = path.join(root, "neko");
    writeFileSync(path.join(profile, "mcp.json"), JSON.stringify({ mcpServers: { local: stdio() } }));
    try {
      const pool = new ProfilePool(profile, path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["local-echo"]);
      // 数据根那份的 root-* 一个都不该出现。
      expect(Object.keys(pool.tools())).toEqual(["local-echo", "local-shot"]);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("server 报目录变更后，下一轮的工具面跟着变", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio() } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-echo", "echo-shot"]);
      expect(pool.instructions()).toBeUndefined();

      // fixture 收到 SWAP=yes 才注册第三件工具；这里换一台 server 重连，模拟变更后的目录。
      await pool.release();
      const swapped = writeConfig("neko", { mcpServers: { echo: stdio({ env: { SWAP: "yes" } }) } });
      try {
        const next = new ProfilePool(path.join(swapped, "neko"), path.join(swapped, ".mcp.json"), LIMITS, logger);
        next.hold();
        await ready(next, ["echo-swapped"]);
        expect(Object.keys(next.tools())).toEqual(["echo-echo", "echo-shot", "echo-swapped"]);
        await next.release();
      } finally {
        rmSync(swapped, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("工具返回值里的图片交字节，不被 JSON.stringify", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio() } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-shot"]);
      const output = await pool.tools()["echo-shot"].execute?.({}, { toolCallId: "1", messages: [], context: {} });
      // execute 返回的是 MCP 的原始内容块；字节成不成 file 部件是 toModelOutput 的事，这里断言原始形状。
      expect(output).toEqual([{ type: "image", data: expect.any(String), mimeType: "image/png" }]);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("配置的出口限额真的生效", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio() } });
    try {
      // 一张图也不许带：图片降级成一行说明，文本照旧走文本面。
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), { ...LIMITS, maxImageCount: 0 }, logger);
      pool.hold();
      await ready(pool, ["echo-shot"]);
      const shot = pool.tools()["echo-shot"];
      const rendered = (await shot.toModelOutput?.({
        toolCallId: "1",
        input: {},
        output: await shot.execute?.({}, { toolCallId: "1", messages: [], context: {} }),
      })) as { type: string; value: Array<{ type: string; text?: string }> };
      expect(rendered.type).toBe("content");
      expect(rendered.value.every((part) => part.type === "text")).toBe(true);
      expect(rendered.value[0].text).toContain("超出本次调用的图片限额");
      await pool.release();

      // 文本上限压到 5 个字：长文本被截断。
      const capped = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), { ...LIMITS, maxOutputChars: 5 }, logger);
      capped.hold();
      await ready(capped, ["echo-echo"]);
      const echo = capped.tools()["echo-echo"];
      const text = (await echo.toModelOutput?.({
        toolCallId: "2",
        input: {},
        output: await echo.execute?.({ text: "一整句要截断的话" }, { toolCallId: "2", messages: [], context: {} }),
      })) as { value: Array<{ text: string }> };
      expect(text.value[0].text).toHaveLength(5);
      await capped.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("env 与 cwd 透传到子进程", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio({ env: { SWAP: "yes" } }) } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-swapped"]);
      expect("echo-swapped" in pool.tools()).toBe(true);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("timeout 截断一次慢调用，没配就走 SDK 默认", async () => {
    const cappedRoot = writeConfig("neko", { mcpServers: { echo: stdio({ timeout: 300, env: { SLOW_MS: "5000" } }) } });
    const lenientRoot = writeConfig("neko", { mcpServers: { echo: stdio({ env: { SLOW_MS: "300" } }) } });
    try {
      // 配了 timeout：调用在上限处失败，而不是等 server 把话说完。
      const pool = new ProfilePool(path.join(cappedRoot, "neko"), path.join(cappedRoot, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-hang"]);
      const started = Date.now();
      const result = await pool
        .tools()
        ["echo-hang"].execute?.({}, { toolCallId: "1", messages: [], context: {} })
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(4000);
      await pool.release();

      // 没配 timeout：同样慢的 server 照样能等完。
      const lenient = new ProfilePool(path.join(lenientRoot, "neko"), path.join(lenientRoot, ".mcp.json"), LIMITS, logger);
      lenient.hold();
      await ready(lenient, ["echo-hang"]);
      const output = await lenient.tools()["echo-hang"].execute?.({}, { toolCallId: "2", messages: [], context: {} });
      expect(output).toEqual([{ type: "text", text: "等到了" }]);
      await lenient.release();
    } finally {
      rmSync(cappedRoot, { recursive: true, force: true });
      rmSync(lenientRoot, { recursive: true, force: true });
    }
  });

  it("server 自述的说明进提示词增量，instructions: false 时不进", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio({ env: { MCP_ECHO_INSTRUCTIONS: "这个 server 用来回显。" } }) } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-echo"]);
      expect(pool.instructions()).toBe("这个 server 用来回显。");
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("坏 server 只跳过自己，其余照连", async () => {
    const root = writeConfig("neko", { mcpServers: { broken: { type: "http" }, echo: stdio() } });
    logs.length = 0;
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-echo"]);
      expect(Object.keys(pool.tools())).toEqual(["echo-echo", "echo-shot"]);
      expect(logs.some((line) => line.startsWith("error") && line.includes("broken"))).toBe(true);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disabledServers 压过 enabled 与配置", async () => {
    const root = writeConfig("neko", {
      mcpServers: { echo: stdio() },
      disabledServers: ["echo"],
    });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await sleep(200);
      expect(pool.tools()).toEqual({});
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enabledServers 打开被配置关掉的 server", async () => {
    const root = writeConfig("neko", {
      mcpServers: { echo: stdio({ enabled: false }) },
      enabledServers: ["echo"],
    });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      await ready(pool, ["echo-echo"]);
      expect("echo-echo" in pool.tools()).toBe(true);
      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("同一 profile 的多个使用者共享一组连接，最后一个放掉才关", async () => {
    const root = writeConfig("neko", { mcpServers: { echo: stdio() } });
    try {
      const pool = new ProfilePool(path.join(root, "neko"), path.join(root, ".mcp.json"), LIMITS, logger);
      pool.hold();
      pool.hold();
      await ready(pool, ["echo-echo"]);

      await pool.release();
      // 还有一个使用者：连接不能被拆，工具面照旧。
      expect(Object.keys(pool.tools())).toEqual(["echo-echo", "echo-shot"]);

      await pool.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MCP 客户端：接进 ishiki 视窗", () => {
  let dataDir: string;
  let root: Context;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ishiki-mcp-kernel-"));
    root = new Context();
    root.plugin(Ishiki, { dataPath: dataDir, dumpRequests: false, logLevel: 0 });
    root.plugin(IshikiMcpClient, { limits: LIMITS, logLevel: 0 });
    await root.start();
    // 插件声明了 inject，构造被排在内核之后：扩展服务要等它那一拍才登记上。
    await sleep(20);
  });

  afterAll(async () => {
    await root.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("挂到实例上之后，工具面与提示词增量都从那组连接出", async () => {
    const dir = writeConfig("neko", { mcpServers: { echo: stdio({ env: { MCP_ECHO_INSTRUCTIONS: "这个 server 用来回显。" } }) } });
    try {
      const handler = root.ishiki.getExtension("mcp-client");
      expect(handler).toBeDefined();
      // handler 只读实例的 profileDirectory，其余字段这个用例用不上。运行体的类型从 handler 的
      // 签名上取，不另行命名——内核的 src 与 lib 两份声明同名不兼容，注解取自哪边都会错配。
      type Runtime = Parameters<NonNullable<typeof handler>>[1];
      const runtime = { profileDirectory: path.join(dir, "neko") } as Runtime;
      const extension = handler?.({}, runtime) as Extension;
      // 钩子等握手收尾：第一次取就是完整目录，不必逐轮长出来。
      expect(Object.keys((await extension.extendTools?.()) ?? {})).toEqual(["echo-echo", "echo-shot"]);
      expect(await extension.extendInstructions?.()).toBe("这个 server 用来回显。");
      await extension.dispose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
