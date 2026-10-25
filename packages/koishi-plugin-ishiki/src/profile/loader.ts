import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type Logger from "reggol";
import { parse } from "yaml";

import { overlaps, resolveProfile, type Profile } from "./config.js";

/** 读取单个 profile 的原始配置对象；目录或文件不存在、内容不是对象时返回 undefined。 */
export async function readProfileRaw(root: string, id: string): Promise<Record<string, unknown> | undefined> {
  for (const name of ["profile.yml", "profile.yaml"]) {
    const text = await readFile(path.join(root, id, name), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const raw = parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  }
  return undefined;
}

/** 扫描 profiles 根目录，逐个解析并做跨 profile 的认领冲突检查。 */
export function loadProfiles(root: string, logger: Logger): Profile[] {
  const profiles: Profile[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = ["profile.yml", "profile.yaml"].map((name) => path.join(root, entry.name, name)).find((candidate) => existsSync(candidate));
    if (file === undefined) {
      logger.warn(`no profile.yml under "${entry.name}", directory skipped`);
      continue;
    }
    try {
      const profile = resolveProfile(parse(readFileSync(file, "utf8")), entry.name, path.join(root, entry.name));
      assertDisjoint(profiles, profile);
      profiles.push(profile);
    } catch (error) {
      logger.error(`[${entry.name}] profile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (profiles.length === 0) {
    logger.warn(`No profile to load under ${root}`);
  }
  return profiles;
}

function assertDisjoint(loaded: readonly Profile[], next: Profile): void {
  for (const [sid, mine] of next.channels) {
    const other = loaded.find((profile) => profile.channels.has(sid));
    if (other === undefined) continue;
    if (overlaps(mine, other.channels.get(sid)!)) {
      throw new Error(`profile "${other.id}" already claims channels of "${sid}"`);
    }
  }
}
