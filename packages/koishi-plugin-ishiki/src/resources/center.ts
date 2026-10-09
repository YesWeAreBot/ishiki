import * as fs from "node:fs/promises";
import path from "node:path";

import type { Awaitable } from "koishi";

import { ResourceError } from "./errors.js";
import { ArtifactHandler, AssetHandler, LocalHandler, isUtf8Text } from "./handlers.js";
import { ResourceStore } from "./store.js";
import { fileText, textPage, type TextPage } from "./text.js";

export { ResourceError, type ResourceErrorCode } from "./errors.js";

/**
 * A resolved resource. Text-bearing schemes return `content`; binary schemes
 * return `bytes` with a detected or declared media type.
 */
export interface ResourcePayload {
  /** Canonical URL that was resolved. */
  url: string;
  content?: string;
  bytes?: Uint8Array;
  mediaType?: string;
  size: number;
  filename?: string;
  /** Extra model-facing context (e.g. "metadata only" notes). */
  notes?: string[];
}

/**
 * Per-runtime handler for one URL scheme. Handlers own their scheme's path
 * semantics entirely; the center owns routing, the view/selector grammar, and
 * error normalization.
 */
export interface SchemeHandler {
  readonly scheme: string;
  /** The scheme's path carries the wrapped resource's own syntax (mcp://); no views, no selectors. */
  readonly opaque?: boolean;
  resolve(url: ResourceUrl): Awaitable<ResourcePayload>;
  /** Alternative representation of the same resource (e.g. "meta"); undefined when the view is unsupported. */
  resolveView?(url: ResourceUrl, view: string): Awaitable<ResourcePayload>;
  /** Host filesystem path for file-backed schemes; used by the sandbox mount and future search tooling. */
  locate?(url: ResourceUrl): string | undefined;
}

/**
 * A parsed resource URL: `scheme://authority/path?view` with the selector
 * chain (`:1-200`) peeled off separately by the read tool.
 */
export interface ResourceUrl {
  scheme: string;
  /** Lowercased scheme. */
  rawScheme: string;
  /** Authority segment: asset id, artifact tool namespace, or first path segment. */
  authority: string;
  /** Path segments below the authority, already URL-decoded. */
  segments: readonly string[];
  /** View requested via `?view=<name>`, when present and well-formed. */
  view?: string;
  /** Raw query string without the `?`, verbatim. Opaque schemes keep it as part of their tail. */
  query?: string;
  /** Raw decoded-free tail after the authority (path + query), for opaque schemes. */
  rawTail: string;
  /** Exact input string (query included, selector chain excluded). */
  href: string;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?(.*))?$/;
const QUERY_VIEW_RE = /^view=([a-z][a-z0-9-]*)$/;

/** Schemes the resource center itself assembles; extensions may not register these names. */
export const RESERVED_SCHEMES = ["asset", "artifact", "local"] as const;

function isReserved(scheme: string): boolean {
  return (RESERVED_SCHEMES as readonly string[]).includes(scheme);
}

/**
 * The runtime's resource center: URL grammar, scheme registry, and routing.
 * It owns its store (bytes + metadata) and readies the three core schemes —
 * `asset://`, `artifact://`, `local://` — at construction. Extensions attach
 * their own schemes via `attach`; cores scheme names stay reserved.
 */
export class ResourceCenter {
  private handlers = new Map<string, SchemeHandler>();

  public constructor(
    public readonly runtimeId: string,
    public readonly home: string,
    public readonly store: ResourceStore = new ResourceStore(home),
  ) {
    this.register(new AssetHandler(store));
    this.register(new ArtifactHandler(store));
    this.register(new LocalHandler(home));
  }

  /** Register a core handler; reserved names are reachable only this way. */
  private register(handler: SchemeHandler): void {
    this.handlers.set(handler.scheme.toLowerCase(), handler);
  }

  /**
   * Register an extension scheme handler; returns the deregister function for
   * the extension's stop() hook. Reserved names and duplicates fail fast at
   * assembly time.
   */
  public attach(handler: SchemeHandler): () => void {
    const scheme = handler.scheme.toLowerCase();
    if (isReserved(scheme)) throw new Error(`scheme "${handler.scheme}://" is reserved by the resource center`);
    if (this.handlers.has(scheme)) throw new Error(`scheme "${handler.scheme}://" is already registered`);
    this.handlers.set(scheme, handler);
    return () => this.handlers.delete(scheme);
  }

