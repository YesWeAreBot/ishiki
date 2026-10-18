import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import type { ResourcePayload, SchemeHandler } from "./center.js";
import { ResourceError } from "./errors.js";
import { concreteMediaType } from "./media.js";
import { selectText } from "./text.js";

/** The subset shared by the host filesystem and the real sandbox filesystem. */
export interface ResourceFileSystem {
  stat(path: string): Promise<{ isDirectory: boolean; size: number }>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<string[]>;
  readText?(path: string): AsyncIterable<string>;
  readFilePrefix?(path: string, length: number): Promise<Uint8Array>;
}

export interface FileUrl {
  href: string;
  authority: string;
  segments: readonly string[];
  view?: string;
  range?: { start: number; end?: number };
  offset: number;
}

export interface FileEntry {
  path: string;
  filesystem?: ResourceFileSystem;
  bytes?: Uint8Array;
  mediaType?: string;
  filename?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

class HostFileSystem implements ResourceFileSystem {
  async stat(file: string): Promise<{ isDirectory: boolean; size: number }> {
    const stat = await fs.stat(file);
    return { isDirectory: stat.isDirectory(), size: stat.size };
  }

  readFileBuffer(file: string): Promise<Uint8Array> {
    return fs.readFile(file);
  }

  readdir(file: string): Promise<string[]> {
    return fs.readdir(file);
  }

  readText(file: string): AsyncIterable<string> {
    return createReadStream(file, { encoding: "utf8" });
  }

  async readFilePrefix(file: string, length: number): Promise<Uint8Array> {
    const handle = await fs.open(file, "r");
    try {
      const bytes = Buffer.allocUnsafe(length);
      const result = await handle.read(bytes, 0, length, 0);
      return bytes.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  }
}

const hostFileSystem = new HostFileSystem();

/** A partial UTF-8 probe may end between the bytes of a character. */
export function isUtf8Text(bytes: Uint8Array, partial = false): boolean {
  const probe = bytes.subarray(0, 8192);
  if (probe.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(probe, { stream: partial || bytes.length > probe.length });
    return true;
  } catch {
    return false;
  }
}

/** File-specific parsing and reading; other schemes do not inherit its URL grammar. */
export abstract class FileScheme implements SchemeHandler {
  abstract readonly scheme: string;
  protected readonly immutable: boolean = false;
  protected abstract open(url: FileUrl): FileEntry | Promise<FileEntry>;

