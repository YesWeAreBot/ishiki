import path from "node:path";

/** 包内 resources 目录下某个资源的绝对路径。 */
export function resourcePath(...segments: string[]): string {
  let here: string;
  if (import.meta.url) {
    here = path.dirname(new URL(import.meta.url).pathname);
    if (process.platform === "win32" && here.startsWith("/")) here = here.slice(1);
  } else {
    here = __dirname;
  }
  return path.resolve(here, "..", "resources", ...segments);
}
