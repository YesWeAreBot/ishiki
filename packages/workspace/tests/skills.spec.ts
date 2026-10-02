import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSkills, skillCatalog } from "../src/skills.js";

const silent = { warn: () => undefined } as unknown as Logger;

function writeSkill(root: string, name: string, frontmatter: string): void {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n正文\n`);
}

let dataRoot: string;
let profileRoot: string;

beforeEach(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ishiki-workspace-skills-"));
  dataRoot = path.join(base, "skills");
  profileRoot = path.join(base, "profiles", "neko");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
});

afterEach(() => {
  rmSync(path.dirname(dataRoot), { recursive: true, force: true });
});

describe("技能发现", () => {
  it("取子目录里的 SKILL.md，名字与用途来自 frontmatter", () => {
    writeSkill(dataRoot, "pdf", "name: pdf\ndescription: 提取 PDF 文本");
    const skills = discoverSkills([dataRoot], silent);
    expect(skills).toEqual([{ name: "pdf", description: "提取 PDF 文本", directory: path.join(dataRoot, "pdf") }]);
  });

  it("目录自身带 SKILL.md 时它自己就是一个技能", () => {
    writeFileSync(path.join(dataRoot, "SKILL.md"), "---\nname: skills\ndescription: 目录本身\n---\n");
    expect(discoverSkills([dataRoot], silent).map((skill) => skill.name)).toEqual(["skills"]);
  });

  it("名字与目录名不一致、或缺少 description 的技能被整个丢弃", () => {
    writeSkill(dataRoot, "pdf", "name: extract\ndescription: 名字对不上目录");
    writeSkill(dataRoot, "silent", "name: silent");
    writeSkill(dataRoot, "Upper_Case", "name: Upper_Case\ndescription: 名字不是合法路径段");
    expect(discoverSkills([dataRoot], silent)).toEqual([]);
  });

  it("后面的技能目录覆盖前面的同名技能", () => {
    writeSkill(dataRoot, "pdf", "name: pdf\ndescription: 数据根那份");
    writeSkill(profileRoot, "pdf", "name: pdf\ndescription: profile 那份");
    const skills = discoverSkills([dataRoot, profileRoot], silent);
    expect(skills.map((skill) => skill.description)).toEqual(["profile 那份"]);
    expect(skills[0].directory).toBe(path.join(profileRoot, "pdf"));
  });

  it("不存在的技能目录只是没有技能，不报错", () => {
    expect(discoverSkills([path.join(dataRoot, "absent"), dataRoot], silent)).toEqual([]);
  });
});

describe("技能目录段", () => {
  it("没有技能时不占提示词", () => {
    expect(skillCatalog([])).toBe("");
  });

  it("给出名字、用途与沙箱内的位置", () => {
    writeSkill(dataRoot, "pdf", "name: pdf\ndescription: 提取 PDF 文本");
    const text = skillCatalog(discoverSkills([dataRoot], silent));
    expect(text).toContain("## 技能");
    expect(text).toContain("- pdf：提取 PDF 文本（/home/skills/pdf）");
  });
});
