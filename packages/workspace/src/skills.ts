import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";
import { parse as parseYaml } from "yaml";

import { SKILLS_MOUNT } from "./mounts.js";

/** 一个技能：一个带 SKILL.md 的目录。 */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** 宿主上的技能目录，只读挂到沙箱的 `/skills/<name>`。 */
  readonly directory: string;
}

/** 技能名同时是沙箱路径段，所以只认小写字母、数字与连字符。 */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 扫描技能目录，后者覆盖前者：profile 自己的目录排在数据根之后，同名以 profile 为准。
 *
 * 发现规则只走两层：目录自身含 SKILL.md 就是一个技能，否则只看它的直接子目录。
 * 技能目录按约定是平铺的；递归会把技能内部的资源目录也当技能，收益不抵这份歧义。
 */
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

/**
 * 读一个技能目录。名字必须与目录名一致且是合法路径段——不符就整个技能丢弃并报一条，
 * 不静默改名：名字同时是模型看到的沙箱路径，改名会让提示词与文件系统对不上。
 */
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

/** 取 SKILL.md 开头的 YAML frontmatter；没有或不是映射就当空。 */
function readFrontmatter(content: string): Record<string, unknown> {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (matched === null) return {};
  const parsed: unknown = parseYaml(matched[1]);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * 技能目录段：只给名字、用途与沙箱内位置，正文留给模型自己读。
 * 技能一多，把正文全塞进系统提示词就会挤掉本轮真正要看的东西。
 */
export function skillCatalog(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  return [
    "## 技能",
    `技能是可复用的做法与脚本，需要时先读它的 SKILL.md 再动手；脚本用沙箱内的 ${SKILLS_MOUNT}/<名字>/... 路径执行。`,
    ...skills.map((skill) => `- ${skill.name}：${skill.description}（${SKILLS_MOUNT}/${skill.name}）`),
  ].join("\n");
}
