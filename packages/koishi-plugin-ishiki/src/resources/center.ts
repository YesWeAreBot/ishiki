import path from "node:path";

import type { Awaitable } from "koishi";

/**
 * Typed error codes for resource access failures. The model-facing reader turns
 * these into precise error text; callers may also branch on them programmatically.
 */
export type ResourceErrorCode = "invalid_resource_uri" | "resource_unavailable" | "resource_not_found" | "resource_too_large" | "resource_read_failed";

export class ResourceError extends Error {
  public constructor(
    public readonly code: ResourceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ResourceError";
  }
}

/** How a scheme's resources exist. `file`-backed schemes may expose a host path via `locate`. */
export type SchemeBacking = "file" | "virtual" | "remote";

/**
 * Declared facts about a scheme. Consumed by the reader (selector grammar in P2),
 * the sandbox mount adapter (P3), and the outbound resolver (P6).
 */
export interface SchemeSpec {
  backing: SchemeBacking;
  /** Scheme names reference immutable bytes: asset ids and artifact paths never mutate. */
  immutable: boolean;
  /** Runtime-scoped schemes resolve against the owning runtime's stores. */
  scope: "runtime" | "global";
}

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
  /** Extra model-facing context (e.g. truncation notes). */
  notes?: string[];
}

/** Per-runtime handler for one URL scheme. */
export interface SchemeHandler {
  readonly scheme: string;
  readonly spec: SchemeSpec;
  resolve(url: ResourceUrl): Awaitable<ResourcePayload>;
}

/**
 * A parsed resource URL. The authority is preserved as-is; path segments are
 * decoded once and validated against traversal at parse time.
 */
export interface ResourceUrl {
  scheme: string;
  /** Lowercased scheme. */
  rawScheme: string;
  /** Authority segment: asset id, artifact tool namespace, or first path segment. */
  authority: string;
  /** Path segments below the authority, already URL-decoded. */
  segments: readonly string[];
  /** Exact input string. */
  href: string;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)$/;

/** Schemes the ResourceCenter owns; extensions may not register these names. */
export const RESERVED_SCHEMES = ["asset", "artifact", "local", "skill", "workspace", "global"] as const;

const RESERVED: Record<string, true> = Object.fromEntries(RESERVED_SCHEMES.map((scheme) => [scheme, true as const]));

const ARTIFACT_TOOL_RE = /^[a-zA-Z0-9_-]+$/;

export class ResourceCenter {
  readonly #handlers = new Map<string, SchemeHandler>();

  public constructor(
    public readonly runtimeId: string,
    public readonly home: string,
  ) {}

  /** Register an extension scheme handler. Reserved names and duplicates fail fast at assembly time. */
  public use(handler: SchemeHandler): void {
    if (RESERVED[handler.scheme.toLowerCase()]) {
      throw new Error(`scheme "${handler.scheme}://" is reserved by the resource center`);
    }
    this.#set(handler);
  }

  /** Register a core-owned handler (asset/artifact/local); the only path allowed onto reserved names. */
  public useCore(handler: SchemeHandler): void {
    this.#set(handler);
  }

  #set(handler: SchemeHandler): void {
    const scheme = handler.scheme.toLowerCase();
    if (this.#handlers.has(scheme)) throw new Error(`scheme "${handler.scheme}://" is already registered`);
    this.#handlers.set(scheme, handler);
  }

  public remove(scheme: string): boolean {
    return this.#handlers.delete(scheme.toLowerCase());
  }

  public listSchemes(): string[] {
    return [...this.#handlers.keys()];
  }

  /** Parse `scheme://authority/path`; throws `invalid_resource_uri` on malformed or traversal-bearing input. */
  public static parse(input: string): ResourceUrl {
    const trimmed = input.trim();
    const match = SCHEME_RE.exec(trimmed);
    if (!match) throw new ResourceError("invalid_resource_uri", `invalid resource URL: ${input}`);
    const [, rawScheme, rawAuthority, rawPath] = match;
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
    return {
      scheme: rawScheme!.toLowerCase(),
      rawScheme: rawScheme!,
      authority,
      segments,
      href: trimmed,
    };
  }

  /** Resolve through a registered handler. Unregistered schemes report `resource_unavailable` with the available list. */
  public async resolve(input: string): Promise<ResourcePayload> {
    const url = ResourceCenter.parse(input);
    const handler = this.#handlers.get(url.scheme);
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
      return await handler.resolve(url);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      throw new ResourceError("resource_read_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Host filesystem path for a runtime-scoped resource, without reading bytes.
   * Returns undefined when the scheme has no stable host backing. Used by the
   * sandbox mount adapter and future search tooling — never for reads, which
   * go through handlers so the no-tool-inconsistency invariant holds.
   */
  public locate(input: string): string | undefined {
    const url = ResourceCenter.parse(input);
    switch (url.scheme) {
      case "asset":
        return this.#assetPath(url.authority);
      case "artifact":
        return this.#artifactPath(url);
      case "local":
        return this.#localPath(url);
      default:
        return undefined;
    }
  }

  /** Asset blob path. Throws when the id is not a full 32-hex hash. */
  #assetPath(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) {
      throw new ResourceError("invalid_resource_uri", `asset URL requires a full 32-hex id`);
    }
    return path.join(this.home, "resources", "assets", id);
  }

  #artifactPath(url: ResourceUrl): string {
    if (!url.authority || url.segments.length === 0) {
      throw new ResourceError("invalid_resource_uri", `artifact URL requires tool namespace and name: ${url.href}`);
    }
    if (!ARTIFACT_TOOL_RE.test(url.authority)) {
      throw new ResourceError("invalid_resource_uri", `invalid artifact tool namespace: ${url.href}`);
    }
    const name = url.segments.at(-1)!;
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith(".")) {
      throw new ResourceError("invalid_resource_uri", `invalid artifact name: ${url.href}`);
    }
    return path.join(this.home, "resources", "artifacts", url.authority, name);
  }

  #localPath(url: ResourceUrl): string {
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
