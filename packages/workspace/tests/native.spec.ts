import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceConfig } from "../src/config.js";
import { createNativeShell, shellArgs } from "../src/native.js";
import { defaultShell, resolveLayout, shellKindOf, type ShellKind, type ShellOptions } from "../src/shell.js";

function nativeOptions(home: string, overrides: Partial<WorkspaceConfig> = {}): ShellOptions {
  const config: WorkspaceConfig = {
    backend: "native",
    shell: "",
    cwd: "/home/workspace",
    timeoutMs: 30_000,
    maxExecutionOutputBytes: 32 * 1024 * 1024,
    network: false,
    javascript: false,
    python: false,
    skills: [],
    mounts: [],
    ...overrides,
  };
  return { config, home, root: home, dataPath: home, logger: { warn() {}, info() {}, level: 1 } as never };
}

const kind: ShellKind = process.platform === "win32" ? "powershell" : "posix";

/** kind 无关的打印 N 字节文本命令。 */
function emitBytes(n: number): string {
  return kind === "powershell" ? `[string]::new('a', ${n})` : `yes a | head -c ${n}`;
}

describe("shell resolution", () => {
  it("detects shell kind from basename", () => {
    expect(shellKindOf("/usr/bin/bash")).toBe("posix");
    expect(shellKindOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellKindOf("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE")).toBe("powershell");
    expect(shellKindOf("C:\\Windows\\system32\\cmd.exe")).toBe("cmd");
    expect(shellKindOf("/opt/bin/zsh")).toBe("posix");
  });

  it("assembles args per kind", () => {
    expect(shellArgs("posix", "echo hi")).toEqual(["-c", "echo hi"]);
    expect(shellArgs("powershell", "echo hi")).toEqual(["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("echo hi")]);
    // powershell 管道输出默认按 OEM 代码页编码，前置 UTF-8 声明避免中文 Windows 乱码
    expect(shellArgs("powershell", "echo hi")[3]).toMatch(/^\[Console\]::OutputEncoding/);
    expect(shellArgs("cmd", "echo hi")).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("falls back to pwsh then powershell on Windows", () => {
    const fallback = defaultShell("");
    const expected = process.platform === "win32" ? /[pwsh|powershell](\.exe)?$/i : /^\/bin\/(ba)?sh$/;
    expect(fallback).toMatch(expected);
    expect(defaultShell("C:\\Git\\bin\\bash.exe")).toBe("C:\\Git\\bin\\bash.exe");
  });
});

describe("native shell", () => {
  it("executes commands with cwd at the workspace root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home)));
      expect(shell.backend).toBe("native");
      expect(shell.cwd.toLowerCase()).toBe(path.join(home, "workspace").toLowerCase());
      expect(shell.mounts).toEqual([]);

      const result = await shell.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("reads and writes host files, resolving relative paths against cwd", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home)));
      await shell.write("sub/note.txt", "你好 native");
      expect(await fs.readFile(path.join(home, "workspace", "sub", "note.txt"), "utf8")).toBe("你好 native");
      expect(await shell.read("sub/note.txt")).toBe("你好 native");

      const absolute = path.join(home, "workspace", "sub", "note.txt");
      expect(await shell.read(absolute)).toBe("你好 native");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("converts git-bash style drive paths on Windows", async () => {
    if (process.platform !== "win32") return;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home)));
      // <tmpdir 盘>:/... 形式的真实路径转回 /x/... 风格再读
      const drive = home[0].toLowerCase();
      const msysPath = `/${drive}/${home.slice(3).replaceAll("\\", "/")}/workspace/marked.txt`;
      await shell.write(msysPath, "via msys");
      expect(await fs.readFile(path.join(home, "workspace", "marked.txt"), "utf8")).toBe("via msys");
      expect(await shell.read(msysPath)).toBe("via msys");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("maps timeout to exit code 124", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home, { timeoutMs: 400 })));
      const slow = kind === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30";
      const result = await shell.exec(slow);
      expect(result.exitCode).toBe(124);
    } finally {
      // Windows：被 kill 的 shell 可能短暂持有 cwd 句柄，延迟重试清理
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  });

  it("aborts on output size limit with a sandbox-style error", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home, { maxExecutionOutputBytes: 1024 })));
      const result = await shell.exec(emitBytes(64 * 1024));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("total output size exceeded");
      expect(result.stdout).toBe("");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("reports non-zero exits and missing shells sandbox-style", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-native-"));
    try {
      const shell = await createNativeShell(resolveLayout(nativeOptions(home)));
      const failing = await shell.exec(kind === "powershell" ? "exit 7" : "exit 7");
      expect(failing.exitCode).toBe(7);

      const missing = await createNativeShell(resolveLayout(nativeOptions(home, { shell: "definitely-not-a-shell-xyz" })));
      const broken = await missing.exec("echo hi");
      expect(broken.exitCode).toBe(1);
      expect(broken.stdout).toBe("");
      expect(broken.stderr.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
