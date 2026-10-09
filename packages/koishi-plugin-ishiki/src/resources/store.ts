import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ResourceError } from "./errors.js";
import { concreteMediaType } from "./media.js";

/** Which namespace a stored resource belongs to. Matches the URL scheme names. */
export type ResourceKind = "asset" | "artifact";

/** Sidecar metadata: everything that is not the bytes themselves. */
export interface ResourceMeta {
  /** Blob sidecars share the historical plural assets/artifacts directories. */
  id: string;
  kind: ResourceKind;
  /** URL namespace below the kind: always "" for assets, tool name for artifacts. */
  namespace: string;
  /** Payload name: 32-hex id for assets, file name for artifacts. */
  name: string;
  mediaType?: string;
  byteLength?: number;
  /** sha256 of the bytes; filled on fetch / put-in-hand. */
  contentHash?: string;
  toolName?: string;
  toolCallId?: string;
  /** Stable readable representation for JSON outputs; original bytes remain in the blob. */
  viewName?: string;
  width?: number;
  height?: number;
  createdAt: number;
  /** Last successful byte materialization; absent means lazy fetch has not run. */
  fetchedAt?: number;
  /** Original source URL (CDN link, synthetic data: URL). Never shown in prompts. */
  src?: string;
  /** Channel display name, if any. */
  filename?: string;
  /**
   * Free-form source attributes from the inbound platform element (file-size,
   * summary, sub-type, ...). Purely informational for the agent — nothing in
   * the pipeline may depend on these keys being present.
   */
  sourceInfo?: Record<string, unknown>;
}

/** Parameters for storing bytes under a kind/namespace. */
export interface PutOptions {
  kind: ResourceKind;
  /** Tool namespace for artifacts; empty for assets. */
  namespace: string;
  /** Explicit name. When omitted for assets, derived from `src`; for artifacts required. */
  name?: string;
  mediaType?: string;
  filename?: string;
  /** Original source URL the id derives from (assets). */
  src?: string;
  /** Free-form inbound element attributes, stored verbatim. */
  toolName?: string;
  toolCallId?: string;
  viewName?: string;
  width?: number;
  height?: number;
  sourceInfo?: Record<string, unknown>;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ID_RE = /^[a-f0-9]{32}$/;

/** Fetch guard rails for lazy media. */
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * The one byte-and-meta store behind every runtime-scoped scheme handler.
 * Layout: `resources/assets/<id>` or `resources/artifacts/<tool>/<name>`, with `<name>.json` sidecars.
 * All writes are atomic (temp + rename); sidecar carries everything mutable.
 */
export class ResourceStore {
  private memory = new Map<string, Uint8Array>();
  private inflight = new Map<string, Promise<Uint8Array>>();

  public constructor(public readonly home: string) {}

  /** Derive a stable asset id from its source URL: first 32 hex chars of sha256(src). */
  public static deriveId(src: string): string {
    return createHash("sha256").update(src).digest("hex").slice(0, 32);
  }

  /** Register a source URL as an asset; idempotent per (runtime, src). Returns the asset URL. */
  public async registerAsset(src: string, meta?: { mediaType?: string; filename?: string; sourceInfo?: Record<string, unknown> }): Promise<string> {
    const name = ResourceStore.deriveId(src);
    const existing = await this.getMeta("asset", "", name);
    if (existing) return `asset://${name}`;
    await this.putMeta({
      id: name,
      kind: "asset",
      namespace: "",
      name,
      mediaType: meta?.mediaType ?? /^data:([^;,]+)/.exec(src)?.[1],
      filename: meta?.filename,
      src,
      sourceInfo: meta?.sourceInfo,
      createdAt: Date.now(),
    });
    return `asset://${name}`;
  }

  /** Content-addressed tool artifact. A readable view shares the original artifact URL. */
  public async writeArtifact(tool: string, bytes: Uint8Array, meta: Omit<Partial<PutOptions>, "kind" | "namespace"> = {}, view?: string): Promise<string> {
    const namespace = tool.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
    const hash = createHash("sha256").update(bytes).digest("hex");
    const viewHash = view === undefined ? "" : `-${createHash("sha256").update(view).digest("hex").slice(0, 16)}`;
    const name = `${hash}-${createHash("sha256")
      .update(meta.mediaType ?? "")
      .digest("hex")
      .slice(0, 8)}${viewHash}.blob`;
    const viewName = view === undefined ? undefined : `${name}.view`;
    if (viewName) await this.putBlob("artifact", namespace, viewName, Buffer.from(view!, "utf8"));
    return this.putInHand("artifact", namespace, name, bytes, { ...meta, toolName: tool, viewName });
  }

  /**
   * Store bytes already in hand (tool-returned media, channel downloads):
   * blob lands immediately, `fetchedAt` is set, readBytes never fetches.
   */
  public async putInHand(kind: ResourceKind, namespace: string, name: string, bytes: Uint8Array, meta: Partial<PutOptions>): Promise<string> {
    this.validate(kind, namespace, name);
    await this.putBlob(kind, namespace, name, bytes);
    const mediaType = concreteMediaType(meta.mediaType, bytes);
    const existing = await this.getMeta(kind, namespace, name);
    await this.putMeta({
      id: kind === "asset" ? name : name.replace(/\.[^.]*$/, ""),
      kind,
      namespace,
      name,
      mediaType,
      byteLength: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      toolName: meta.toolName ?? existing?.toolName,
      toolCallId: meta.toolCallId ?? existing?.toolCallId,
      viewName: meta.viewName ?? existing?.viewName,
      width: meta.width ?? existing?.width,
      height: meta.height ?? existing?.height,
      createdAt: existing?.createdAt ?? Date.now(),
      fetchedAt: Date.now(),
      src: meta.src ?? existing?.src,
      filename: meta.filename ?? existing?.filename,
      sourceInfo: meta.sourceInfo ?? existing?.sourceInfo,
    });
    this.memory.set(this.key(kind, namespace, name), bytes);
    return kind === "asset" ? `asset://${name}` : `artifact://${namespace}/${name}`;
  }

