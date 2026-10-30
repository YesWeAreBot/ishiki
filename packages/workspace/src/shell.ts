import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";
import type { ResourceCenter, ResourceFileSystem } from "koishi-plugin-ishiki";

import type { WorkspaceConfig } from "./config.js";
import { resolveMounts, resolveSkillMounts, type HostMount } from "./mounts.js";
import { BUILTIN_SKILLS_DIRECTORY, discoverSkills, type Skill } from "./skills.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ShellBackend = "sandbox" | "native";

export type ShellKind = "posix" | "powershell" | "cmd";

export interface WorkspaceLayout {
  readonly backend: ShellBackend;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxExecutionOutputBytes: number;
  /** sandbox 专用；native 下恒为 false，宿主真实网络不受插件控制。 */
  readonly network: boolean;
  /** sandbox 专用（js-exec）；native 下恒为 false。 */
  readonly javascript: boolean;
  /** sandbox 专用（wasm python）；native 下恒为 false。 */
  readonly python: boolean;
  /** sandbox 的虚拟挂载点；native 恒为空。 */
  readonly mounts: readonly HostMount[];
  readonly skills: readonly Skill[];
  /** True when the resource center is mounted at /home/.ishiki（仅 sandbox）。 */
  readonly resourcesMounted: boolean;
  /** native 模式的 shell 可执行文件；sandbox 恒为空字符串。 */
  readonly shellPath: string;
  readonly shellKind: ShellKind;
}

export interface WorkspaceShell extends WorkspaceLayout {
  /**
   * The shell's own file view, shared with the workspace URL scheme: the
   * sandbox's virtual, mounted and persistent files (the same bytes bash
   * sees) in sandbox mode, the host filesystem in native mode. Never a
   * reconstructed host path for the sandbox.
   */
  readonly fs: ResourceFileSystem;
  /** path 相对 cwd 解析；sandbox 用 posix 语义，native 用宿主语义（含 git-bash 风格盘符转换）。 */
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface ShellOptions {
  config: WorkspaceConfig;
  home: string;
  root: string;
  dataPath: string;
  logger: Logger;
  /** Resource center providing the /home/.ishiki mount; undefined disables it. */
  resources?: ResourceCenter;
}

/** shell 类型按 basename 判定（去 .exe、忽略大小写），决定参数拼法。 */
export function shellKindOf(shellPath: string): ShellKind {
  const base = shellPath.replaceAll("\\", "/").split("/").pop() ?? "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}

/**
 * 空 shell 配置的平台默认：Windows 优先 pwsh，兜底 powershell.exe（PATH 里的
 * bash.exe 可能是 WSL，路径语义完全不同，刻意避开）。
 */
export function defaultShell(configured: string): string {
  if (configured.length > 0) return configured;
  if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "pwsh.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

export function resolveLayout(options: ShellOptions): WorkspaceLayout {
  const { config } = options;
  const skills = discoverSkills(
    [BUILTIN_SKILLS_DIRECTORY, path.join(options.dataPath, "skills"), ...config.skills.map((dir) => path.resolve(options.root, dir))],
    options.logger,
  );
  const workspace = path.join(options.home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const backend = config.backend;
  const shellPath = backend === "native" ? defaultShell(config.shell) : "";
  return {
    backend,
    cwd: backend === "native" ? workspace : config.cwd,
    timeoutMs: config.timeoutMs,
    maxExecutionOutputBytes: config.maxExecutionOutputBytes,
    network: backend === "sandbox" && config.network,
    javascript: backend === "sandbox" && config.javascript,
    python: backend === "sandbox" && config.python,
    mounts: backend === "sandbox" ? [...resolveMounts(config.mounts, options.root), ...resolveSkillMounts(skills, options.root)] : [],
    skills,
    resourcesMounted: backend === "sandbox" && options.resources !== undefined,
    shellPath,
    shellKind: shellKindOf(shellPath),
  };
}
