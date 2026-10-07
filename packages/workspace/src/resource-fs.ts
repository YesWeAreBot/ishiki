import type { FsStat, IFileSystem } from "just-bash";
import { AssetHandler, type ResourceCenter } from "koishi-plugin-ishiki";

const EROFS = () => new Error("EROFS: resource mounts are read-only");
const ENOENT = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory: ${path}`), { code: "ENOENT" });

function dirStat(): FsStat {
  return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0, mode: 0o555, mtime: new Date(0) };
}

function fileStat(size: number, mtime: Date): FsStat {
  return { isFile: true, isDirectory: false, isSymbolicLink: false, size, mode: 0o444, mtime };
}

/**
 * Read-only just-bash filesystem over the runtime resource center:
 * `/assets/<32-hex-id>` and `/artifacts/<tool>/<name>`. Byte reads funnel
 * through the same registry the read tool uses, so a URL and its sandbox
 * path always resolve to the same bytes; asset reads trigger the lazy fetch
 * on first access.
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
    const { scheme, rest } = this.split(path);
    if (scheme === "assets") return this.#readAsset(path, rest);
    return this.#readArtifactBytes(path, rest);
  }

  async #readAsset(path: string, segments: readonly string[]): Promise<Uint8Array> {
    const id = segments[0] ?? "";
    if (segments.length !== 1 || !/^[a-f0-9]{32}$/.test(id)) throw ENOENT(path);
    const handler = this.center.resolveHandler("asset");
    if (!(handler instanceof AssetHandler)) throw ENOENT(path);
    return handler.readBytes(id);
  }

  async #readArtifactBytes(path: string, segments: readonly string[]): Promise<Uint8Array> {
    if (segments.length < 2) throw ENOENT(path);
    const payload = await this.center.resolve(`artifact://${segments[0]}/${segments.slice(1).join("/")}`);
    if (payload.bytes !== undefined) return payload.bytes;
    return new TextEncoder().encode(payload.content ?? "");
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
    const { scheme, rest } = this.split(path);
    if (rest.length === 0) return dirStat();
    if (scheme === "assets") {
      if (rest.length > 1) throw ENOENT(path);
      const record = await this.center.assetRecord(rest[0]);
      if (!record) throw ENOENT(path);
      return fileStat(record.byteLength ?? 0, new Date(record.fetchedAt ?? record.ingestedAt));
    }
    if (rest.length === 1) return dirStat();
    const payload = await this.center.resolve(`artifact://${rest[0]}/${rest.slice(1).join("/")}`);
    return fileStat(payload.size, new Date(0));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(): Promise<void> {
    throw EROFS();
  }

  async readdir(path: string): Promise<string[]> {
    const { scheme, rest } = this.split(path);
    if (rest.length === 0) return scheme === "assets" ? this.center.listAssetIds() : this.center.listArtifactTools();
    if (scheme === "artifacts" && rest.length === 1) return this.center.listArtifactNames(rest[0]);
    throw ENOENT(path);
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

  private split(path: string): { scheme: "assets" | "artifacts"; rest: readonly string[] } {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const first = segments[0];
    // Direct call: absolute path carries the scheme segment.
    if (first === "assets" || first === "artifacts") return { scheme: first, rest: segments.slice(1) };
    // Mounted call: MountableFs strips the mount point, so the first segment
    // is the id (assets) or the tool namespace (artifacts). The shapes are
    // disjoint: asset ids are 32-hex, artifact tool namespaces are not.
    if (/^[a-f0-9]{32}$/.test(first)) return { scheme: "assets", rest: segments };
    return { scheme: "artifacts", rest: segments };
  }
}