  public async resolve(input: string): Promise<ResourcePayload> {
    const { url, sourceUrl } = parseFileUrl(input);
    const entry = await this.open(url);
    const filesystem = entry.filesystem ?? hostFileSystem;
    let text: string | AsyncIterable<string>;
    if (url.view !== undefined) {
      if (url.view !== "meta") throw new ResourceError("unsupported_view", `unsupported file view "${url.view}"`);
      const metadata = entry.metadata ?? { ...(await filesystem.stat(entry.path)), mediaType: entry.mediaType, filename: entry.filename };
      text = JSON.stringify(metadata, null, 2);
    } else {
      const stat = entry.bytes === undefined ? await filesystem.stat(entry.path) : { isDirectory: false, size: entry.bytes.byteLength };
      if (stat.isDirectory) {
        text = (await filesystem.readdir(entry.path)).sort().join("\n");
      } else {
        const streamed = entry.bytes === undefined && filesystem.readText !== undefined && filesystem.readFilePrefix !== undefined;
        const probe = entry.bytes ?? (streamed ? await filesystem.readFilePrefix!(entry.path, 8192) : await filesystem.readFileBuffer(entry.path));
        const mediaType = concreteMediaType(entry.mediaType, probe);
        const textType =
          mediaType === undefined || mediaType === "application/octet-stream" || mediaType.startsWith("text/") || mediaType === "application/json";
        if (!textType || !isUtf8Text(probe, stat.size > probe.length)) {
          if (url.range !== undefined || url.offset !== 0)
            throw new ResourceError("invalid_resource_uri", `text selectors cannot read binary content: ${input}`);
          const bytes = streamed ? await filesystem.readFileBuffer(entry.path) : probe;
          return {
            type: "file",
            url: url.href,
            bytes,
            mediaType: mediaType ?? "application/octet-stream",
            size: bytes.byteLength,
            filename: entry.filename ?? path.posix.basename(entry.path.replaceAll("\\", "/")),
            immutable: this.immutable,
          };
        }
        text = streamed ? filesystem.readText!(entry.path) : new TextDecoder("utf-8", { ignoreBOM: true }).decode(probe);
      }
    }
    const selected = await selectText(text, url.range ?? {}, url.offset);
    return {
      type: "text",
      url: input,
      text: selected.text,
      size: Buffer.byteLength(selected.text),
      mediaType: url.view === "meta" ? "application/json" : entry.mediaType,
      filename: entry.filename,
      source: { url: sourceUrl, offset: url.offset, line: selected.line, column: selected.column },
    };
  }
}

function parseFileUrl(input: string): { url: FileUrl; sourceUrl: string } {
  const prefix = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(input);
  if (prefix === null || /[\0\r\n#]/.test(input)) throw new ResourceError("invalid_resource_uri", `invalid file URL: ${input}`);
  const question = input.indexOf("?");
  const location = question === -1 ? input : input.slice(0, question);
  const query = new URLSearchParams(question === -1 ? "" : input.slice(question + 1));
  for (const key of query.keys()) {
    if ((key !== "view" && key !== "offset") || query.getAll(key).length !== 1)
      throw new ResourceError("invalid_resource_uri", `unsupported file query in ${input}`);
  }
  const rawOffset = query.get("offset");
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (rawOffset !== null && (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)))
    throw new ResourceError("invalid_resource_uri", `invalid continuation offset: ${input}`);
  query.delete("offset");
  const sourceUrl = `${location}${query.size > 0 ? `?${query}` : ""}`;
  const colon = location.indexOf(":", prefix[0].length);
  const href = colon === -1 ? location : location.slice(0, colon);
  let range: { start: number; end?: number } | undefined;
  if (colon !== -1) {
    range = { start: 1 };
    for (const selector of location.slice(colon + 1).split(":")) {
      const match = /^(\d+)(?:([-+])(\d+))?$/.exec(selector);
      if (match === null) throw new ResourceError("invalid_resource_uri", `invalid line selector: ${input}`);
      const base: number = range.start;
      const start: number = base + Number(match[1]) - 1;
      const count = match[3] === undefined ? undefined : Number(match[3]);
      const requestedEnd = count === undefined ? undefined : match[2] === "+" ? start + count - 1 : base + count - 1;
      const end: number | undefined = range.end === undefined ? requestedEnd : requestedEnd === undefined ? range.end : Math.min(range.end, requestedEnd);
      if (
        !Number.isSafeInteger(start) ||
        start < 1 ||
        (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))
      )
        throw new ResourceError("invalid_resource_uri", `invalid line range: ${input}`);
      range = { start, ...(end === undefined ? {} : { end }) };
    }
  }
  const tail = href.slice(prefix[0].length);
  const parts = tail.split("/");
  const decode = (part: string): string => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new ResourceError("invalid_resource_uri", `invalid URL encoding: ${input}`);
    }
    if (decoded === "." || decoded === ".." || /[\0/\\]/.test(decoded)) throw new ResourceError("invalid_resource_uri", `invalid file path: ${input}`);
    return decoded;
  };
  const authority = decode(parts.shift()!);
  const segments = parts.filter((part) => part.length > 0).map(decode);
  return {
    url: { href, authority, segments, ...(query.has("view") ? { view: query.get("view")! } : {}), ...(range === undefined ? {} : { range }), offset },
    sourceUrl,
  };
}
