import { ResourceError } from "./errors.js";
import { ArtifactHandler, AssetHandler, LocalHandler } from "./handlers.js";
import { ResourceStore } from "./store.js";
import type { FileTextSource } from "./text.js";

export { ResourceError } from "./errors.js";

export interface ResourceText {
  type: "text";
  url: string;
  text: string;
  size: number;
  mediaType?: string;
  filename?: string;
  source?: FileTextSource;
}

export interface ResourceFile {
  type: "file";
  url: string;
  bytes: Uint8Array;
  mediaType: string;
  size: number;
  filename?: string;
  immutable: boolean;
}

export type ResourcePayload = ResourceText | ResourceFile;

/** A handler owns every part of its URL except the routing scheme. */
export interface SchemeHandler {
  readonly scheme: string;
  resolve(url: string): ResourcePayload | Promise<ResourcePayload>;
}

export const RESERVED_SCHEMES = ["asset", "artifact", "local"] as const;
const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/** One runtime's scheme registry and resource store. */
export class ResourceCenter {
  private readonly handlers = new Map<string, SchemeHandler>();

  public constructor(
    public readonly runtimeId: string,
    public readonly home: string,
    public readonly store: ResourceStore = new ResourceStore(home),
  ) {
    for (const handler of [new AssetHandler(store), new ArtifactHandler(store), new LocalHandler(home)]) {
      this.handlers.set(handler.scheme, handler);
    }
  }

  public attach(handler: SchemeHandler): () => void {
    const scheme = handler.scheme.toLowerCase();
    if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`invalid resource scheme "${handler.scheme}"`);
    if ((RESERVED_SCHEMES as readonly string[]).includes(scheme)) throw new Error(`scheme "${handler.scheme}://" is reserved by the resource center`);
    if (this.handlers.has(scheme)) throw new Error(`scheme "${handler.scheme}://" is already registered`);
    this.handlers.set(scheme, handler);
    return () => {
      this.handlers.delete(scheme);
    };
  }

  public listSchemes(): string[] {
    return [...this.handlers.keys()];
  }

  public async resolve(url: string): Promise<ResourcePayload> {
    const scheme = SCHEME_PREFIX.exec(url)?.[1]?.toLowerCase();
    if (scheme === undefined) throw new ResourceError("invalid_resource_uri", `invalid resource URL: ${url}`);
    const handler = this.handlers.get(scheme);
    if (handler === undefined) {
      const available = this.listSchemes()
        .map((name) => `${name}://`)
        .join(", ");
      throw new ResourceError("resource_unavailable", `unknown scheme "${scheme}://". Available: ${available}`);
    }
    try {
      return await handler.resolve(url);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
        throw new ResourceError("resource_not_found", `resource not found: ${url}`);
      throw new ResourceError("resource_read_failed", error instanceof Error ? error.message : String(error));
    }
  }
}
