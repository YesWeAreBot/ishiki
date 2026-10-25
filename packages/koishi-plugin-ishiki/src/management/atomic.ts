import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 配置文本的修订标识。 */
export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

/** 变更串行队列：同一管理器内的读改写落盘排队执行，消除并发窗口；某次失败不阻断后续。 */
export class ChangeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
