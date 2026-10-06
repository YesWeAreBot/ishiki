import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";
import { parse as parseYaml } from "yaml";

import { SKILLS_MOUNT } from "./mounts.js";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly directory: string;
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function discoverSkills(roots: readonly string[], logger: Logger): Skill[] {
  const found = new Map<string, Skill>();
  for (const root of roots) {
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    for (const directory of skillDirectories(root)) {
      const skill = readSkill(directory, logger);
      if (skill !== undefined) found.set(skill.name, skill);
    }
  }
  return [...found.values()];
}

function skillDirectories(root: string): string[] {
  if (statSync(path.join(root, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function readSkill(directory: string, logger: Logger): Skill | undefined {
  const file = path.join(directory, "SKILL.md");
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  const frontmatter = readFrontmatter(readFileSync(file, "utf8"));
  const directoryName = path.basename(directory);
  const name = typeof frontmatter.name === "string" ? frontmatter.name : directoryName;
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (name !== directoryName || !NAME.test(name)) {
    logger.warn(`技能目录 ${directory} 的名字必须是 ${directoryName} 且只含小写字母、数字与连字符，已跳过`);
    return undefined;
  }
  if (description.length === 0) {
    logger.warn(`技能 ${name} 的 SKILL.md 缺少 description，已跳过`);
    return undefined;
  }
  return { name, description, directory };
}

function readFrontmatter(content: string): Record<string, unknown> {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (matched === null) return {};
  const parsed: unknown = parseYaml(matched[1]);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

export function skillCatalog(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "## 技能",
    `技能是可复用的做法与脚本，需要时先读它的 SKILL.md 再动手；脚本用沙箱内的 ${SKILLS_MOUNT}/<名字>/... 路径执行。`,
    ...skills.map((skill) => `- ${skill.name}：${skill.description}（${SKILLS_MOUNT}/${skill.name}）`),
  ].join("\n");
}
