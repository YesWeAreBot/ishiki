import { constants, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 由模块 URL 定位，CJS 由 __dirname 定位；两者都从当前目录上跳到包根。
const moduleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const presetDirectory = path.resolve(moduleDirectory, "..", "resources", "presets");

const presetFiles = [
  { source: "default/profile.yaml", target: "profiles/default/profile.yaml" },
  { source: "default/PERSONA.md", target: "profiles/default/PERSONA.md" },
  { source: "models.yaml", target: "models.yaml" },
] as const;

/** 只在全新的数据目录释放预设，避免向已有安装写入或覆盖用户配置。 */
export function installDefaultPreset(dataPath: string): boolean {
  if (existsSync(dataPath) && readdirSync(dataPath).length > 0) return false;

  for (const file of presetFiles) {
    const target = path.join(dataPath, file.target);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(presetDirectory, file.source), target, constants.COPYFILE_EXCL);
  }
  return true;
}
