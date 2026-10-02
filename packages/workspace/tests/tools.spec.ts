import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import type { Tool, ToolSet } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseWorkspaceConfig } from "../src/config.js";
import { createSandbox, resolveLayout, type ExecResult } from "../src/sandbox.js";
import { createWorkspaceTools } from "../src/tools.js";

const silent = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined } as unknown as Logger;

/** 工具的 execute 在这个仓库里都是同步入参、异步结果；这里只把入参喂进去，忽略 SDK 的执行上下文。 */
async function call(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name] as Tool | undefined;
  const execute = tool?.execute;
  if (execute === undefined) throw new Error(`工具 ${name} 没有 execute`);
  return execute(input, { toolCallId: "t", messages: [], context: {} });
}

/** 工具声明的输出字段名；没有声明输出 schema 时给 undefined。 */
function declaredOutputKeys(tool: unknown): string[] | undefined {
  if (tool === null || typeof tool !== "object" || !("outputSchema" in tool)) return undefined;
  const schema = tool.outputSchema;
  if (schema === null || typeof schema !== "object" || !("jsonSchema" in schema)) return undefined;
  const json = schema.jsonSchema;
  if (json === null || typeof json !== "object" || !("required" in json)) return [];
  return Array.isArray(json.required) ? json.required.map(String) : [];
}

let base: string;
let home: string;
let root: string;
let tools: ToolSet;

beforeEach(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "ishiki-workspace-tools-"));
  home = path.join(base, "home");
  root = path.join(base, "profiles", "neko");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  const layout = resolveLayout({ config: parseWorkspaceConfig({}), home, root, dataPath: path.join(base, "data"), logger: silent });
  tools = createWorkspaceTools(await createSandbox(layout, home));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("工作区工具", () => {
  it("write_file 按工作目录补全相对路径，bash 立刻能看到", async () => {
    expect(await call(tools, "write_file", { path: "notes/a.txt", content: "hello" })).toEqual({ ok: true, bytes: 5 });
    expect(await call(tools, "read_file", { path: "notes/a.txt" })).toEqual({ content: "hello" });
    expect(await call(tools, "bash", { command: "cat /home/workspace/notes/a.txt" })).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  it("bash 的退出码原样返回，命令失败不是工具失败", async () => {
    const result = (await call(tools, "bash", { command: "ls /nope" })) as ExecResult;
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("/nope");
  });

  it("read_file 读不存在的文件时报错", async () => {
    await expect(call(tools, "read_file", { path: "absent.txt" })).rejects.toThrow(/absent\.txt/);
  });

  it("edit_file 替换唯一的一处", async () => {
    await call(tools, "write_file", { path: "a.txt", content: "第一行\n第二行\n" });
    expect(await call(tools, "edit_file", { path: "a.txt", old_string: "第二行", new_string: "改过的第二行" })).toEqual({ ok: true, replacements: 1 });
    expect(await call(tools, "read_file", { path: "a.txt" })).toEqual({ content: "第一行\n改过的第二行\n" });
  });

  it("edit_file 在 old_string 出现多次时不动文件", async () => {
    await call(tools, "write_file", { path: "a.txt", content: "x\nx\n" });
    await expect(call(tools, "edit_file", { path: "a.txt", old_string: "x", new_string: "y" })).rejects.toThrow(/出现 2 次/);
    expect(await call(tools, "read_file", { path: "a.txt" })).toEqual({ content: "x\nx\n" });
  });

  it("edit_file 在 replace_all 下替换全部出现的位置", async () => {
    await call(tools, "write_file", { path: "a.txt", content: "x\nx\n" });
    expect(await call(tools, "edit_file", { path: "a.txt", old_string: "x", new_string: "y", replace_all: true })).toEqual({ ok: true, replacements: 2 });
    expect(await call(tools, "read_file", { path: "a.txt" })).toEqual({ content: "y\ny\n" });
  });

  it("edit_file 找不到 old_string 时报错并保持文件原样", async () => {
    writeFileSync(path.join(home, "workspace", "a.txt"), "实际内容\n");
    await expect(call(tools, "edit_file", { path: "a.txt", old_string: "以为的内容", new_string: "x" })).rejects.toThrow(/未在文件中出现/);
    expect(await call(tools, "read_file", { path: "a.txt" })).toEqual({ content: "实际内容\n" });
  });

  it("每个工具声明的 outputSchema 与真实返回值对得上", async () => {
    await call(tools, "write_file", { path: "a.txt", content: "x\ny\n" });
    const returned: Record<string, object> = {
      bash: (await call(tools, "bash", { command: "cat a.txt" })) as object,
      read_file: (await call(tools, "read_file", { path: "a.txt" })) as object,
      write_file: (await call(tools, "write_file", { path: "b.txt", content: "y" })) as object,
      edit_file: (await call(tools, "edit_file", { path: "b.txt", old_string: "y", new_string: "z" })) as object,
    };
    for (const [name, value] of Object.entries(returned)) {
      // 声明与返回值脱节时，代码模式里拿到的是另一套类型，所以这条对账必须有。
      const declared = declaredOutputKeys(tools[name]);
      expect(declared, `${name} 没有声明 outputSchema`).toBeDefined();
      for (const key of declared ?? []) expect(Object.keys(value), `${name}.${key}`).toContain(key);
    }
  });
});
