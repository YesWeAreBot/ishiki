import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceConfig } from "../src/config.js";
import { sandboxExecutionLimits } from "../src/execution-limits.js";
import { createSandbox } from "../src/sandbox.js";
import { resolveLayout, type ShellOptions } from "../src/shell.js";
import { createWorkspaceTools } from "../src/tools.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

let base: string;
let home: string;
let root: string;
let dataPath: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-workspace-sandbox-"));
  home = path.join(base, "home");
  root = path.join(base, "profiles", "neko");
  dataPath = path.join(base, "data");
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(root, { recursive: true }), fs.mkdir(dataPath, { recursive: true })]);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function options(overrides: Partial<WorkspaceConfig> = {}): ShellOptions {
  const config: WorkspaceConfig = {
    backend: "sandbox",
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
  return { config, home, root, dataPath, logger: silent };
}

async function mount(overrides: Partial<WorkspaceConfig> = {}) {
  const shellOptions = options(overrides);
  return createSandbox(resolveLayout(shellOptions), shellOptions);
}

describe("sandbox execution limits", () => {
  it("applies the command timeout to every sandboxed runtime", () => {
    expect(sandboxExecutionLimits({ timeoutMs: 45_000, maxExecutionOutputBytes: 1024 })).toEqual({
      maxOutputSize: 1024,
      maxExecutionTimeMs: 45_000,
      maxSqliteTimeoutMs: 45_000,
      maxPythonTimeoutMs: 45_000,
      maxJsTimeoutMs: 45_000,
    });
  });

  it("uses the configured timeout for the just-bash execution deadline", async () => {
    const shell = await mount({ timeoutMs: 300 });
    const result = await shell.exec("sleep 30");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("sleep exceeded its execution deadline");
  });

  it("uses the configured timeout for the JavaScript runtime", async () => {
    const shell = await mount({ timeoutMs: 300, javascript: true });
    await shell.write("/home/workspace/loop.mjs", "while (true) {}");
    const result = await shell.exec("js-exec /home/workspace/loop.mjs");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("js-exec exceeded its execution deadline");
  });

  it("marks a non-zero bash exit as an error result", async () => {
    const shell = await mount();
    const bash = createWorkspaceTools(shell).bash;
    const output = await bash.execute!({ command: "printf failure >&2\nexit 7" }, { abortSignal: new AbortController().signal } as never);
    expect(output).toEqual({ stdout: "", stderr: "failure", exitCode: 7 });
    expect(bash.toModelOutput!({ input: { command: "exit 7" }, output })).toEqual({
      type: "error-text",
      value: "exit code: 7\n\nstderr:\nfailure",
    });
  });
});

describe("sandbox Python", () => {
  it("keeps Python disabled unless configured", async () => {
    const shell = await mount();
    const result = await shell.exec("python3 -V");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("runs python3 and python through the mounted workspace", async () => {
    const shell = await mount({ python: true });
    await shell.write(
      "/home/workspace/check.py",
      [
        "from pathlib import Path",
        "Path('/home/workspace/python-note.txt').write_text('持久内容', encoding='utf-8')",
        "print(Path('/home/workspace/python-note.txt').read_text(encoding='utf-8'))",
      ].join("\n"),
    );

    const version = await shell.exec("python3 -V");
    expect(version).toMatchObject({ exitCode: 0, stderr: "" });
    expect(version.stdout).toContain("Python 3.13.2");

    const alias = await shell.exec('python -c "print(6 * 7)"');
    expect(alias).toEqual({ stdout: "42\n", stderr: "", exitCode: 0 });

    const script = await shell.exec("python3 check.py");
    expect(script).toEqual({ stdout: "持久内容\n", stderr: "", exitCode: 0 });
    expect(await shell.read("/home/workspace/python-note.txt")).toBe("持久内容");
  });

  it("runs Python through child_process in js-exec", async () => {
    const shell = await mount({ javascript: true, python: true });
    await shell.write(
      "/home/workspace/python.mjs",
      [
        "import { spawnSync } from 'node:child_process';",
        "const result = spawnSync('python3', ['-c', 'print(6 * 7)'], { encoding: 'utf8' });",
        "console.log(JSON.stringify(result));",
      ].join("\n"),
    );

    const executed = await shell.exec("js-exec /home/workspace/python.mjs");
    expect(executed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(executed.stdout)).toMatchObject({
      stdout: "42\n",
      stderr: "",
      status: 0,
    });
  });
});

describe("sandbox JavaScript fs", () => {
  it("bridges Node fs constants, classes, access checks, URLs and buffer reads", async () => {
    const shell = await mount({ javascript: true });
    await shell.write("/home/workspace/input.txt", "hello");
    await shell.write(
      "/home/workspace/check.mjs",
      [
        "import fs from 'node:fs';",
        "const input = '/home/workspace/input.txt';",
        "const url = new URL('file:///home/workspace/input.txt');",
        "fs.accessSync(url, fs.constants.R_OK);",
        "let accessError;",
        "try {",
        "  fs.accessSync('/home/workspace/missing.txt', fs.constants.F_OK);",
        "} catch (error) {",
        "  accessError = { code: error.code, syscall: error.syscall, path: error.path };",
        "}",
        "let copyError;",
        "fs.writeFileSync('/home/workspace/copy.txt', 'old');",
        "try {",
        "  fs.copyFileSync(url, new URL('file:///home/workspace/copy.txt'), fs.constants.COPYFILE_EXCL);",
        "} catch (error) {",
        "  copyError = { code: error.code, syscall: error.syscall };",
        "}",
        "const entries = fs.readdirSync('/home/workspace', { withFileTypes: true });",
        "const urlEntries = fs.readdirSync(new URL('file:///home/workspace/'), { withFileTypes: true });",
        "console.log(JSON.stringify({",
        "  constants: {",
        "    fok: fs.constants.F_OK,",
        "    rok: fs.constants.R_OK,",
        "    wok: fs.constants.W_OK,",
        "    xok: fs.constants.X_OK,",
        "    excl: fs.constants.COPYFILE_EXCL,",
        "  },",
        "  accessError,",
        "  copyError,",
        "  statClass: fs.statSync(input) instanceof fs.Stats,",
        "  direntClass: entries.every((entry) => entry instanceof fs.Dirent),",
        "  urlEntries: urlEntries.map((entry) => entry.name).sort(),",
        "  urlText: fs.readFileSync(url, 'utf8'),",
        "  bufferText: fs.readFileBuffer(input).toString('utf8'),",
        "  bufferClass: Buffer.isBuffer(fs.readFileBuffer(input)),",
        "  promisedAccess: await fs.promises.access(input, fs.constants.R_OK).then(() => true),",
        "}));",
      ].join("\n"),
    );

    const executed = await shell.exec("js-exec /home/workspace/check.mjs");
    expect(executed.stderr).toBe("");
    expect(executed.exitCode).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual({
      constants: { fok: 0, rok: 4, wok: 2, xok: 1, excl: 1 },
      accessError: { code: "ENOENT", syscall: "access", path: "/home/workspace/missing.txt" },
      copyError: { code: "EEXIST", syscall: "copyfile" },
      statClass: true,
      direntClass: true,
      urlEntries: ["check.mjs", "copy.txt", "input.txt"],
      urlText: "hello",
      bufferText: "hello",
      bufferClass: true,
      promisedAccess: true,
    });
  });

  it("matches Node behavior for errors, stats, readdir and recursive mkdir", async () => {
    const shell = await mount({ javascript: true });
    await shell.write("/home/workspace/input.txt", "hello");
    await shell.write(
      "/home/workspace/check.mjs",
      [
        "import * as fs from 'node:fs';",
        "const result = {};",
        "try {",
        "  fs.statSync('missing-relative');",
        "} catch (error) {",
        "  result.error = {",
        "    code: error.code,",
        "    errno: error.errno,",
        "    syscall: error.syscall,",
        "    path: error.path,",
        "    message: error.message,",
        "  };",
        "}",
        "const stat = fs.statSync('/home/workspace/input.txt');",
        "result.stat = {",
        "  file: stat.isFile(),",
        "  directory: stat.isDirectory(),",
        "  symbolicLink: stat.isSymbolicLink(),",
        "  mtimeDate: stat.mtime instanceof Date,",
        "  mtimeValue: stat.mtime.getTime(),",
        "  mtimeMs: stat.mtimeMs,",
        "  size: stat.size,",
        "};",
        "const promisedStat = await fs.promises.stat('/home/workspace/input.txt');",
        "result.promisedStat = { file: promisedStat.isFile(), mtimeDate: promisedStat.mtime instanceof Date };",
        "result.callbackStat = await new Promise((resolve) => {",
        "  fs.stat('/home/workspace/input.txt', (error, value) => {",
        "    resolve({ error: error && error.message, file: value && value.isFile() });",
        "  });",
        "});",
        "try {",
        "  await fs.promises.stat('missing-relative');",
        "} catch (error) {",
        "  result.promisedError = { code: error.code, syscall: error.syscall, path: error.path };",
        "}",
        "result.callbackError = await new Promise((resolve) => {",
        "  fs.stat('missing-relative', (error) => {",
        "    resolve({ code: error.code, syscall: error.syscall, path: error.path });",
        "  });",
        "});",
        "const made = fs.mkdirSync('/home/workspace/deep/nested', { recursive: true });",
        "result.mkdir = { made, exists: fs.existsSync('/home/workspace/deep/nested') };",
        "result.names = fs.readdirSync('/home/workspace').sort();",
        "result.types = fs.readdirSync('/home/workspace', { withFileTypes: true })",
        "  .map((entry) => ({",
        "    name: entry.name,",
        "    file: typeof entry.isFile === 'function' ? entry.isFile() : entry.isFile,",
        "    directory: typeof entry.isDirectory === 'function' ? entry.isDirectory() : entry.isDirectory,",
        "  }))",
        "  .sort((left, right) => left.name.localeCompare(right.name));",
        "result.recursive = fs.readdirSync('/home/workspace/deep', { recursive: true }).sort();",
        "console.log(JSON.stringify(result));",
      ].join("\n"),
    );

    const executed = await shell.exec("js-exec /home/workspace/check.mjs");
    expect(executed.stderr).toBe("");
    expect(executed.exitCode).toBe(0);
    const result = JSON.parse(executed.stdout) as {
      error: { code?: string; errno?: number; syscall?: string; path?: string; message?: string };
      stat: {
        file: boolean;
        directory: boolean;
        symbolicLink: boolean;
        mtimeDate: boolean;
        mtimeValue: number;
        mtimeMs: number;
        size: number;
      };
      promisedStat: { file: boolean; mtimeDate: boolean };
      callbackStat: { error?: string; file: boolean };
      promisedError: { code?: string; syscall?: string; path?: string };
      callbackError: { code?: string; syscall?: string; path?: string };
      mkdir: { made?: string; exists: boolean };
      names: string[];
      types: Array<{ name: string; file: boolean; directory: boolean }>;
      recursive: string[];
    };

    expect(result.error).toMatchObject({
      code: "ENOENT",
      errno: -2,
      syscall: "stat",
      path: "missing-relative",
    });
    expect(result.error.message).toContain("'missing-relative'");
    expect(result.stat).toMatchObject({
      file: true,
      directory: false,
      symbolicLink: false,
      mtimeDate: true,
      mtimeMs: result.stat.mtimeValue,
      size: 5,
    });
    expect(result.promisedStat).toEqual({ file: true, mtimeDate: true });
    expect(result.callbackStat).toEqual({ error: null, file: true });
    expect(result.promisedError).toMatchObject({ code: "ENOENT", syscall: "stat", path: "missing-relative" });
    expect(result.callbackError).toMatchObject({ code: "ENOENT", syscall: "stat", path: "missing-relative" });
    expect(result.mkdir).toEqual({ made: "/home/workspace/deep", exists: true });
    expect(result.names).toEqual(["check.mjs", "deep", "input.txt"]);
    expect(result.types).toEqual([
      { name: "check.mjs", file: true, directory: false },
      { name: "deep", file: false, directory: true },
      { name: "input.txt", file: true, directory: false },
    ]);
    expect(result.recursive).toEqual(["nested"]);
  });

  it("mounts the bundled sandbox environment skill", async () => {
    const shell = await mount();
    expect(shell.skills.map((skill) => skill.name)).toContain("sandbox-environment");
    expect(await shell.read("/home/skills/sandbox-environment/SKILL.md")).toContain("just-bash");
  });
});
