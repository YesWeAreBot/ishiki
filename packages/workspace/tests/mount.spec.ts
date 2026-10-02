import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Context, sleep } from "koishi";
import Ishiki, { type Extension } from "koishi-plugin-ishiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import IshikiWorkspace from "../src/index.js";

describe("挂进 ishiki 视窗", () => {
  let dataPath: string;
  let context: Context;

  beforeAll(async () => {
    dataPath = mkdtempSync(path.join(os.tmpdir(), "ishiki-workspace-kernel-"));
    context = new Context();
    context.plugin(Ishiki, { dataPath, dumpRequests: false, logLevel: 0 });
    context.plugin(IshikiWorkspace, { logLevel: 0 });
    await context.start();
    // 插件声明了 inject，构造被排在内核之后：扩展服务要等它那一拍才登记上。
    await sleep(20);
  });

  afterAll(async () => {
    await context.stop();
    rmSync(dataPath, { recursive: true, force: true });
  });

  it("handler 交回的四件工具与两段提示词都出得来", async () => {
    const handler = context.ishiki.getExtension("workspace");
    expect(handler).toBeDefined();
    // handler 只读实例的 home 与 root，其余字段这个用例用不上。运行体的类型从 handler 的签名上取。
    type Runtime = Parameters<NonNullable<typeof handler>>[1];
    const root = path.join(dataPath, "profiles", "neko");
    const home = path.join(root, "scenes", "onebot_111_group-1");
    // 内核在实例诞生时就把数据目录建出来了，沙箱直接挂它。
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(dataPath, "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(dataPath, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: 提取 PDF 文本\n---\n");

    const extension = handler?.({ javascript: true, python: true }, { home, root } as unknown as Runtime) as Extension;
    expect(Object.keys((await extension.extendTools?.()) ?? {})).toEqual(["bash", "read_file", "write_file", "edit_file"]);
    const instructions = await extension.extendInstructions?.();
    expect(instructions).toContain("## 工作区");
    expect(instructions).toContain("当前工作目录：/home/workspace");
    expect(instructions).toContain("- /home：只读");
    expect(instructions).toContain("- /home/workspace：读写");
    expect(instructions).toContain("## 技能");
    expect(instructions).toContain("- pdf：提取 PDF 文本（/home/skills/pdf）");
    // 附加运行时的提示词只跟着配置出现，所以这一段要经真实 handler 走一趟。
    expect(instructions).toContain("js-exec 可用");
    expect(instructions).toContain("python3 与 python 可用");
  });

  it("配置写错的 profile 在实例诞生时就报错", () => {
    const handler = context.ishiki.getExtension("workspace");
    type Runtime = Parameters<NonNullable<typeof handler>>[1];
    expect(() => handler?.({ mounts: ["x:/home/workspace/sub"] }, { home: dataPath, root: dataPath } as unknown as Runtime)).toThrow(/保留/);
  });
});
