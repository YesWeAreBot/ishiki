import { mkdirSync } from "node:fs";
import path from "node:path";

import type { FsStat } from "just-bash";
import type { Logger } from "koishi";

import type { WorkspaceConfig } from "./config.js";
import { HOME_MOUNT, resolveMounts, resolveSkillMounts, WORKSPACE_MOUNT, type HostMount } from "./mounts.js";
import { discoverSkills, type Skill } from "./skills.js";

/** 一条命令的结果；退出码非 0 表示命令失败，不是工具失败。 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** 沙箱的静态部分：解析配置、发现技能、把挂载与工作区目录在宿主上落定。 */
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

/** 一个实例的沙箱：静态部分 + 解释器。宿主目录直写，没有要刷的缓冲与要收的句柄。 */
export interface WorkspaceSandbox extends WorkspaceLayout {
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>;
  read(virtualPath: string): Promise<string>;
  write(virtualPath: string, content: string): Promise<void>;
}

export interface SandboxOptions {
  config: WorkspaceConfig;
  /** 本实例的数据目录：只读挂在 `/home`，可写的工作区是它下面的 `workspace`。 */
  home: string;
  /** profile 目录：挂载与技能的相对路径都从这里解析。 */
  root: string;
  /** 内核数据根：`<dataPath>/skills` 是所有 profile 共享的技能目录。 */
  dataPath: string;
  logger: Logger;
}

/**
 * 补齐目录的进入位。Windows 上宿主对目录报 mode 0o666（没有执行位这个概念），ReadWriteFs
 * 原样透传；而 POSIX 语义里没有 x 的目录无法进入。shell 自己不查这一位，但回落到 python 的
 * 那座桥走 emscripten VFS 的权限检查，会把整个挂载点判成不可进入——连目录列表都拿不到。
 * Linux 上宿主目录本来就带 x，这里是恒等操作。
 */
function traversable(stat: FsStat): FsStat {
  return stat.isDirectory ? { ...stat, mode: stat.mode | 0o111 } : stat;
}

/**
 * 静态装配。全程同步，所以配置与目录写错都在 handler 里抛出去——这一实例装配失败，
 * 而不是等某一轮模型调工具时才冒出个看不懂的报错。
 */
export function resolveLayout(options: SandboxOptions): WorkspaceLayout {
  const { config } = options;
  const skills = discoverSkills([path.join(options.dataPath, "skills"), ...config.skills.map((dir) => path.resolve(options.root, dir))], options.logger);
  // 技能也是挂载，只是目标落在保留区里，所以它走另一条入口（见 mounts.ts）。
  const mounts = [...resolveMounts(config.mounts, options.root), ...resolveSkillMounts(skills, options.root)];
  // 可写挂载的 source 必须已经存在，数据目录下的这一层由我们建。
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

/**
 * 装载解释器并组装沙箱。这里走动态 import 而不是静态导入：just-bash 的 CJS 入口在模块初始化时用
 * `import.meta.url` 定位 python 的 wasm worker，而 CJS 里没有 `import.meta`，Python 一开放就会以
 * `Invalid URL` 失败；ESM 入口（`import` 条件，也是该包声明的 main）两种运行时都正常。
 */
export async function createSandbox(layout: WorkspaceLayout, home: string): Promise<WorkspaceSandbox> {
  const jb = await import("just-bash");
  // 可写宿主目录：读写照旧，只把宿主可能缺的进入位补上（见 traversable）。写成局部类是因为
  // 模块只能动态 import，而类必须在拿到模块之后才定义得出来。
  class Writable extends jb.ReadWriteFs {
    override async stat(path: string): Promise<FsStat> {
      return traversable(await super.stat(path));
    }

    override async lstat(path: string): Promise<FsStat> {
      return traversable(await super.lstat(path));
    }
  }
  // `/home` 里除工作区与技能之外的部分：数据目录的只读视图。MountableFs 不允许挂载点嵌套，
  // 而 `/home/workspace` 必须落在细节 `/home` 之内，所以只读视图做兜底文件系统、
  // 可写的工作区做它上面的一处挂载——两张表各自合法，合起来才是「只读数据目录开一个可写口子」。
  // 内层的 InMemoryFs 兜住 /bin、/tmp 这些默认目录（bash 启动时要往里放命令桩）。
  const homeView = new jb.MountableFs({
    base: new jb.InMemoryFs(),
    mounts: [{ mountPoint: HOME_MOUNT, filesystem: new jb.OverlayFs({ root: home, mountPoint: "/", readOnly: true }) }],
  });
  const fs = new jb.MountableFs({
    base: homeView,
    mounts: [
      { mountPoint: WORKSPACE_MOUNT, filesystem: new Writable({ root: path.join(home, "workspace") }) },
      // MountableFs 交给被挂载文件系统的是剥掉挂载点之后的路径，所以被挂的 OverlayFs 认的挂载点恒为 "/"。
      ...layout.mounts.map((mount) => ({
        mountPoint: mount.target,
        filesystem: mount.readOnly ? new jb.OverlayFs({ root: mount.source, mountPoint: "/", readOnly: true }) : new Writable({ root: mount.source }),
      })),
    ],
  });
  const bash = new jb.Bash({
    fs,
    cwd: layout.cwd,
    // 不开网络时 just-bash 根本不注册 curl / wget：命令不存在比默默打不通更好解释。
    network: layout.network ? { dangerouslyAllowFullInternetAccess: true, denyPrivateRanges: true } : undefined,
    // 附加运行时「默认关、按配置开」：开与不开只影响命令是否注册。
    javascript: layout.javascript,
    python: layout.python,
  });

  return {
    ...layout,
    async exec(command, signal) {
      // 时限与轮次中止共用一个信号：后者来自 core，前者是沙箱自己的上限。
      const timeout = AbortSignal.timeout(layout.timeoutMs);
      try {
        const result = await bash.exec(command, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) });
        return { stdout: truncate(result.stdout, layout.maxOutputLength), stderr: truncate(result.stderr, layout.maxOutputLength), exitCode: result.exitCode };
      } catch (error) {
        // just-bash 对一部分失败（往只读挂载上写、被限制的操作）直接抛异常而不是给退出码，
        // 这里一律折成一条命令失败：模型要看到的是「这条命令不行」，不是工具崩了。
        return { stdout: "", stderr: `bash: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
      }
    },
    read: (virtualPath) => fs.readFile(virtualPath, "utf8"),
    async write(virtualPath, content) {
      // MountableFs 不替调用方建父目录（bash 的 > 会），所以这里先补上。
      const parent = path.posix.dirname(virtualPath);
      if (parent !== "/") await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(virtualPath, content, "utf8");
    },
  };
}

/** 超限时留一句说明，否则模型会把截断当成文件的全部内容。 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... 输出超出 ${limit} 字符，已截断 ${text.length - limit} 字符 ...]`;
}