  public listSchemes(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Whether the scheme's URLs take the `:1-200` selector chain:
   * registered and not opaque. Unknown schemes and opaque wrappers never peel.
   */
  public acceptsSelectors(scheme: string): boolean {
    const handler = this.handlers.get(scheme);
    return handler !== undefined && handler.opaque !== true;
  }

  /**
   * Resolve a resource URL through its handler. Unregistered schemes report
   * `resource_unavailable` with the available list; query views route to
   * `resolveView` when present. Opaque handlers keep their query verbatim.
   */
  public async resolve(input: string): Promise<ResourcePayload> {
    const url = ResourceCenter.parse(input);
    const handler = this.handlers.get(url.scheme);
    if (!handler) {
      const available = this.listSchemes()
        .map((scheme) => `${scheme}://`)
        .join(", ");
      throw new ResourceError(
        "resource_unavailable",
        available.length > 0 ? `unknown scheme "${url.scheme}://". Available: ${available}` : `unknown scheme "${url.scheme}://"`,
      );
    }
    try {
      if (handler.opaque !== true && url.query !== undefined && url.view === undefined) {
        throw new ResourceError("invalid_resource_uri", `unsupported query "?${url.query}" in ${input}`);
      }
      if (handler.opaque !== true && url.view !== undefined) {
        if (!handler.resolveView) {
          throw new ResourceError("unsupported_view", `scheme "${url.scheme}://" does not support views`);
        }
        return await handler.resolveView(url, url.view);
      }
      return await handler.resolve(url);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      throw new ResourceError("resource_read_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Stream text from disk before applying the read budget; binary resources use resolve. */
  public async readTextPage(input: string, range: { start?: number; end?: number; offset?: number }): Promise<TextPage | undefined> {
    const url = ResourceCenter.parse(input);
    if (url.query !== undefined && url.view !== "original") return undefined;
    if (url.scheme !== "artifact" && url.scheme !== "local") return undefined;
    let file = this.locate(input)!;
    if (url.scheme === "artifact") {
      const meta = await this.store.getMeta("artifact", url.authority, url.segments.at(-1)!);
      if (!meta) throw new ResourceError("resource_not_found", `artifact not found: ${input}`);
      if (url.view !== "original") {
        if (meta.viewName) file = path.join(path.dirname(file), meta.viewName);
        else if (meta.mediaType && !meta.mediaType.startsWith("text/") && meta.mediaType !== "application/json") return undefined;
      }
    }
    try {
      const handle = await fs.open(file, "r");
      try {
        if ((await handle.stat()).isDirectory()) return undefined;
        const probe = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        if (!isUtf8Text(probe.subarray(0, bytesRead))) return undefined;
      } finally {
        await handle.close();
      }
      return await textPage(fileText(file), range);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      throw new ResourceError("resource_read_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Host filesystem path for file-backed schemes, via the handler's own
   * locate. Returns undefined when the scheme has no stable host backing.
   */
  public locate(input: string): string | undefined {
    const url = ResourceCenter.parse(input);
    return this.handlers.get(url.scheme)?.locate?.(url);
  }

  /**
   * Parse `scheme://authority/path?query`; throws `invalid_resource_uri` on
   * malformed or traversal-bearing input. The query is captured verbatim:
   * well-formed `view=<name>` is exposed as `view`, and `resolve` rejects
   * anything else for non-opaque schemes so one URL always parses one way.
   */
  public static parse(input: string): ResourceUrl {
    const trimmed = input.trim();
    const match = SCHEME_RE.exec(trimmed);
    if (!match) throw new ResourceError("invalid_resource_uri", `invalid resource URL: ${input}`);
    const [, rawScheme, rawAuthority, rawPath, rawQuery] = match;
    const authority = decodeURIComponent(rawAuthority!);
    if (authority === "." || authority.startsWith("..")) {
      throw new ResourceError("invalid_resource_uri", `invalid authority in ${input}`);
    }
    const segments = rawPath!
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        const decoded = decodeURIComponent(segment);
        if (decoded === "." || decoded.startsWith("..") || decoded.includes("\0") || decoded.includes("\\")) {
          throw new ResourceError("invalid_resource_uri", `invalid path segment in ${input}`);
        }
        return decoded;
      });
    const query = rawQuery !== undefined && rawQuery.length > 0 ? rawQuery : undefined;
    const view = query === undefined ? undefined : QUERY_VIEW_RE.exec(query)?.[1];
    return {
      scheme: rawScheme!.toLowerCase(),
      rawScheme: rawScheme!,
      authority,
      segments,
      view,
      query,
      rawTail: `${rawPath!}${query === undefined ? "" : `?${query}`}`,
      href: trimmed,
    };
  }
}
