import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { validate as validateUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";

import { AssetConfig as AssetConfigSchema, type AssetConfig } from "./config.js";
import { ResourceError } from "./errors.js";
import { detectStoredMediaType } from "./media.js";

/** Which namespace a stored resource belongs to. Matches the URL scheme names. */
export type ResourceKind = "asset" | "artifact";

export type AutoDownloadStatus = {
  status: "downloaded" | "skipped";
  reason?: string;
};

/** Sidecar metadata: everything that is not the bytes themselves. */
export interface ResourceMeta {
  /** Asset id or artifact content id. */
  id: string;
  kind: ResourceKind;
  /** URL namespace below the kind: always "" for assets, tool name for artifacts. */
  namespace: string;
  /** Actual payload filename. A pending asset uses its id until bytes arrive. */
  name: string;
  mediaType?: string;
  byteLength?: number;
  /** sha256 of the bytes; filled on fetch / put-in-hand. */
  contentHash?: string;
  createdAt: number;
  /** Last successful byte materialization; absent means the source is available only on demand. */
  fetchedAt?: number;
  /** Original source URL (CDN link, synthetic data: URL). Never shown in prompts. */
  src?: string;
  /** Channel display name, if any. */
  filename?: string;
  /** Last inbound auto-download decision, including a truthful skip reason. */
  autoDownload?: AutoDownloadStatus;
  /**
   * Free-form source attributes from the inbound platform element. Purely
   * informational for the agent; the pipeline never depends on these keys.
   */
  sourceInfo?: Record<string, unknown>;
}

/** Parameters for storing bytes under a kind/namespace. */
export interface PutOptions {
  kind: ResourceKind;
  /** Tool namespace for artifacts; empty for assets. */
  namespace: string;
  /** Explicit artifact name. Assets derive their canonical name from their id and bytes. */
  name?: string;
  mediaType?: string;
  filename?: string;
  /** Original source URL. */
  src?: string;
  sourceInfo?: Record<string, unknown>;
  autoDownload?: AutoDownloadStatus;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ASSET_META_RE = /^([0-9a-f-]{36})\.metadata\.json$/i;
const ASSET_BLOB_RE = /^([0-9a-f-]{36})\.([a-z0-9]+)$/i;

/** Extension appended to artifact names so `ls` inside the sandbox stays readable. */
const ARTIFACT_EXT = "bin";

/** Hard ceiling for an explicit read. Auto-download has its own configured ceiling. */
export const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Byte ceiling of the in-process copy; a read that misses goes back to disk. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

interface Probe {
  mediaType: string;
  byteLength: number;
}

interface CleanupGate {
  promise: Promise<void>;
  release: () => void;
}

/**
 * The one byte-and-meta store behind every runtime-scoped scheme handler.
 * Assets use `resources/assets/<uuid>.<ext>` with `<uuid>.metadata.json`
 * sidecars. Artifacts use `resources/artifacts/<tool>/<name>` with
 * `<name>.json` sidecars. All writes are atomic (temp + replace).
 */
export class ResourceStore {
  /** Insertion order is recency: a hit is re-inserted at the tail. */
  private memory = new Map<string, Uint8Array>();
  private cachedBytes = 0;
  private inflight = new Map<string, Promise<Uint8Array>>();
  private activeAssets = new Map<string, number>();
  private cleanupGates = new Map<string, CleanupGate>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private readonly assetConfig: AssetConfig;

  public constructor(
    public readonly home: string,
    config?: AssetConfig,
  ) {
    this.assetConfig = {
      autoDownloadMaxBytes: config?.autoDownloadMaxBytes ?? 20 * 1024 * 1024,
      cleanup: {
        enabled: config?.cleanup?.enabled ?? false,
        retentionDays: config?.cleanup?.retentionDays ?? 30,
        intervalMinutes: config?.cleanup?.intervalMinutes ?? 60,
      },
    };
    AssetConfigSchema(this.assetConfig);
  }

  /** Register a source URL under a persistently stored UUID v7. */
  public async registerAsset(src: string, meta?: { mediaType?: string; filename?: string; sourceInfo?: Record<string, unknown> }): Promise<string> {
    for (const existing of await this.list("asset")) {
      if (existing.src === src) return `asset://${existing.id}`;
    }
    const id = uuidv7();
    await this.putMeta({
      id,
      kind: "asset",
      namespace: "",
      name: id,
      mediaType: meta?.mediaType ?? /^data:([^;,]+)/.exec(src)?.[1],
      filename: meta?.filename,
      src,
      sourceInfo: meta?.sourceInfo,
      createdAt: Date.now(),
    });
    return `asset://${id}`;
  }

  /**
   * Probe and materialize a registered HTTP asset when HEAD and GET both fit
   * the configured auto-download ceiling. Expected unavailability is recorded
   * on the sidecar so the URL remains readable on demand.
   */
  public async autoDownload(name: string, expectedMediaType?: string): Promise<AutoDownloadStatus> {
    this.validate("asset", "", name);
    const meta = await this.getMeta("asset", "", name);
    if (meta === undefined) throw new ResourceError("resource_not_found", `asset not found: asset://${name}`);
    const release = await this.enterAsset(name);
    try {
      const current = await this.getMeta("asset", "", name);
      if (current === undefined) throw new ResourceError("resource_not_found", `asset not found: asset://${name}`);
      if (current.fetchedAt !== undefined) return current.autoDownload ?? { status: "downloaded" };
      const limit = this.assetConfig.autoDownloadMaxBytes;
      if (limit === 0) return this.recordAutoDownload(current, { status: "skipped", reason: "auto download disabled" });
      if (current.src === undefined || !/^https?:/i.test(current.src) || !URL.canParse(current.src))
        return this.recordAutoDownload(current, { status: "skipped", reason: "source is not an HTTP URL" });

      let probe: Probe;
      try {
        probe = await probeHttpSource(current.src);
      } catch (error) {
        return this.recordAutoDownload(current, { status: "skipped", reason: describeAutoDownloadError(error) });
      }
      if (probe.byteLength > limit)
        return this.recordAutoDownload(current, { status: "skipped", reason: `HEAD size ${probe.byteLength} exceeds ${limit} bytes` });
      if (!matchesExpectedMediaType(expectedMediaType, probe.mediaType))
        return this.recordAutoDownload(current, {
          status: "skipped",
          reason: `HEAD type ${probe.mediaType} does not match ${expectedMediaType ?? "the attachment kind"}`,
        });

      try {
        const bytes = await fetchBytes(current.src, { maxBytes: limit });
        const detected = await detectStoredMediaType(probe.mediaType, bytes);
        if (!matchesExpectedMediaType(expectedMediaType, detected.mediaType))
          return this.recordAutoDownload(current, {
            status: "skipped",
            reason: `downloaded type ${detected.mediaType} does not match ${expectedMediaType ?? "the attachment kind"}`,
          });
        await this.putInHand("asset", "", name, bytes, {
          src: current.src,
          mediaType: probe.mediaType,
          filename: current.filename,
          sourceInfo: current.sourceInfo,
          autoDownload: { status: "downloaded" },
        });
        return { status: "downloaded" };
      } catch (error) {
        return this.recordAutoDownload(current, { status: "skipped", reason: describeAutoDownloadError(error) });
      }
    } finally {
      release();
    }
  }

  /** Store a content-addressed tool output snapshot. */
  public async writeArtifact(tool: string, bytes: Uint8Array, meta: { mediaType?: string; filename?: string } = {}): Promise<string> {
    const namespace = tool.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ARTIFACT_EXT}`;
    return this.putInHand("artifact", namespace, name, bytes, meta);
  }

  /**
   * Store bytes already in hand. Asset blob names are always canonicalized to
   * `<uuid>.<detected-ext>`; artifacts retain their supplied names.
   */
  public async putInHand(kind: ResourceKind, namespace: string, name: string, bytes: Uint8Array, meta: Partial<PutOptions>): Promise<string> {
    this.validate(kind, namespace, kind === "asset" ? assetIdOfName(name) : name);
    const detected = await detectStoredMediaType(meta.mediaType, bytes);
    const id = kind === "asset" ? assetIdOfName(name) : name.replace(/\.[^.]*$/, "");
    const actualName = kind === "asset" ? `${id}.${detected.extension}` : name;
    await this.putBlob(kind, namespace, actualName, bytes);
    const existing = await this.getMeta(kind, namespace, kind === "asset" ? id : name);
    await this.putMeta({
      id,
      kind,
      namespace,
      name: actualName,
      mediaType: detected.mediaType,
      byteLength: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      createdAt: existing?.createdAt ?? Date.now(),
      fetchedAt: Date.now(),
      src: meta.src ?? existing?.src,
      filename: meta.filename ?? existing?.filename,
      sourceInfo: meta.sourceInfo ?? existing?.sourceInfo,
      autoDownload: meta.autoDownload ?? existing?.autoDownload,
    });
    this.cacheSet(this.key(kind, namespace, kind === "asset" ? id : actualName), bytes);
    return kind === "asset" ? `asset://${id}` : `artifact://${namespace}/${actualName}`;
  }

  /** Metadata for one stored resource, or undefined. */
  public async getMeta(kind: ResourceKind, namespace: string, name: string): Promise<ResourceMeta | undefined> {
    this.validate(kind, namespace, name);
    try {
      const raw = await fs.readFile(this.metaPath(kind, namespace, name), "utf-8");
      return JSON.parse(raw) as ResourceMeta;
    } catch {
      return undefined;
    }
  }

  /** All metadata rows of one kind (optionally one namespace), sorted by createdAt. */
  public async list(kind: ResourceKind, namespace?: string): Promise<ResourceMeta[]> {
    if (kind === "asset") {
      if (namespace !== undefined && namespace !== "") throw new ResourceError("invalid_resource_uri", "assets do not have namespaces");
      const rows: ResourceMeta[] = [];
      for (const id of await this.assetIds()) {
        const meta = await this.getMeta("asset", "", id);
        if (meta) rows.push(meta);
      }
      return rows.sort((a, b) => a.createdAt - b.createdAt);
    }
    const namespaces = namespace !== undefined ? [namespace] : await this.namespaces(kind);
    const rows: ResourceMeta[] = [];
    for (const ns of namespaces) {
      for (const name of await this.names(kind, ns)) {
        const meta = await this.getMeta(kind, ns, name);
        if (meta) rows.push(meta);
      }
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Directory names under one kind (the artifact tool namespaces). */
  public async namespaces(kind: ResourceKind): Promise<string[]> {
    if (kind === "asset") return [];
    try {
      const entries = await fs.readdir(this.kindDir(kind), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** Payload names inside one namespace (blob files only, sidecars excluded). */
  public async names(kind: ResourceKind, namespace: string): Promise<string[]> {
    if (kind === "asset" ? namespace !== "" : !NAME_RE.test(namespace) || namespace === "." || namespace === "..")
      throw new ResourceError("invalid_resource_uri", `invalid resource namespace: ${namespace}`);
    try {
      const entries = await fs.readdir(path.join(this.kindDir(kind), namespace));
      return entries.filter((name) => (kind === "asset" ? ASSET_BLOB_RE.test(name) : NAME_RE.test(name) && !name.endsWith(".json") && !name.endsWith(".view")));
    } catch {
      return [];
    }
  }

  /**
   * Bytes for a stored resource. An unmaterialized asset fetches through its recorded
   * source while an asset cleanup gate is held. Concurrent callers share one
   * fetch.
   */
  public async readBytes(kind: ResourceKind, namespace: string, name: string, signal?: AbortSignal): Promise<Uint8Array> {
    const meta = await this.getMeta(kind, namespace, name);
    if (!meta) throw new ResourceError("resource_not_found", `resource not found: ${kind}/${namespace}/${name}`);
    const release = kind === "asset" ? await this.enterAsset(meta.id) : () => undefined;
    try {
      const current = kind === "asset" ? await this.getMeta(kind, namespace, name) : meta;
      if (current === undefined) throw new ResourceError("resource_not_found", `resource not found: ${kind}/${namespace}/${name}`);
      const disk = await this.cacheGet(this.key(kind, namespace, kind === "asset" ? current.id : current.name), this.blobPath(kind, namespace, current.name));
      if (disk) {
        await this.ensureMetadata(current, disk);
        return disk;
      }
      if (kind === "artifact" || current.fetchedAt !== undefined) {
        throw new ResourceError("resource_not_found", `resource bytes missing: ${kind}/${namespace}/${name}`);
      }
      const inflight = this.inflight.get(current.id);
      if (inflight) return await inflight;
      const task = this.fetchAndCache(current, signal).finally(() => {
        this.inflight.delete(current.id);
      });
      this.inflight.set(current.id, task);
      return await task;
    } finally {
      release();
    }
  }

  /**
   * Delete expired assets and both files in each pair. An asset active in a
   * read or download is skipped until a later pass. Returns the delete count.
   */
  public async cleanupExpired(now = Date.now()): Promise<number> {
    const retentionMs = this.assetConfig.cleanup.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const meta of await this.list("asset")) {
      if (meta.createdAt > now - retentionMs) continue;
      const release = this.beginCleanup(meta.id);
      if (release === undefined) continue;
      try {
        const current = await this.getMeta("asset", "", meta.id);
        if (current === undefined || current.createdAt > now - retentionMs) continue;
        await fs.rm(path.join(this.kindDir("asset"), current.name), { force: true });
        await fs.rm(this.metaPath("asset", "", current.id), { force: true });
        this.cacheDelete(this.key("asset", "", current.id));
        removed += 1;
      } finally {
        release();
      }
    }
    return removed;
  }

  /** Idempotently run cleanup on the configured interval while the runtime is alive. */
  public startCleanup(onError: (error: unknown) => void): void {
    if (!this.assetConfig.cleanup.enabled || this.cleanupTimer !== undefined) return;
    const intervalMs = this.assetConfig.cleanup.intervalMinutes * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(onError);
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  /** Stop the cleanup task; safe to call more than once. */
  public stopCleanup(): void {
    if (this.cleanupTimer === undefined) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private async recordAutoDownload(meta: ResourceMeta, status: AutoDownloadStatus): Promise<AutoDownloadStatus> {
    await this.putMeta({ ...meta, autoDownload: status });
    return status;
  }

  private async fetchAndCache(meta: ResourceMeta, signal?: AbortSignal): Promise<Uint8Array> {
    const src = meta.src;
    if (src === undefined || (!src.startsWith("data:") && (!/^https?:/i.test(src) || !URL.canParse(src)))) {
      throw new ResourceError(
        "resource_unavailable",
        `asset has no directly downloadable source. Read asset://${meta.id}?view=meta for sourceInfo, then use a platform-specific file retrieval tool. In codemode, keep the returned URL in a local variable and pass it directly to the next tool in the same execution; do not return it to the model or copy it into a later call.`,
      );
    }
    const bytes = src.startsWith("data:") ? decodeDataUrl(src) : await fetchBytes(src, { signal, maxBytes: MAX_FETCH_BYTES });
    await this.putInHand("asset", meta.namespace, meta.id, bytes, {
      src,
      mediaType: meta.mediaType,
      filename: meta.filename,
      sourceInfo: meta.sourceInfo,
      autoDownload: meta.autoDownload,
    });
    return bytes;
  }

  /** Refresh sidecar facts after a cache hit from an older incomplete record. */
  private async ensureMetadata(meta: ResourceMeta, bytes: Uint8Array): Promise<void> {
    if (meta.fetchedAt !== undefined && meta.byteLength !== undefined && meta.contentHash && meta.mediaType && !meta.mediaType.endsWith("/*")) return;
    await this.putInHand(meta.kind, meta.namespace, meta.kind === "asset" ? meta.id : meta.name, bytes, {
      src: meta.src,
      mediaType: meta.mediaType,
      filename: meta.filename,
      sourceInfo: meta.sourceInfo,
      autoDownload: meta.autoDownload,
    });
  }

  private async putBlob(kind: ResourceKind, namespace: string, name: string, bytes: Uint8Array): Promise<void> {
    const file = this.blobPath(kind, namespace, name);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await replaceFile(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private async putMeta(meta: ResourceMeta): Promise<void> {
    const file = this.metaPath(meta.kind, meta.namespace, meta.kind === "asset" ? meta.id : meta.name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(meta, null, 2), { flag: "wx" });
      await replaceFile(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private async cacheGet(key: string, file: string): Promise<Uint8Array | undefined> {
    const cached = this.memory.get(key);
    if (cached !== undefined) {
      this.memory.delete(key);
      this.memory.set(key, cached);
      return cached;
    }
    try {
      const bytes = await fs.readFile(file);
      this.cacheSet(key, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  }

  /** Insert or refresh one entry, evicting the least recently used until it fits. */
  private cacheSet(key: string, bytes: Uint8Array): void {
    this.cacheDelete(key);
    if (bytes.byteLength > MAX_CACHE_BYTES) return;
    while (this.cachedBytes + bytes.byteLength > MAX_CACHE_BYTES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.cacheDelete(oldest);
    }
    this.memory.set(key, bytes);
    this.cachedBytes += bytes.byteLength;
  }

  private cacheDelete(key: string): void {
    const existing = this.memory.get(key);
    if (existing === undefined) return;
    this.memory.delete(key);
    this.cachedBytes -= existing.byteLength;
  }

  private async enterAsset(id: string): Promise<() => void> {
    const gate = this.cleanupGates.get(id);
    if (gate !== undefined) await gate.promise;
    this.activeAssets.set(id, (this.activeAssets.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.activeAssets.get(id) ?? 1) - 1;
      if (count === 0) this.activeAssets.delete(id);
      else this.activeAssets.set(id, count);
    };
  }

  private beginCleanup(id: string): (() => void) | undefined {
    if ((this.activeAssets.get(id) ?? 0) > 0 || this.cleanupGates.has(id)) return undefined;
    let releaseGate!: () => void;
    const promise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.cleanupGates.set(id, { promise, release: releaseGate });
    return () => {
      this.cleanupGates.delete(id);
      releaseGate();
    };
  }

  private async assetIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.kindDir("asset"));
      return entries.flatMap((name) => {
        const id = ASSET_META_RE.exec(name)?.[1];
        return id !== undefined && isAssetId(id) ? [id] : [];
      });
    } catch {
      return [];
    }
  }

  private key(kind: ResourceKind, namespace: string, name: string): string {
    return kind === "asset" ? `assets/${name}` : `artifacts/${namespace}/${name}`;
  }

  private kindDir(kind: ResourceKind): string {
    return path.join(this.home, "resources", kind === "asset" ? "assets" : "artifacts");
  }

  private metaPath(kind: ResourceKind, namespace: string, name: string): string {
    return kind === "asset" ? path.join(this.kindDir(kind), namespace, `${name}.metadata.json`) : path.join(this.kindDir(kind), namespace, `${name}.json`);
  }

  private blobPath(kind: ResourceKind, namespace: string, name: string): string {
    return path.join(this.kindDir(kind), namespace, name);
  }

  private validate(kind: ResourceKind, namespace: string, name: string): void {
    if (kind === "asset") {
      if (namespace !== "") throw new ResourceError("invalid_resource_uri", "assets do not have namespaces");
      if (!isAssetId(name)) throw new ResourceError("invalid_resource_uri", `asset name must be a UUID v7: ${name}`);
      return;
    }
    if (!NAME_RE.test(namespace) || namespace === "." || namespace === "..")
      throw new ResourceError("invalid_resource_uri", `invalid artifact namespace: ${namespace}`);
    if (!NAME_RE.test(name) || name.startsWith(".")) throw new ResourceError("invalid_resource_uri", `invalid artifact name: ${name}`);
  }
}

export function isAssetId(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 7;
}

function assetIdOfName(name: string): string {
  const id = name.split(".", 1)[0]!;
  if (!isAssetId(id)) throw new ResourceError("invalid_resource_uri", `asset file name must begin with a UUID v7: ${name}`);
  return id;
}

function matchesExpectedMediaType(expected: string | undefined, actual: string): boolean {
  if (expected === undefined || expected === "application/octet-stream") return true;
  if (!expected.endsWith("/*")) return expected === actual;
  return actual.startsWith(expected.slice(0, -1));
}

function describeAutoDownloadError(error: unknown): string {
  if (error instanceof ResourceError) return error.message ?? error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function probeHttpSource(src: string): Promise<Probe> {
  const response = await fetchWithTimeout(src, "HEAD");
  if (!response.ok) throw new ResourceError("resource_read_failed", `HEAD returned ${response.status}`);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || mediaType.length === 0 || mediaType === "*/*" || mediaType.endsWith("/*"))
    throw new ResourceError("resource_read_failed", "HEAD did not provide a concrete Content-Type");
  const byteLength = parseContentLength(response.headers.get("content-length"));
  if (byteLength === undefined) throw new ResourceError("resource_read_failed", "HEAD did not provide a valid Content-Length");
  return { mediaType, byteLength };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function fetchWithTimeout(src: string, method: "GET" | "HEAD"): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    return await fetch(src, { method, signal: timeout, redirect: "follow" });
  } catch (error) {
    if (timeout.aborted) throw new ResourceError("resource_read_failed", `asset source timed out after ${FETCH_TIMEOUT_MS}ms`);
    const cause = error instanceof Error ? error.cause : undefined;
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    const detail = typeof code === "string" ? code : error instanceof Error ? error.name : "fetch failed";
    throw new ResourceError("resource_read_failed", `asset source is unreachable: ${detail}`);
  }
}

export async function fetchBytes(src: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const composite = AbortSignal.any(options.signal === undefined ? [timeout] : [options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(src, { signal: composite, redirect: "follow" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new ResourceError("resource_read_failed", `asset source timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    const cause = error instanceof Error ? error.cause : undefined;
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    const detail = typeof code === "string" ? code : error instanceof Error ? error.name : "fetch failed";
    throw new ResourceError("resource_read_failed", `asset source is unreachable: ${detail}`);
  }
  if (!response.ok) throw new ResourceError("resource_read_failed", `asset source returned ${response.status}`);
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) throw new ResourceError("resource_too_large", `asset exceeds ${maxBytes} bytes`);
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ResourceError("resource_too_large", `asset exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResourceError("resource_too_large", `asset exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Windows cannot rename over an existing file; replace after writing a complete temp. */
async function replaceFile(temp: string, target: string): Promise<void> {
  try {
    await fs.rename(temp, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "EPERM"))) throw error;
    await fs.rm(target, { force: true });
    await fs.rename(temp, target);
  }
}

export function decodeDataUrl(src: string): Uint8Array {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);
  if (!match) throw new ResourceError("invalid_resource_uri", "malformed data: URL");
  const [, mediaType, isBase64, payload] = match;
  if (isBase64) {
    try {
      return Buffer.from(payload!, "base64");
    } catch {
      throw new ResourceError("resource_read_failed", "data: URL base64 decode failed");
    }
  }
  if (mediaType && !mediaType.startsWith("text/")) {
    throw new ResourceError("resource_read_failed", `unsupported inline data type: ${mediaType}`);
  }
  return Buffer.from(decodeURIComponent(payload!), "utf-8");
}