  /** Metadata for one stored resource, or undefined. */
  public async getMeta(kind: ResourceKind, namespace: string, name: string): Promise<ResourceMeta | undefined> {
    try {
      const raw = await fs.readFile(this.metaPath(kind, namespace, name), "utf-8");
      return JSON.parse(raw) as ResourceMeta;
    } catch {
      return undefined;
    }
  }

  /** All metadata rows of one kind (optionally one namespace), sorted by createdAt. */
  public async list(kind: ResourceKind, namespace?: string): Promise<ResourceMeta[]> {
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
    try {
      const entries = await fs.readdir(this.kindDir(kind), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** Payload names inside one namespace (blob files only, sidecars excluded). */
  public async names(kind: ResourceKind, namespace: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.kindDir(kind), namespace));
      return entries.filter((name) => NAME_RE.test(name) && !name.endsWith(".json") && !name.endsWith(".view"));
    } catch {
      return [];
    }
  }

  /**
   * Bytes for a stored resource. For lazy-fetched assets a cache miss
   * triggers a fetch through the recorded src; concurrent callers share one
   * fetch. This is the single byte entry for every read path.
   */
  public async readBytes(kind: ResourceKind, namespace: string, name: string, signal?: AbortSignal): Promise<Uint8Array> {
    const meta = await this.getMeta(kind, namespace, name);
    if (!meta) throw new ResourceError("resource_not_found", `resource not found: ${kind}/${namespace}/${name}`);
    const disk = await this.cacheGet(this.key(kind, namespace, name));
    if (disk) {
      await this.ensureMetadata(meta, disk);
      return disk;
    }
    if (kind === "artifact" || meta.fetchedAt !== undefined || !meta.src) {
      throw new ResourceError("resource_not_found", `resource bytes missing: ${kind}/${namespace}/${name}`);
    }
    const inflight = this.inflight.get(meta.name);
    if (inflight) return inflight;
    const task = this.fetchAndCache(meta, signal).finally(() => {
      this.inflight.delete(meta.name);
    });
    this.inflight.set(meta.name, task);
    return task;
  }

  private async fetchAndCache(meta: ResourceMeta, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = meta.src!.startsWith("data:") ? decodeDataUrl(meta.src!) : await fetchBytes(meta.src!, signal);
    await this.putInHand("asset", meta.namespace, meta.name, bytes, {
      src: meta.src,
      mediaType: meta.mediaType,
      filename: meta.filename,
      sourceInfo: meta.sourceInfo,
    });
    return bytes;
  }

  /** Refresh sidecar facts (size, hash, sniffed type) after bytes land. */
  private async ensureMetadata(meta: ResourceMeta, bytes: Uint8Array): Promise<void> {
    if (meta.fetchedAt !== undefined && meta.byteLength !== undefined && meta.contentHash && meta.mediaType && !meta.mediaType.endsWith("/*")) return;
    await this.putInHand(meta.kind, meta.namespace, meta.name, bytes, {
      src: meta.src,
      mediaType: meta.mediaType,
      filename: meta.filename,
      sourceInfo: meta.sourceInfo,
    });
  }

  private async putBlob(kind: ResourceKind, namespace: string, name: string, bytes: Uint8Array): Promise<void> {
    const file = path.join(this.kindDir(kind), namespace, name);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  private async putMeta(meta: ResourceMeta): Promise<void> {
    const file = this.metaPath(meta.kind, meta.namespace, meta.name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(meta, null, 2), { flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  private async cacheGet(key: string): Promise<Uint8Array | undefined> {
    const cached = this.memory.get(key);
    if (cached) return cached;
    try {
      const bytes = new Uint8Array(await fs.readFile(path.join(this.home, "resources", key)));
      this.memory.set(key, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  }

  private key(kind: ResourceKind, namespace: string, name: string): string {
    return kind === "asset" ? `assets/${name}` : `artifacts/${namespace}/${name}`;
  }

  private kindDir(kind: ResourceKind): string {
    return path.join(this.home, "resources", kind === "asset" ? "assets" : "artifacts");
  }

  private metaPath(kind: ResourceKind, namespace: string, name: string): string {
    return path.join(this.kindDir(kind), namespace, `${name}.json`);
  }

  private validate(kind: ResourceKind, namespace: string, name: string): void {
    if (kind === "asset") {
      if (!ID_RE.test(name)) throw new ResourceError("invalid_resource_uri", `asset name must be a 32-hex id: ${name}`);
      return;
    }
    if (!NAME_RE.test(namespace)) throw new ResourceError("invalid_resource_uri", `invalid artifact namespace: ${namespace}`);
    if (!NAME_RE.test(name) || name.startsWith(".")) throw new ResourceError("invalid_resource_uri", `invalid artifact name: ${name}`);
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
  if (mediaType && !mediaType.startsWith("text/")) {
    throw new ResourceError("resource_read_failed", `unsupported inline data type: ${mediaType}`);
  }
  return new Uint8Array(Buffer.from(decodeURIComponent(payload!), "utf-8"));
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
