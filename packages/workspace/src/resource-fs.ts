import type { FsStat, IFileSystem } from "just-bash";
import type { ResourceCenter, ResourceMeta } from "koishi-plugin-ishiki";

const EROFS = () => new Error("EROFS: resource mounts are read-only");
const ENOENT = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory: ${path}`), { code: "ENOENT" });

function dirStat(): FsStat {
  return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mode: 0o555, mtime: new Date(0) };
}

function fileStat(size: number, mtime: number): FsStat {
  return { isFile: true, isDirectory: false, isSymbolicLink: false, size, mode: 0o444, mtime: new Date(mtime) };
}
/** Where a path points inside the mounted resource tree. */
type ResourcePath = { kind: "root" } | { kind: "assets"; rest: readonly string[] } | { kind: "artifacts"; rest: readonly string[] } | { kind: "outside" };

const OUTSIDE: ResourcePath = { kind: "outside" };

/**
 * Read-only just-bash filesystem over the runtime resource center, mounted at
 * `/home/.ishiki`. Layout mirrors the URL space:
 *
 *   /home/.ishiki/assets/<32-hex-id>
 *   /home/.ishiki/artifacts/<tool>/<name>
 *
 * Byte reads funnel through `center.resolve`, the same path the read tool
 * uses, so a URL and its sandbox path always resolve to the same bytes; asset
 * reads trigger the lazy fetch on first access. Stat and readdir go through
 * the store's metadata and never fetch.
 */
export class ResourceFs implements IFileSystem {
  public constructor(private readonly center: ResourceCenter) {}

  async readFile(path: string, options?: { encoding?: string | null } | string): Promise<string> {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const bytes = await this.readFileBuffer(path);
    if (encoding === "binary" || encoding === "latin1") return Buffer.from(bytes).toString("latin1");
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const parsed = this.split(path);
    if (parsed.kind === "outside" || parsed.kind === "root" || parsed.rest.length === 0) throw ENOENT(path);
    const url = parsed.kind === "assets" ? `asset://${parsed.rest[0]}` : `artifact://${parsed.rest.join("/")}`;
    try {
      const payload = await this.center.resolve(url);
      if (payload.bytes !== undefined) return payload.bytes;
      return new TextEncoder().encode(payload.content ?? "");
    } catch {
      throw ENOENT(path);
    }
  }

  async writeFile(): Promise<void> {
    throw EROFS();
  }

  async appendFile(): Promise<void> {
    throw EROFS();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const parsed = this.split(path);
    if (parsed.kind === "outside") throw ENOENT(path);
    if (parsed.kind === "root" || parsed.rest.length === 0) return dirStat();
    const meta = await this.meta(parsed);
    if (meta === undefined || meta === null) {
      if (meta === null) return dirStat();
      throw ENOENT(path);
    }
    return fileStat(meta.byteLength ?? 0, meta.fetchedAt ?? meta.createdAt);
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(): Promise<void> {
    throw EROFS();
  }

  async readdir(path: string): Promise<string[]> {
    const parsed = this.split(path);
    if (parsed.kind === "outside") throw ENOENT(path);
    if (parsed.kind === "root") return ["assets", "artifacts"];
    if (parsed.rest.length === 0) {
      return parsed.kind === "assets" ? this.center.store.names("asset", "") : this.center.store.namespaces("artifact");
    }
    const meta = await this.meta(parsed);
    if (meta !== null) throw ENOENT(path);
    return this.center.store.names(parsed.kind === "assets" ? "asset" : "artifact", parsed.rest.join("/"));
  }

  async rm(): Promise<void> {
    throw EROFS();
  }

  async cp(): Promise<void> {
    throw EROFS();
  }

  async mv(): Promise<void> {
    throw EROFS();
  }

  async chmod(): Promise<void> {
    throw EROFS();
  }

  async symlink(): Promise<void> {
    throw EROFS();
  }

  async link(): Promise<void> {
    throw EROFS();
  }

  async readlink(): Promise<string> {
    throw ENOENT("");
  }

  async utimes(): Promise<void> {
    throw EROFS();
  }

  resolvePath(base: string, target: string): string {
    if (target.startsWith("/")) return target;
    const stack = base.split("/").filter((segment) => segment.length > 0);
    for (const segment of target.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") stack.pop();
      else stack.push(segment);
    }
    return `/${stack.join("/")}`;
  }

  getAllPaths(): string[] {
    return [];
  }

  async realpath(path: string): Promise<string> {
    await this.stat(path);
    return path;
  }

  /**
   * Metadata for a path without fetching: a row for files, `null` for a
   * directory, `undefined` for nothing.
   */
  private async meta(parsed: Extract<ResourcePath, { kind: "assets" | "artifacts" }>): Promise<ResourceMeta | null | undefined> {
    const { kind, rest } = parsed;
    if (kind === "assets") {
      if (rest.length !== 1) return undefined;
      return this.center.store.getMeta("asset", "", rest[0]);
    }
    if (rest.length === 1) {
      const tools = await this.center.store.namespaces("artifact");
      return tools.includes(rest[0]) ? null : undefined;
    }
    const name = rest.at(-1)!;
    return this.center.store.getMeta("artifact", rest.slice(0, -1).join("/"), name);
  }

  /**
   * Split a mounted path. MountableFs strips the mount point, so paths arrive
   * as the empty root, `assets/...`, or `artifacts/...`.
   */
  private split(path: string): ResourcePath {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const head = segments[0];
    if (head === undefined) return { kind: "root" };
    if (head === "assets") return { kind: "assets", rest: segments.slice(1) };
    if (head === "artifacts") return { kind: "artifacts", rest: segments.slice(1) };
    return OUTSIDE;
  }
}
