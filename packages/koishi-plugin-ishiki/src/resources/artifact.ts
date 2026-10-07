import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { ResourceError } from "./center.js";

/** Artifact metadata persisted as a sidecar next to the payload bytes. */
export interface ArtifactMeta {
  mediaType?: string;
  filename?: string;
  createdAt: number;
  byteLength: number;
}

export interface ArtifactInfo {
  tool: string;
  name: string;
  url: string;
  meta: ArtifactMeta;
}

const SAFE_TOOL = /^[a-zA-Z0-9_-]+$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Max inline payload the store accepts; tool outputs are text-first. */
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

/**
 * Runtime-scoped artifact store: `artifact://<tool>/<name>` over
 * `home/resources/artifacts/<tool>/<name>`. Bytes land on disk at write time
 * (tool outputs are already in hand — no lazy fetch), with a JSON sidecar for
 * metadata. Names are tool-chosen; uuidv7 is the recommended convention so
 * artifacts sort chronologically, but any safe name is accepted.
 */
export class ArtifactStore {
  public constructor(private readonly home: string) {}

  /** Write an artifact and return its URL. Existing names in the same tool namespace are overwritten. */
  public async put(tool: string, name: string, bytes: Uint8Array, meta?: { mediaType?: string; filename?: string }): Promise<string> {
    if (!SAFE_TOOL.test(tool)) throw new ResourceError("invalid_resource_uri", `invalid artifact tool namespace: ${tool}`);
    if (!SAFE_NAME.test(name)) throw new ResourceError("invalid_resource_uri", `invalid artifact name: ${name}`);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ResourceError("resource_too_large", `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const file = this.#payloadPath(tool, name);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    const metaFull: ArtifactMeta = {
      mediaType: meta?.mediaType,
      filename: meta?.filename,
      createdAt: Date.now(),
      byteLength: bytes.byteLength,
    };
    await fs.writeFile(this.#metaPath(tool, name), JSON.stringify(metaFull, null, 2), "utf-8");
    return `artifact://${tool}/${name}`;
  }

  /** Artifact bytes, or `resource_not_found`. */
  public async read(tool: string, name: string): Promise<Uint8Array> {
    const file = this.#payloadPath(tool, name);
    try {
      return new Uint8Array(await fs.readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ResourceError("resource_not_found", `artifact not found: artifact://${tool}/${name}`);
      }
      throw error;
    }
  }

  /** Artifact metadata sidecar, or undefined when the artifact does not exist. */
  public async info(tool: string, name: string): Promise<ArtifactInfo | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#metaPath(tool, name), "utf-8");
    } catch {
      return undefined;
    }
    const meta = JSON.parse(raw) as ArtifactMeta;
    return { tool, name, url: `artifact://${tool}/${name}`, meta };
  }

  /** All artifact names in a tool namespace, sorted; missing namespaces yield an empty list. */
  public async list(tool: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.#toolDir(tool));
    } catch {
      return [];
    }
    return entries.filter((name) => !name.endsWith(".json")).sort();
  }

  /** Remove one tool namespace entirely; used on runtime disposal (artifacts are ephemeral). */
  public async clearTool(tool: string): Promise<void> {
    if (!SAFE_TOOL.test(tool)) throw new ResourceError("invalid_resource_uri", `invalid artifact tool namespace: ${tool}`);
    await fs.rm(this.#toolDir(tool), { recursive: true, force: true });
  }

  #toolDir(tool: string): string {
    return path.join(this.home, "resources", "artifacts", tool);
  }

  #payloadPath(tool: string, name: string): string {
    return path.join(this.#toolDir(tool), name);
  }

  #metaPath(tool: string, name: string): string {
    return path.join(this.#toolDir(tool), `${name}.json`);
  }
}
