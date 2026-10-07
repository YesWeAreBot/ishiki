import * as fs from "node:fs/promises";
import path from "node:path";

import { ResourceError, type ResourcePayload, type ResourceUrl, type SchemeHandler } from "koishi-plugin-ishiki";

import { SKILLS_MOUNT } from "./mounts.js";
import type { Skill } from "./skills.js";

const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

function textPayload(url: string, bytes: Uint8Array): ResourcePayload {
  return { url, content: new TextDecoder().decode(bytes), size: bytes.byteLength };
}

function isUtf8Text(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(probe);
    return true;
  } catch {
    return false;
  }
}

/** Read a host file as text, with the same binary/oversize semantics as the core local scheme. */
async function readHostText(url: string, file: string): Promise<ResourcePayload> {
  const bytes = new Uint8Array(await fs.readFile(file));
  if (!isUtf8Text(bytes)) {
    throw new ResourceError("resource_read_failed", `${url}: binary content; use the sandbox path ${SKILLS_MOUNT} instead`);
  }
  if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
    throw new ResourceError("resource_too_large", `${url} is ${bytes.byteLength} bytes; use a line selector (:1-200) or read it in the sandbox`);
  }
  return textPayload(url, bytes);
}

/**
 * `skill://<name>/<relative path>` — the mounted skill directories of this
 * runtime. Content is host-backed (each skill directory), so reads mirror
 * exactly what the sandbox sees at /home/skills/<name>.
 */
export class SkillHandler implements SchemeHandler {
  readonly scheme = "skill";

  public constructor(private readonly skills: readonly Skill[]) {}

  private file(url: ResourceUrl): string {
    const skill = this.skills.find((entry) => entry.name === url.authority);
    if (!skill) {
      const available = this.skills.map((entry) => entry.name).join(", ") || "none";
      throw new ResourceError("resource_not_found", `unknown skill "${url.authority}". Available: ${available}`);
    }
    const relative = url.segments.join("/") || "SKILL.md";
    return path.join(skill.directory, relative);
  }

  async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    return readHostText(url.href, this.file(url));
  }
}

/**
 * `workspace://<path>` — the sandbox's persistent workspace root
 * (/home/workspace on the sandbox side, <runtime.home>/workspace on the
 * host side). The same bytes a bash `cat /home/workspace/...` returns.
 */
export class WorkspaceHandler implements SchemeHandler {
  readonly scheme = "workspace";

  public constructor(private readonly home: string) {}

  private file(url: ResourceUrl): string {
    const relative = url.segments.join("/");
    if (!relative) throw new ResourceError("invalid_resource_uri", `workspace URL requires a path: ${url.href}`);
    const target = path.resolve(this.home, "workspace", relative);
    const root = path.resolve(this.home, "workspace");
    if (!target.startsWith(root + path.sep)) {
      throw new ResourceError("invalid_resource_uri", `workspace URL escapes the workspace root: ${url.href}`);
    }
    return target;
  }

  async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const file = this.file(url);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      throw new ResourceError("resource_not_found", `workspace file not found: ${url.href}`);
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file);
      return { url: url.href, content: entries.join("\n"), size: 0, notes: ["directory listing"] };
    }
    return readHostText(url.href, file);
  }
}
