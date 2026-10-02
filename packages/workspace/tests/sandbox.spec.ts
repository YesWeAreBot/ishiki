import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseWorkspaceConfig } from "../src/config.js";
import { createSandbox, resolveLayout, type WorkspaceLayout, type WorkspaceSandbox } from "../src/sandbox.js";

const silent = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined } as unknown as Logger;

let base: string;
let home: string;
let root: string;
let dataPath: string;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "ishiki-workspace-sandbox-"));
  home = path.join(base, "home");
  root = path.join(base, "profiles", "neko");
  dataPath = path.join(base, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(dataPath, "skills", "pdf"), { recursive: true });
  writeFileSync(path.join(dataPath, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: 提取 PDF 文本\n---\n正文\n");
  writeFileSync(path.join(root, "readme.md"), "宿主机上的文档\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 静态装配：配置写错就抛在这一步，所以报错用例直接叫它。 */
function layout(config: Record<string, unknown> = {}): WorkspaceLayout {
  return resolveLayout({ config: parseWorkspaceConfig(config), home, root, dataPath, logger: silent });
}

async function mountSandbox(config: Record<string, unknown> = {}): Promise<WorkspaceSandbox> {
  return createSandbox(layout(config), home);
}

describe("沙箱", () => {
  it("/home 是只读的数据目录，/home/workspace 可写且直接落盘", async () => {
    writeFileSync(path.join(home, "events.jsonl"), '{"type":"turn.start"}\n');
    const sandbox = await mountSandbox();
    const written = await sandbox.exec("echo hi > a.txt && cat a.txt && cat /home/events.jsonl");
    expect(written).toMatchObject({ exitCode: 0 });
    expect(written.stdout).toContain("turn.start");
    // 宿主上就是同一个文件：没有「先写内存再落盘」这一步，读回来也只是读它。
    expect(readFileSync(path.join(home, "workspace", "a.txt"), "utf8")).toBe("hi\n");

    // 数据目录本身只读：读得到，写不进去，宿主上也不该多出文件。
    expect((await sandbox.exec("echo x > /home/new.txt")).exitCode).toBeGreaterThan(0);
    expect(existsSync(path.join(home, "new.txt"))).toBe(false);
  });

  it("bash 与 read/write 看到同一份工作区", async () => {
    const sandbox = await mountSandbox();
    await sandbox.write("/home/workspace/note.txt", "来自 write");
    expect((await sandbox.exec("cat /home/workspace/note.txt")).stdout).toBe("来自 write");
    await sandbox.exec("echo '来自 bash' > from-bash.txt");
    expect(await sandbox.read("/home/workspace/from-bash.txt")).toBe("来自 bash\n");
  });

  it("只读挂载的目录读得到，写进去是一条命令失败", async () => {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "spec.md"), "文档正文\n");
    const sandbox = await mountSandbox({ mounts: ["docs:/docs:ro"] });
    expect((await sandbox.exec("cat /docs/spec.md")).stdout).toBe("文档正文\n");
    const denied = await sandbox.exec("echo x > /docs/new.md");
    expect(denied.exitCode).toBe(1);
    expect(existsSync(path.join(root, "docs", "new.md"))).toBe(false);
  });

  it("技能合并挂在 /home/skills 下，每个技能只读", async () => {
    const sandbox = await mountSandbox();
    expect(sandbox.skills.map((skill) => skill.name)).toEqual(["pdf"]);
    expect((await sandbox.exec("ls /home/skills")).stdout).toBe("pdf\n");
    expect((await sandbox.exec("cat /home/skills/pdf/SKILL.md")).stdout).toContain("提取 PDF 文本");
    expect((await sandbox.exec("echo x > /home/skills/pdf/new.md")).exitCode).toBe(1);
  });

  it("命令超时按退出码 124 返回，不抛异常", async () => {
    const sandbox = await mountSandbox({ timeoutMs: 200 });
    expect((await sandbox.exec("sleep 5")).exitCode).toBe(124);
  });

  it("输出超限时截断并留一句说明", async () => {
    const sandbox = await mountSandbox({ maxOutputLength: 20 });
    const result = await sandbox.exec("printf '0123456789%.0s' {1..10}");
    expect(result.stdout.startsWith("01234567890123456789")).toBe(true);
    expect(result.stdout).toContain("已截断");
  });

  it("配置写错时在装配点就抛", () => {
    expect(() => layout({ mounts: ["x:/home/workspace/sub"] })).toThrow(/保留/);
    expect(() => layout({ mounts: ["no-such-dir:/docs:ro"] })).toThrow(/只读挂载的 source/);
  });
});

describe("附加运行时", () => {
  it("默认关：js-exec 与 python3 都不存在", async () => {
    const sandbox = await mountSandbox();
    const missing = await sandbox.exec("which js-exec python3");
    expect(missing.exitCode).toBeGreaterThan(0);
    expect(missing.stdout).toBe("");
  });

  it("按配置开启后跑得起来，与其它工具共用同一个工作区", async () => {
    const sandbox = await mountSandbox({ javascript: true });
    expect((await sandbox.exec(`js-exec -c "console.log(2 + 3)"`)).stdout).toBe("5\n");
    // 脚本读写的就是 bash 与那几件工具看到的那份工作区，不是另一份副本。
    await sandbox.exec(`js-exec -c "require('fs').writeFileSync('/home/workspace/from-js.txt', 'js 写的')"`);
    expect(await sandbox.read("/home/workspace/from-js.txt")).toBe("js 写的");
    expect((await sandbox.exec("cat from-js.txt")).stdout).toBe("js 写的");
  });

  it("python 开启后能读写工作区，只读的挂载照样拦得住", async () => {
    writeFileSync(path.join(home, "events.jsonl"), '{"type":"turn.start"}\n');
    const sandbox = await mountSandbox({ python: true });
    expect((await sandbox.exec(`python3 -c "print(1 + 2)"`)).stdout).toBe("3\n");
    // 工作区是可写的宿主目录：python 必须能进去读写。宿主目录缺「目录进入位」时（Windows 上的
    // 默认 mode 就是这样）这一步会以 PermissionError 失败，所以它同时守住那条权限位归一化。
    await sandbox.exec(`python3 -c "import pathlib; pathlib.Path('/home/workspace/from-py.txt').write_text('py 写的')"`);
    expect(await sandbox.read("/home/workspace/from-py.txt")).toBe("py 写的");
    expect((await sandbox.exec(`python3 -c "print(open('/home/events.jsonl').read().strip())"`)).stdout).toBe('{"type":"turn.start"}\n');
    // 只读的数据目录对 python 一样只读。
    expect((await sandbox.exec(`python3 -c "import pathlib; pathlib.Path('/home/new.txt').write_text('x')"`)).exitCode).toBeGreaterThan(0);
    expect(existsSync(path.join(home, "new.txt"))).toBe(false);
  });
});
