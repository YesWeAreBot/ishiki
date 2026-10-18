import * as fs from "node:fs/promises";
import path from "node:path";

import { ResourceError } from "./errors.js";
import { FileScheme, type FileEntry, type FileUrl } from "./file.js";
import type { ResourceStore } from "./store.js";

export class AssetHandler extends FileScheme {
  readonly scheme = "asset";
  protected override readonly immutable: boolean = true;

  public constructor(private readonly store: ResourceStore) {
    super();
  }

  protected async open(url: FileUrl): Promise<FileEntry> {
    if (!/^[a-f0-9]{32}$/.test(url.authority) || url.segments.length !== 0)
      throw new ResourceError("invalid_resource_uri", `asset URL requires a 32-hex id: ${url.href}`);
    const meta = await this.store.getMeta("asset", "", url.authority);
    if (meta === undefined) throw new ResourceError("resource_not_found", `asset not found: ${url.href}`);
    const filename = meta.filename;
    return {
      path: path.join(this.store.home, "resources", "assets", url.authority),
      ...(url.view === undefined ? { bytes: await this.store.readBytes("asset", "", url.authority) } : {}),
      mediaType: meta.mediaType,
      filename,
      metadata: { mediaType: meta.mediaType, byteLength: meta.byteLength, filename, fetched: meta.fetchedAt !== undefined, sourceInfo: meta.sourceInfo },
    };
  }
}

export class ArtifactHandler extends FileScheme {
  readonly scheme = "artifact";
  protected override readonly immutable: boolean = true;

  public constructor(private readonly store: ResourceStore) {
    super();
  }

  protected async open(url: FileUrl): Promise<FileEntry> {
    if (!/^[a-zA-Z0-9._-]+$/.test(url.authority) || url.segments.length !== 1)
      throw new ResourceError("invalid_resource_uri", `artifact URL requires a tool namespace and name: ${url.href}`);
    const name = url.segments[0]!;
    const meta = await this.store.getMeta("artifact", url.authority, name);
    if (meta === undefined) throw new ResourceError("resource_not_found", `artifact not found: ${url.href}`);
    const binary =
      meta.mediaType !== undefined &&
      !meta.mediaType.startsWith("text/") &&
      meta.mediaType !== "application/json" &&
      meta.mediaType !== "application/octet-stream";
    return {
      path: path.join(this.store.home, "resources", "artifacts", url.authority, name),
      ...(url.view === undefined && binary ? { bytes: await this.store.readBytes("artifact", url.authority, name) } : {}),
      mediaType: meta.mediaType,
      filename: meta.filename,
      metadata: { mediaType: meta.mediaType, byteLength: meta.byteLength, filename: meta.filename, fetched: meta.fetchedAt !== undefined },
    };
  }
}

/** Runtime-relative host files, including their actual symlink target constraints. */
export class LocalHandler extends FileScheme {
  readonly scheme = "local";

  public constructor(private readonly home: string) {
    super();
  }

  protected async open(url: FileUrl): Promise<FileEntry> {
    const root = await fs.realpath(this.home);
    const file = await fs.realpath(path.resolve(root, url.authority, ...url.segments));
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new ResourceError("invalid_resource_uri", `local URL escapes the runtime home: ${url.href}`);
    return { path: file, filename: path.basename(file) };
  }
}
