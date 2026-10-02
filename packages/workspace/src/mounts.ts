import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** 本实例数据目录在沙箱里的挂载点，只读；它之下的挂载点都由内核这一侧填。 */
export const HOME_MOUNT = "/home";
/** 可写工作区在沙箱里的挂载点，落在 {@link HOME_MOUNT} 下，也是默认的工作目录。 */
export const WORKSPACE_MOUNT = "/home/workspace";
/** 技能在沙箱里的合并视图：每个技能是它下面的一个只读挂载。 */
export const SKILLS_MOUNT = "/home/skills";

/** 一条落定的挂载：宿主目录已 canonicalize，沙箱内的目标已规范化。 */
export interface HostMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

interface MountDeclaration {
  source: string;
  target: string;
  readOnly: boolean;
}

/**
 * 解析 `source:target[:ro]`。从右侧切分：沙箱内路径以 `/` 开头且不含冒号，
 * 而宿主机路径在 Windows 上自带盘符冒号，所以最后一个冒号才是分隔符——
 * `D:\data:/data` 与 `./a:/b:ro` 都切得对。
 */
function parseMount(entry: string): MountDeclaration {
  const text = entry.trim();
  const readOnly = text.endsWith(":ro");
  const body = readOnly ? text.slice(0, -":ro".length) : text;
  const split = body.lastIndexOf(":");
  if (split <= 0) throw new Error(`挂载声明无法解析，需要 source:target[:ro] 形式：${entry}`);
  return { source: body.slice(0, split), target: normalizeTarget(body.slice(split + 1), entry), readOnly };
}

/** 目标必须是沙箱内的绝对路径，且规范化成没有尾斜杠、没有 `.` / `..` 段的形式。 */
function normalizeTarget(raw: string, entry: string): string {
  if (!raw.startsWith("/")) throw new Error(`挂载目标必须是沙箱内的绝对路径：${entry}`);
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`挂载目标不能是根目录，也不能含 . 或 .. 段：${entry}`);
  }
  return `/${segments.join("/")}`;
}

/** 声明之间互不重叠：重复与互相嵌套都不允许。 */
function assertTargets(targets: readonly string[]): void {
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const left = targets[i];
      const right = targets[j];
      if (left === right) throw new Error(`挂载目标重复：${left}`);
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new Error(`挂载目标不能互相嵌套：${left} 与 ${right}`);
      }
    }
  }
}

/**
 * 把声明落成沙箱挂载。读写挂载与 docker 一致：source 不存在就建出来；
 * 只读挂载要求目录已经存在，写错路径不该悄悄建出一份空目录让人以为挂上了。
 *
 * 目标校验排在碰宿主机之前——一份坏声明不该在盘上建出半个目录树。
 */
function resolve(declarations: readonly MountDeclaration[], base: string): HostMount[] {
  assertTargets(declarations.map((declaration) => declaration.target));
  return declarations.map((declaration) => {
    const source = path.resolve(base, declaration.source);
    if (existsSync(source) && !statSync(source).isDirectory()) {
      throw new Error(`挂载的 source 必须是目录：${source}`);
    }
    if (!existsSync(source)) {
      if (declaration.readOnly) throw new Error(`只读挂载的 source 必须是已存在的目录：${source}`);
      mkdirSync(source, { recursive: true });
    }
    return { source: realpathSync(source), target: declaration.target, readOnly: declaration.readOnly };
  });
}

/**
 * 用户在 profile 里写的挂载。保留区只有一个 `/home`（可写工作区、技能、其余只读），
 * 那一层由内核自己填，用户声明一律不许踩进去。
 */
export function resolveMounts(entries: readonly string[], base: string): HostMount[] {
  const declarations = entries.map(parseMount);
  for (const declaration of declarations) {
    if (declaration.target === HOME_MOUNT || declaration.target.startsWith(`${HOME_MOUNT}/`)) {
      throw new Error(`挂载目标 ${declaration.target} 落在保留的 ${HOME_MOUNT} 之下`);
    }
  }
  return resolve(declarations, base);
}

/**
 * 技能目录的只读挂载，由技能发现的结果生成：目标形如 `/home/skills/<名字>`，正好落在保留区里，
 * 所以它不走上面那条保留检查，只走目标合法性与源目录检查。两组目标按构造不可能重叠：
 * 用户声明的都被挡在 `/home` 之外，技能的都在它里面。
 */
export function resolveSkillMounts(skills: ReadonlyArray<{ readonly name: string; readonly directory: string }>, base: string): HostMount[] {
  return resolve(
    skills.map((skill) => ({ source: skill.directory, target: `${SKILLS_MOUNT}/${skill.name}`, readOnly: true })),
    base,
  );
}
