import path from "node:path";

import { Bash, InMemoryFs, MountableFs, OverlayFs, ReadWriteFs, type FsStat } from "just-bash";

import { HOME_MOUNT, ISHIKI_MOUNT, WORKSPACE_MOUNT } from "./mounts.js";
import { ResourceFs } from "./resource-fs.js";
import type { ShellOptions, WorkspaceLayout, WorkspaceShell } from "./shell.js";

function traversable(stat: FsStat): FsStat {
  return stat.isDirectory ? { ...stat, mode: stat.mode | 0o111 } : stat;
}

export async function createSandbox(layout: WorkspaceLayout, options: ShellOptions): Promise<WorkspaceShell> {
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
      ...(options.resources ? [{ mountPoint: ISHIKI_MOUNT, filesystem: new ResourceFs(options.resources) }] : []),
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
    executionLimits: { maxOutputSize: layout.maxExecutionOutputBytes },
  });

  return {
    ...layout,
    fs,
    async exec(command, signal) {
      const timeout = AbortSignal.timeout(layout.timeoutMs);
      try {
        const result = await bash.exec(command, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (error) {
        return { stdout: "", stderr: `bash: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
      }
    },
    read: (target) => fs.readFile(resolveVirtualPath(layout, target), "utf8"),
    async write(target, content) {
      const virtualPath = resolveVirtualPath(layout, target);
      const parent = path.posix.dirname(virtualPath);
      if (parent !== "/") await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(virtualPath, content, "utf8");
    },
  };
}

/** 路径解析收进 adapter：相对路径相对 cwd，绝对虚拟路径原样。 */
function resolveVirtualPath(layout: WorkspaceLayout, target: string): string {
  return target.startsWith("/") ? target : path.posix.join(layout.cwd, target);
}
