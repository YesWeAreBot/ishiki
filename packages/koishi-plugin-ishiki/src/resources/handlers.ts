import type * as fsApi from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "./artifact.js";
import { AssetRegistry } from "./asset.js";
import type { AssetRecord } from "./asset.js";
import { ResourceCenter, ResourceError, type ResourcePayload, type ResourceUrl, type SchemeHandler, type SchemeSpec } from "./center.js";

/** Max text payload inlined into a resource resolution. Larger texts must be sliced via the read tool. */
const MAX_INLINE_TEXT_BYTES = 1024 * 1024;

export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes.length >= 12 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x74 && bytes[2] === 0x79 && bytes[3] === 0x70) return "video/mp4";
  return undefined;
}

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

/**
 * `asset://<32hex>` — lazy-fetched media. resolve returns a metadata card
 * (never bytes); `readBytes` is the byte-level entry the read tool and mount
 * adapter use, and is where the model's modality switch gets applied in P2.
 */
export class AssetHandler implements SchemeHandler {
  readonly scheme = "asset";
  readonly spec: SchemeSpec = { backing: "file", immutable: true, scope: "runtime" };

  public constructor(private readonly registry: AssetRegistry) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    if (!/^[a-f0-9]{32}$/.test(url.authority) || url.segments.length > 0) {
      throw new ResourceError("invalid_resource_uri", `asset URL must be asset://<32-hex-id>: ${url.href}`);
    }
    const record = await this.registry.get(url.authority);
    if (!record) throw new ResourceError("resource_not_found", `asset not found: ${url.href}`);
    const fetched = record.fetchedAt !== undefined ? `fetched ${new Date(record.fetchedAt).toISOString()}` : "not fetched yet (source: original URL)";
    const size = record.byteLength !== undefined ? `, ${record.byteLength} bytes` : "";
    return {
      url: url.href,
      content: `asset://${record.id}: ${record.mediaType ?? "unknown type"}${size}, ${fetched}${record.filename ? `, filename: ${record.filename}` : ""}. Pass this URL to \`read\` to load the content.`,
      size: record.byteLength ?? 0,
    };
  }

  /** Byte-level access for the read tool and sandbox mount adapter. */
  public readBytes(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.registry.readBytes(id, signal);
  }

  /** Record lookup for callers that branch on metadata before pulling bytes. */
  public getRecord(id: string): Promise<AssetRecord | undefined> {
    return this.registry.get(id);
  }

  /** All registered asset ids; used by the sandbox listing view. */
  public listIds(): Promise<string[]> {
    return this.registry.listIds();
  }

  /** Register a row and write bytes whose source is already materialized (tool-returned media). */
  public async putInHand(id: string, bytes: Uint8Array, row: { src: string; mediaType?: string; filename?: string }): Promise<void> {
    await this.registry.putInHand(id, bytes, row);
  }
}

/** `artifact://<tool>/<name>` — persisted tool output. */
export class ArtifactHandler implements SchemeHandler {
  readonly scheme = "artifact";
  readonly spec: SchemeSpec = { backing: "file", immutable: true, scope: "runtime" };

  public constructor(private readonly store: ArtifactStore) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    if (!url.authority || url.segments.length === 0) {
      throw new ResourceError("invalid_resource_uri", `artifact URL requires tool namespace and name: ${url.href}`);
    }
    const name = url.segments.at(-1)!;
    const bytes = await this.store.read(url.authority, name);
    const info = await this.store.info(url.authority, name);
    if (!isUtf8Text(bytes)) {
      const mediaType = sniffMediaType(bytes) ?? info?.meta.mediaType ?? "application/octet-stream";
      return binaryPayload(url.href, bytes, mediaType, info?.meta.filename);
    }
    if (bytes.byteLength > MAX_INLINE_TEXT_BYTES) {
      throw new ResourceError(
        "resource_too_large",
        `artifact is ${bytes.byteLength} bytes; use a line selector (:1-200) or process it at /artifacts/${url.authority}/${name} in the sandbox`,
      );
    }
    const payload = textPayload(url.href, bytes);
    payload.mediaType = info?.meta.mediaType;
    return payload;
  }
}

/** `local://<path>` — runtime.home, host side. */
export class LocalHandler implements SchemeHandler {
  readonly scheme = "local";
  readonly spec: SchemeSpec = { backing: "file", immutable: false, scope: "runtime" };

  public constructor(private readonly center: ResourceCenter) {}

  public async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const file = this.center.locate(url.href);
    if (file === undefined) throw new ResourceError("invalid_resource_uri", `unresolvable local URL: ${url.href}`);
    let stat: fsApi.Stats;
    try {
      stat = await fs.stat(file);
    } catch {
      throw new ResourceError("resource_not_found", `local file not found: ${url.href}`);
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(file);
      return { url: url.href, content: entries.join("\n"), size: stat.size, notes: ["directory listing"] };
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
}
