import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 同目录临时文件写入后原子替换，避免保存中途留下半个配置文件。 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  const staging = await mkdtemp(path.join(directory, ".ishiki-"));
  const staged = path.join(staging, path.basename(file));
  try {
    await writeFile(staged, content, "utf8");
    await rename(staged, file);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
