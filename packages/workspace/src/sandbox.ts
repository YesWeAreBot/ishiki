import { mkdirSync } from "node:fs";
import path from "node:path";

import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs, type FsStat } from "just-bash";
import type { Logger } from "koishi";

import type { WorkspaceConfig } from "./config.js";
import { HOME_MOUNT, resolveMounts, resolveSkillMounts, WORKSPACE_MOUNT, type HostMount } from "./mounts.js";
import { ResourceFs } from "./resource-fs.js";
import { discoverSkills, type Skill } from "./skills.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface WorkspaceLayout {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputLength: number;
  readonly network: boolean;
  readonly javascript: boolean;
  readonly python: boolean;
  readonly mounts: readonly HostMount[];
  readonly skills: readonly Skill[];
}

export interface WorkspaceSandbox extends WorkspaceLayout {
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>;
  read(virtualPath: string): Promise<string>;
  write(virtualPath: string, content: string): Promise<void>;
}

export interface SandboxOptions {
  config: WorkspaceConfig;
  home: string;
  root: string;
  dataPath: string;
  logger: Logger;
  /** Resource center providing /assets and /artifacts mounts; undefined disables them. */
  resources?: import("koishi-plugin-ishiki").ResourceCenter;
}

function traversable(stat: FsStat): FsStat {
  return stat.isDirectory ? { ...stat, mode: stat.mode | 0o111 } : stat;
}

export function resolveLayout(options: SandboxOptions): WorkspaceLayout {
  const { config } = options;
  const skills = discoverSkills([path.join(options.dataPath, "skills"), ...config.skills.map((dir) => path.resolve(options.root, dir))], options.logger);
  const mounts = [...resolveMounts(config.mounts, options.root), ...resolveSkillMounts(skills, options.root)];
  mkdirSync(path.join(options.home, "workspace"), { recursive: true });
  return {
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    maxOutputLength: config.maxOutputLength,
    network: config.network,
    javascript: config.javascript,
    python: config.python,
    mounts,
    skills,
  };
}

export async function createSandbox(layout: WorkspaceLayout, options: SandboxOptions): Promise<WorkspaceSandbox> {
  const { home } = options;
  class Writable extends ReadWriteFs {
    override async stat(path: string): Promise<FsStat> {
      return traversable(await super.stat(path));
    }

    override async lstat(path: string): Promise<FsStat> {
      return traversable(await super.lstat(path));
    }
  }
  const homeView = new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint: HOME_MOUNT, filesystem: new OverlayFs({ root: home, mountPoint: "/", readOnly: true }) }],
  });
  const fs = new MountableFs({
    base: homeView,
    mounts: [
      { mountPoint: WORKSPACE_MOUNT, filesystem: new Writable({ root: path.join(home, "workspace") }) },
      ...(options.resources
        ? [
            { mountPoint: "/assets", filesystem: new ResourceFs(options.resources) },
            { mountPoint: "/artifacts", filesystem: new ResourceFs(options.resources) },
          ]
        : []),
      ...layout.mounts.map((mount) => ({
        mountPoint: mount.target,
        filesystem: mount.readOnly ? new OverlayFs({ root: mount.source, mountPoint: "/", readOnly: true }) : new Writable({ root: mount.source }),
      })),
    ],
  });
  const bash = new Bash({
    fs,
    cwd: layout.cwd,
    network: layout.network ? { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: true } : undefined,
    javascript: layout.javascript,
    python: layout.python,
  });

  return {
    ...layout,
    async exec(command, signal) {
      const timeout = AbortSignal.timeout(layout.timeoutMs);
      try {
        const result = await bash.exec(command, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
        return { stdout: truncate(result.stdout, layout.maxOutputLength), stderr: truncate(result.stderr, layout.maxOutputLength), exitCode: result.exitCode };
      } catch (error) {
        return { stdout: "", stderr: `bash: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
      }
    },
    read: (virtualPath) => fs.readFile(virtualPath, "utf8"),
    async write(virtualPath, content) {
      const parent = path.posix.dirname(virtualPath);
      if (parent !== "/") await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(virtualPath, content, "utf8");
    },
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... 输出超出 ${limit} 字符，已截断 ${text.length - limit} 字符 ...]`;
}
