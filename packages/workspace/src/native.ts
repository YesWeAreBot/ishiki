import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ExecResult, ShellKind, WorkspaceLayout, WorkspaceShell } from "./shell.js";

const run = promisify(execFile);

/** powershell 管道输出默认按 OEM 代码页编码（中文 Windows 是 GBK），先声明 UTF-8 再执行。 */
const POWERSHELL_PREAMBLE = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/** kind 决定参数拼法；导出供测试与调用方复用。 */
export function shellArgs(kind: ShellKind, command: string): string[] {
  if (kind === "powershell") return ["-NoProfile", "-NonInteractive", "-Command", `${POWERSHELL_PREAMBLE} ${command}`];
  if (kind === "cmd") return ["/d", "/s", "/c", command];
  return ["-c", command];
}

/** git-bash 风格盘符路径 /d/x → D:/x。仅 Windows 生效，只识别单字母首段，/home 等不受影响。 */
function msysToWin32(target: string): string {
  if (process.platform !== "win32") return target;
  const matched = /^\/([a-z])(?=\/|$)/i.exec(target);
  if (matched === null) return target;
  return `${matched[1].toUpperCase()}:${target.slice(matched[0].length) || path.sep}`;
}

function resolveHostPath(layout: WorkspaceLayout, target: string): string {
  const converted = msysToWin32(target);
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
  return {
    ...layout,
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
    read: (target) => fs.readFile(resolveHostPath(layout, target), "utf8"),
    async write(target, content) {
      const file = resolveHostPath(layout, target);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
    },
  };
}
