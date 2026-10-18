import * as fs from "node:fs/promises";
import path from "node:path";

import { FileScheme, ResourceError, type FileEntry, type FileUrl, type ResourceFileSystem } from "koishi-plugin-ishiki";

import type { Skill } from "./skills.js";

/**
 * `skill://<name>/<relative path>` — one skill directory of this runtime.
 * Host-backed: a read returns exactly the bytes the sandbox sees at
 * /home/skills/<name>. An empty relative path reads SKILL.md; links are
 * resolved, so a file cannot leave its skill directory.
 */
export class SkillScheme extends FileScheme {
  readonly scheme = "skill";

  public constructor(private readonly skills: readonly Skill[]) {
    super();
  }

  protected async open(url: FileUrl): Promise<FileEntry> {
    const skill = this.skills.find((entry) => entry.name === url.authority);
    if (skill === undefined) {
      const available = this.skills.map((entry) => entry.name).join(", ") || "none";
      throw new ResourceError("resource_not_found", `unknown skill "${url.authority}". Available: ${available}`);
    }
    const root = await fs.realpath(skill.directory);
    const target = await fs.realpath(path.resolve(root, ...(url.segments.length === 0 ? ["SKILL.md"] : url.segments)));
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ResourceError("invalid_resource_uri", `skill URL escapes the skill directory: ${url.href}`);
    }
    return { path: target, filename: path.basename(target) };
  }
}

/**
 * `workspace:///<path>` — the shell's own file view, so a URL reads what the
 * sandbox actually sees: persistent workspace files, in-memory virtual files
 * and mounted directories alike; in native mode, the host filesystem with the
 * shell's path resolution. Host paths are never reconstructed from the
 * sandbox layout.
 */
export class WorkspaceScheme extends FileScheme {
  readonly scheme = "workspace";

  public constructor(private readonly files: () => Promise<ResourceFileSystem>) {
    super();
  }

  protected async open(url: FileUrl): Promise<FileEntry> {
    // FileUrl 的段已经由 FileScheme 解析过：非空、不含 "."/".."/斜杠，这里只落成绝对路径。
    if (url.authority.length > 0 || url.segments.length === 0) {
      throw new ResourceError("invalid_resource_uri", `workspace URL needs an absolute path: workspace:///<path>, got ${url.href}`);
    }
    return { path: `/${url.segments.join("/")}`, filesystem: await this.files() };
  }
}
