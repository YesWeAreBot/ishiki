import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ExecResult, ShellKind, WorkspaceLayout, WorkspaceShell } from "./shell.js";

const run = promisify(execFile);

/** powershell 管道输出默认按 OEM 代码页编码（中文 Windows 是 GBK），先声明 UTF-8 再执行。 */
const POWERSHELL_PREAMBLE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/** /tmp 的探测时限：一次固定成本，失败说明 shell 不认这个路径概念。 */
const TEMP_PROBE_TIMEOUT_MS = 5_000;

/** kind 决定参数拼法；导出供测试与调用方复用。 */
export function shellArgs(kind: ShellKind, command: string): string[] {
  if (kind === "powershell") return ["-NoProfile", "-NonInteractive", "-Command", `${POWERSHELL_PREAMBLE} ${command}`];
  if (kind === "cmd") return ["/d", "/s", "/c", command];
  return ["-c", command];
}

/**
 * shell 自己认定的 /tmp。MSYS 把 /tmp 挂成 usertemp，进程环境里的 TMP/TEMP 覆盖不了它，
 * 所以 os.tmpdir() 与 shell 里的 /tmp 未必是同一个目录。问 shell 一次，之后所有路径解析
 * 都用同一个答案，文件工具与 workspace:// URL 才不会和 shell 分叉。
 * 非 MSYS 的 posix shell 把 /tmp 当盘符根，没有可映射的宿主目录，返回 undefined。
 */
async function resolveShellTemp(shellPath: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  // 回调式调用：探测失败（shell 不存在、不是 MSYS）只有一个结论，/tmp 没有可映射的宿主目录。
  const reported = await new Promise<string | undefined>((done) => {
    execFile(shellPath, ["-c", "cd /tmp && pwd -W"], { windowsHide: true, timeout: TEMP_PROBE_TIMEOUT_MS }, (error, stdout) => {
      done(error === null ? stdout.trim() : undefined);
    });
  });
  // pwd -W 是 MSYS 的扩展；别的 posix shell 报出来的不是 Windows 路径。
  return reported !== undefined && /^[a-z]:[\\/]/i.test(reported) ? path.normalize(reported) : undefined;
}

/**
 * git-bash 风格路径 → 宿主 Windows 路径：/tmp 映射到 shell 报告的临时目录，/d/x 与 /D:/x 映射到 D:/x。
 * 仅 Windows 生效，只识别 /tmp 与单字母首段，/home 等不受影响。
 */
function msysToWin32(target: string, tempRoot: string | undefined): string {
  if (process.platform !== "win32") return target;
  if (tempRoot !== undefined && /^\/tmp(?=\/|$)/i.test(target)) return path.join(tempRoot, target.slice(4));
  const matched = /^\/([a-z]):?(?=\/|$)/i.exec(target);
  if (matched === null) return target;
  const rest = target.slice(matched[0].length);
  return `${matched[1].toUpperCase()}:${rest.length === 0 ? path.sep : rest}`;
}

function resolveHostPath(layout: WorkspaceLayout, tempRoot: string | undefined, target: string): string {
  const converted = msysToWin32(target, tempRoot);
  return path.isAbsolute(converted) ? path.normalize(converted) : path.resolve(layout.cwd, converted);
}

function mapExecError(error: unknown, layout: WorkspaceLayout, timeoutSignal: AbortSignal): ExecResult {
  const err = error as (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null;
  const name = path.basename(layout.shellPath).replace(/\.(exe|cmd|bat)$/i, "");
  // 超时：我们的 timeoutSignal 已触发；把已积累的输出带回去，对齐 sandbox 的 124 语义
  if ((timeoutSignal.reason as { name?: string } | undefined)?.name === "TimeoutError") {
    return { stdout: err?.stdout ?? "", stderr: err?.stderr ?? "", exitCode: 124 };
  }
  // 输出上限：Node 超限会终止子进程，与 sandbox 的 total output size exceeded 同风格
  if (err?.message?.includes("maxBuffer")) {
    return { stdout: "", stderr: `${name}: total output size exceeded (>${layout.maxExecutionOutputBytes} bytes)`, exitCode: 1 };
  }
  // 正常非零退出
  if (typeof err?.code === "number") {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code };
  }
  return { stdout: "", stderr: `${name}: ${err?.message ?? String(error)}`, exitCode: 1 };
}

export async function createNativeShell(layout: WorkspaceLayout): Promise<WorkspaceShell> {
  // 一次探测，整个 shell 生命周期共用：file 工具、workspace:// URL 与 exec 的路径语义从这里对齐。
  const tempRoot = layout.shellKind === "posix" ? await resolveShellTemp(layout.shellPath) : undefined;
  const resolve = (target: string): string => resolveHostPath(layout, tempRoot, target);
  return {
    ...layout,
    // native 没有虚拟根：整个宿主文件系统就是视图，路径解析与 exec/read_file 完全一致。
    fs: {
      async stat(target) {
        const stat = await fs.stat(resolve(target));
        return { isDirectory: stat.isDirectory(), size: stat.size };
      },
      readFileBuffer: (target) => fs.readFile(resolve(target)),
      readdir: (target) => fs.readdir(resolve(target)),
      readText: (target) => createReadStream(resolve(target), { encoding: "utf8" }),
      // 前缀探测 + 流式读让按行选择只读需要的那一段，不必整份载入宿主文件。
      async readFilePrefix(target, length) {
        const handle = await fs.open(resolve(target), "r");
        try {
          const bytes = Buffer.allocUnsafe(length);
          const result = await handle.read(bytes, 0, length, 0);
          return bytes.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
    async exec(command, signal) {
      const timeoutSignal = AbortSignal.timeout(layout.timeoutMs);
      const composed = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      try {
        const { stdout, stderr } = await run(layout.shellPath, shellArgs(layout.shellKind, command), {
          cwd: layout.cwd,
          maxBuffer: layout.maxExecutionOutputBytes,
          signal: composed,
          windowsHide: true,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        return mapExecError(error, layout, timeoutSignal);
      }
    },
    async read(target) {
      return fs.readFile(await resolve(target), "utf8");
    },
    async write(target, content) {
      const file = await resolve(target);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
    },
  };
}
