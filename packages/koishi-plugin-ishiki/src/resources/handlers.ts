import type * as fsApi from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import type { ResourcePayload, ResourceUrl, SchemeHandler } from "./center.js";
import { ResourceError } from "./errors.js";
import { concreteMediaType, sniffMediaType } from "./media.js";
import type { ResourceMeta, ResourceStore } from "./store.js";

/** Max text payload inlined into a resource resolution. Larger texts must be sliced via the read tool. */
const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

export { sniffMediaType } from "./media.js";

export function isUtf8Text(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(probe);
    return true;
  } catch {
    return false;
  }
}

function textPayload(url: string, bytes: Uint8Array): ResourcePayload {
  return { url, content: new TextDecoder().decode(bytes), size: bytes.byteLength };
}

function binaryPayload(url: string, bytes: Uint8Array, mediaType: string, filename?: string): ResourcePayload {
  return { url, bytes, mediaType, size: bytes.byteLength, filename };
}

/** One-line human-readable summary of a meta row, for the meta view. */
function metaSummary(meta: ResourceMeta): string {
  const size = meta.byteLength !== undefined ? `${meta.byteLength} bytes` : "not fetched yet";
  const type = meta.mediaType ?? "unknown type";
  const file = meta.filename ? `, ${meta.filename}` : "";
  const source = meta.sourceInfo && Object.keys(meta.sourceInfo).length > 0 ? `, source info: ${JSON.stringify(meta.sourceInfo)}` : "";
  return `${type}, ${size}${file}${source}. Pass this URL to \`read\` to load the content.`;
}

/** Zero-fetch metadata probe shared by the store-backed handlers. */
function metaView(url: ResourceUrl, meta: ResourceMeta): ResourcePayload {
  return { url: url.href, content: metaSummary(meta), size: meta.byteLength ?? 0, filename: meta.filename, notes: ["metadata only; no bytes were loaded"] };
}

/**
 * `asset://<32hex>` — lazy-fetched media. resolve materializes the bytes
 * (memory/disk cache, then the source fetch), so `asset://` behaves like any
 * other scheme: one resolve, one payload, no side doors.
 */
export class AssetHandler implements SchemeHandler {
  readonly scheme = "asset";

  public constructor(private readonly store: ResourceStore) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    if (!/^[a-f0-9]{32}$/.test(url.authority) || url.segments.length > 0) {
      throw new ResourceError("invalid_resource_uri", `asset URL must be asset://<32-hex-id>: ${url.href}`);
    }
    const meta = await this.store.getMeta("asset", "", url.authority);
    if (!meta) throw new ResourceError("resource_not_found", `asset not found: ${url.href}`);
    const bytes = await this.store.readBytes("asset", "", url.authority);
    const filename = meta.filename ?? path.basename(meta.src?.split("?")[0] ?? "");
    return {
      url: url.href,
      bytes,
      mediaType: concreteMediaType(meta.mediaType, bytes),
      size: bytes.byteLength,
      filename: /^[\w.-]+$/.test(filename) ? filename : undefined,
    };
  }

  /** Zero-fetch metadata probe: mediaType, size, source info — no bytes loaded. */
  public async resolveView(url: ResourceUrl, view: string): Promise<ResourcePayload> {
    if (view !== "meta") throw new ResourceError("unsupported_view", `asset scheme has no "${view}" view`);
    const meta = await this.store.getMeta("asset", "", url.authority);
    if (!meta) throw new ResourceError("resource_not_found", `asset not found: ${url.href}`);
    return metaView(url, meta);
  }

  /** Host path of the asset blob. */
  public locate(url: ResourceUrl): string {
    if (!/^[a-f0-9]{32}$/.test(url.authority)) {
      throw new ResourceError("invalid_resource_uri", `asset URL requires a full 32-hex id`);
    }
    return path.join(this.store.home, "resources", "assets", url.authority);
  }
}

/** `artifact://<tool>/<name>` — persisted tool output. */
export class ArtifactHandler implements SchemeHandler {
  readonly scheme = "artifact";

  public constructor(private readonly store: ResourceStore) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    if (!url.authority || url.segments.length === 0) {
      throw new ResourceError("invalid_resource_uri", `artifact URL requires tool namespace and name: ${url.href}`);
    }
    const name = url.segments.at(-1)!;
    const bytes = await this.store.readBytes("artifact", url.authority, name);
    const meta = await this.store.getMeta("artifact", url.authority, name);
    if (!isUtf8Text(bytes)) {
      return binaryPayload(url.href, bytes, sniffMediaType(bytes) ?? meta?.mediaType ?? "application/octet-stream", meta?.filename);
    }
    if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
      throw new ResourceError(
        "resource_too_large",
        `artifact is ${bytes.byteLength} bytes; use a line selector (:1-200) or process it at /home/.ishiki/artifacts/${url.authority}/${name} in the sandbox`,
      );
    }
    const payload = textPayload(url.href, bytes);
    payload.mediaType = meta?.mediaType;
    return payload;
  }

  /** Zero-fetch metadata probe. */
  public async resolveView(url: ResourceUrl, view: string): Promise<ResourcePayload> {
    if (view !== "meta") throw new ResourceError("unsupported_view", `artifact scheme has no "${view}" view`);
    const name = url.segments.at(-1)!;
    const meta = await this.store.getMeta("artifact", url.authority, name);
    if (!meta) throw new ResourceError("resource_not_found", `artifact not found: ${url.href}`);
    return metaView(url, meta);
  }

  /** Host path of the artifact blob. */
  public locate(url: ResourceUrl): string {
    if (!url.authority || url.segments.length === 0) {
      throw new ResourceError("invalid_resource_uri", `artifact URL requires tool namespace and name: ${url.href}`);
    }
    const name = url.segments.at(-1)!;
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith(".")) {
      throw new ResourceError("invalid_resource_uri", `invalid artifact name: ${url.href}`);
    }
    return path.join(this.store.home, "resources", "artifacts", url.authority, name);
  }
}

/** `local://<path>` — the runtime home, host side. */
export class LocalHandler implements SchemeHandler {
  readonly scheme = "local";

  public constructor(private readonly home: string) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const file = this.file(url);
    let stat: fsApi.Stats;
    try {
      stat = await fs.stat(file);
    } catch {
      throw new ResourceError("resource_not_found", `local file not found: ${url.href}`);
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file);
      return { url: url.href, content: entries.join("\n"), size: 0, notes: ["directory listing"] };
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    if (!isUtf8Text(bytes)) {
      return binaryPayload(url.href, bytes, sniffMediaType(bytes) ?? "application/octet-stream", path.basename(file));
    }
    if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
      throw new ResourceError("resource_too_large", `local file is ${bytes.byteLength} bytes; use a line selector or read it inside the sandbox at /home`);
    }
    return textPayload(url.href, bytes);
  }

  /** Host path of the local file. */
  public locate(url: ResourceUrl): string {
    return this.file(url);
  }

  private file(url: ResourceUrl): string {
    const relative = [url.authority, ...url.segments].filter(Boolean).join("/");
    if (!relative) throw new ResourceError("invalid_resource_uri", `local URL requires a path: ${url.href}`);
    const target = path.resolve(this.home, relative);
    const home = path.resolve(this.home);
    if (target !== home && !target.startsWith(home + path.sep)) {
      throw new ResourceError("invalid_resource_uri", `local URL escapes the runtime home: ${url.href}`);
    }
    return target;
  }
}
