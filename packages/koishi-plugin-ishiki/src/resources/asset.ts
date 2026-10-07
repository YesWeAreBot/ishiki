import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ResourceError } from "./center.js";

/** Metadata row for an ingested asset. DB is the source of truth; bytes on disk are a cache. */
export interface AssetRecord {
  id: string;
  runtimeId: string;
  /** Original source URL (channel CDN, MCP media, ...) the id was derived from. */
  src: string;
  /** Media type declared by the source, if any. */
  mediaType?: string;
  /** Byte length once fetched; undefined until first access. */
  byteLength?: number;
  /** Content hash after fetch; undefined until first access. */
  contentHash?: string;
  /** When the source URL was registered. */
  ingestedAt: number;
  /** When bytes were last successfully fetched. */
  fetchedAt?: number;
  filename?: string;
}

/** Persistence seam for asset rows; the production implementation wraps koishi's database. */
export interface AssetDatabase {
  get(runtimeId: string, id: string): Promise<AssetRecord | undefined>;
  prefixSearch(runtimeId: string, prefix: string): Promise<AssetRecord[]>;
  create(row: AssetRecord): Promise<void>;
  markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }): Promise<void>;
}

const PREFIX_ID = /^[a-f0-9]{7,31}$/;

/** Single-flight cap so a burst of reads on a dead src fails fast instead of queuing. */
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export class AssetRegistry {
  readonly #memory = new Map<string, Uint8Array>();
  readonly #inflight = new Map<string, Promise<Uint8Array>>();

  public constructor(
    public readonly runtimeId: string,
    private readonly home: string,
    private readonly db: AssetDatabase,
  ) {}

  /** Derive the asset id from a source URL: first 32 hex chars of sha256(src). */
  public static deriveId(src: string): string {
    return createHash("sha256").update(src).digest("hex").slice(0, 32);
  }

  /**
   * Register a source URL and return its asset URL. Idempotent: an existing
   * row with the same (runtime, src-derived id) is returned unchanged, so
   * re-forwarded media and repeated MCP payloads collapse into one asset.
   */
  public async register(src: string, meta?: { mediaType?: string; filename?: string }): Promise<string> {
    const id = AssetRegistry.deriveId(src);
    const existing = await this.db.get(this.runtimeId, id);
    if (existing) return `asset://${id}`;
    await this.db.create({ id, runtimeId: this.runtimeId, src, ingestedAt: Date.now(), ...meta });
    return `asset://${id}`;
  }

  /** Look up a record by full id, unambiguous 7-31 hex prefix, or `asset://<id>` URL. */
  public async get(idOrPrefix: string): Promise<AssetRecord | undefined> {
    const id = idOrPrefix.startsWith("asset://") ? idOrPrefix.slice("asset://".length) : idOrPrefix;
    const record = await this.db.get(this.runtimeId, id);
    if (record) return record;
    if (!PREFIX_ID.test(id)) return undefined;
    const candidates = await this.db.prefixSearch(this.runtimeId, id);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Bytes for an asset id: memory cache → disk cache → fetch-and-cache.
   * Concurrent callers on the same id share one fetch. This is the single
   * entry point for every read path (read tool, sandbox mount, outbound send),
   * which is what keeps the same-URL-same-bytes invariant true.
   */
  public async readBytes(idOrPrefix: string, signal?: AbortSignal): Promise<Uint8Array> {
    const record = await this.get(idOrPrefix);
    if (!record) throw new ResourceError("resource_not_found", `asset not found: ${idOrPrefix}`);
    const disk = await this.#cacheGet(record.id);
    if (disk) return disk;
    const inflight = this.#inflight.get(record.id);
    if (inflight) return inflight;
    const task = this.#fetchAndCache(record, signal).finally(() => {
      this.#inflight.delete(record.id);
    });
    this.#inflight.set(record.id, task);
    return task;
  }

  async #fetchAndCache(record: AssetRecord, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = record.src.startsWith("data:") ? decodeDataUrl(record.src) : await fetchBytes(record.src, signal);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await this.#cachePut(record.id, bytes);
    await this.db.markFetched(this.runtimeId, record.id, { byteLength: bytes.byteLength, contentHash: hash });
    this.#memory.set(record.id, bytes);
    return bytes;
  }

  async #cacheGet(id: string): Promise<Uint8Array | undefined> {
    const memory = this.#memory.get(id);
    if (memory) return memory;
    try {
      const bytes = new Uint8Array(await fs.readFile(this.#blobPath(id)));
      this.#memory.set(id, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  }

  /** Atomic blob write: temp file + rename, so a crashed fetch never leaves a truncated blob. */
  async #cachePut(id: string, bytes: Uint8Array): Promise<void> {
    const dir = path.dirname(this.#blobPath(id));
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${id}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await fs.rename(temp, this.#blobPath(id));
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  #blobPath(id: string): string {
    return path.join(this.home, "resources", "assets", id);
  }
}

export function decodeDataUrl(src: string): Uint8Array {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);
  if (!match) throw new ResourceError("invalid_resource_uri", "malformed data: URL");
  const [, mediaType, isBase64, payload] = match;
  if (isBase64) {
    try {
      return new Uint8Array(Buffer.from(payload!, "base64"));
    } catch {
      throw new ResourceError("resource_read_failed", "data: URL base64 decode failed");
    }
  }
  const text = new Uint8Array(Buffer.from(decodeURIComponent(payload!), "utf-8"));
  // Caller attached no media type to an inline text payload; keep it out of the binary path.
  if (mediaType && !mediaType.startsWith("text/")) {
    throw new ResourceError("resource_read_failed", `unsupported inline data type: ${mediaType}`);
  }
  return text;
}

export async function fetchBytes(src: string, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const composite = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
  let response: Response;
  try {
    response = await fetch(src, { signal: composite, redirect: "follow" });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new ResourceError("resource_read_failed", `asset source timed out after ${FETCH_TIMEOUT_MS}ms: ${src}`);
    }
    throw new ResourceError("resource_read_failed", `asset source unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new ResourceError("resource_read_failed", `asset source returned ${response.status} for ${src}`);
  }
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_FETCH_BYTES) {
    throw new ResourceError("resource_too_large", `asset exceeds ${MAX_FETCH_BYTES} bytes: ${src}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_FETCH_BYTES) {
    throw new ResourceError("resource_too_large", `asset exceeds ${MAX_FETCH_BYTES} bytes: ${src}`);
  }
  return new Uint8Array(buffer);
}
