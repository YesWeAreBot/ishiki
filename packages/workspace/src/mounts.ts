import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const HOME_MOUNT = "/home";
export const WORKSPACE_MOUNT = "/home/workspace";
export const SKILLS_MOUNT = "/home/skills";
export const ISHIKI_MOUNT = "/home/.ishiki";

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

function parseMount(entry: string): MountDeclaration {
  const text = entry.trim();
  const readOnly = text.endsWith(":ro");
  const body = readOnly ? text.slice(0, -":ro".length) : text;
  const split = body.lastIndexOf(":");
  if (split <= 0) throw new Error(`挂载声明无法解析，需要 source:target[:ro] 形式：${entry}`);
  return { source: body.slice(0, split), target: normalizeTarget(body.slice(split + 1), entry), readOnly };
}

function normalizeTarget(raw: string, entry: string): string {
  if (!raw.startsWith("/")) throw new Error(`挂载目标必须是沙箱内的绝对路径：${entry}`);
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`挂载目标不能是根目录，也不能含 . 或 .. 段：${entry}`);
  }
  return `/${segments.join("/")}`;
}

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

export function resolveMounts(entries: readonly string[], base: string): HostMount[] {
  const declarations = entries.map(parseMount);
  for (const declaration of declarations) {
    if (declaration.target === HOME_MOUNT || declaration.target.startsWith(`${HOME_MOUNT}/`)) {
      throw new Error(`挂载目标 ${declaration.target} 落在保留的 ${HOME_MOUNT} 之下`);
    }
  }
  return resolve(declarations, base);
}

export function resolveSkillMounts(skills: ReadonlyArray<{ readonly name: string; readonly directory: string }>, base: string): HostMount[] {
  return resolve(
    skills.map((skill) => ({ source: skill.directory, target: `${SKILLS_MOUNT}/${skill.name}`, readOnly: true })),
    base,
  );
}
