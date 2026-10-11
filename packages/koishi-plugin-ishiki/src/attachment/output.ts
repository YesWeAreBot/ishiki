import { createHash } from "node:crypto";

import type { JSONValue, ToolResultOutput } from "@yesimagent/core";

import { ResourceCenter } from "../resources/center.js";
import { ResourceError } from "../resources/errors.js";
import { describeTruncation, truncate } from "../resources/text.js";
import type { AttachmentItem } from "../types.js";

/** Bytes already decoded, plus the provenance and type needed to archive them. */
interface Media {
  /** Absent when the entry only names a store URL and carries no payload. */
  bytes?: Uint8Array;
  /** Store URL the bytes came from; reused when the sidecar still matches. */
  source?: string;
  mediaType: string;
  filename?: string;
}

/** One part of a `content` tool result. */
type ContentPart = Extract<ToolResultOutput, { type: "content" }>["value"][number];

export interface ProcessedOutput {
  output: ToolResultOutput;
  items: AttachmentItem[];
}

const STORE_URL = /^(asset|artifact|local):\/\//;

/**
 * The unified tool-output exit.
 *
 * Two shapes arrive here. A `content` result carries SDK file parts (the MCP
 * conversion); a `json` result may carry an optional top-level `attachment`
 * array whose entries are the closed shapes of {@link mediaOf} — a read file
 * node, an MCP image/audio block, an embedded MCP resource. Only that array
 * is parsed. Everything else stays plain JSON and is only subject to the
 * shared text budget.
 *
 * Media bytes are archived (or reused) and leave a marker; a result longer
 * than the budget is archived as the rendered text and shown truncated with a
 * line anchor.
 */
export async function processOutput(center: ResourceCenter, toolName: string, converted: ToolResultOutput): Promise<ProcessedOutput> {
  if (converted.type === "error-text" || converted.type === "error-json" || converted.type === "execution-denied") return { output: converted, items: [] };

  const items: AttachmentItem[] = [];
  const output =
    converted.type === "content" ? await externalizeContent(center, toolName, converted, items) : await externalizeJson(center, toolName, converted, items);

  const visible = render(output);
  const cut = truncate(visible);
  if (cut === undefined) return { output, items };
  const artifact = await center.store.writeArtifact(toolName, Buffer.from(visible, "utf8"), {
    mediaType: output.type === "json" ? "application/json" : "text/plain",
  });
  return { output: { type: "text", value: describeTruncation(cut, artifact) }, items };
}

/** Replace file parts with markers, archiving their bytes in part order. */
async function externalizeContent(
  center: ResourceCenter,
  toolName: string,
  converted: Extract<ToolResultOutput, { type: "content" }>,
  items: AttachmentItem[],
): Promise<ToolResultOutput> {
  const settled = await Promise.all(converted.value.map((part) => externalizePart(center, toolName, part)));
  for (const { item } of settled) if (item !== undefined) items.push(item);
  return { type: "content", value: settled.map(({ part }) => part) };
}

/** One content part: text passes through, a file part becomes a marker. */
async function externalizePart(center: ResourceCenter, toolName: string, part: ContentPart): Promise<{ part: ContentPart; item?: AttachmentItem }> {
  const providerOptions = "providerOptions" in part ? part.providerOptions : undefined;
  const text = (value: string) => ({ type: "text" as const, text: value, ...(providerOptions === undefined ? {} : { providerOptions }) });
  if (part.type !== "file") return { part: text(part.type === "text" ? part.text : JSON.stringify(part)) };
  const data = part.data as { type: string; data?: unknown; url?: unknown; reference?: unknown; text?: unknown };
  if (data.type === "text") return { part: text(String(data.text ?? "")) };
  if (data.type === "reference") return { part: text(`[provider media reference: ${String(data.reference ?? "unknown")}]`) };

  const filename = part.filename;
  if (data.type === "url") {
    const url = String(data.url ?? "");
    if (!STORE_URL.test(url)) return { part: text(`[unloaded media: ${url}]`) };
    return { part: text(marker(url, part.mediaType, undefined, filename)), item: itemOf(url, part.mediaType, filename) };
  }

  const bytes = bytesOf(data.data);
  const url = await archive(center, toolName, bytes, part.mediaType, filename);
  return { part: text(marker(url, part.mediaType, bytes.byteLength, filename)), item: itemOf(url, part.mediaType, filename, bytes.byteLength) };
}

/**
 * Normalize a JSON value the way the SDK does (raw Dates and undefined do not
 * survive), then externalize its `attachment` array if it has one.
 */
async function externalizeJson(center: ResourceCenter, toolName: string, converted: ToolResultOutput, items: AttachmentItem[]): Promise<ToolResultOutput> {
  if (converted.type !== "json") return converted;
  const value: unknown = JSON.parse(JSON.stringify(converted.value) ?? "null");
  const attachment = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).attachment : undefined;
  if (!Array.isArray(attachment)) return { type: "json", value: value as JSONValue, providerOptions: converted.providerOptions };
  const extracted: unknown[] = [];
  for (const entry of attachment) extracted.push(await externalizeEntry(center, toolName, entry, items));
  return {
    type: "json",
    value: { ...(value as Record<string, unknown>), attachment: extracted } as JSONValue,
    providerOptions: converted.providerOptions,
  };
}

/** Archive one attachment entry and return the node with its payload removed. */
async function externalizeEntry(center: ResourceCenter, toolName: string, entry: unknown, items: AttachmentItem[]): Promise<unknown> {
  const media = mediaOf(entry);
  if (media === undefined) return entry;

  let url: string;
  let byteLength: number | undefined;
  if (media.bytes !== undefined) {
    url = await archive(center, toolName, media.bytes, media.mediaType, media.filename, media.source);
    byteLength = media.bytes.byteLength;
  } else if (media.source !== undefined && STORE_URL.test(media.source)) {
    url = media.source;
  } else {
    return entry;
  }

  items.push(itemOf(url, media.mediaType, media.filename, byteLength));
  const node: Record<string, unknown> = { ...(entry as Record<string, unknown>), url, byteLength };
  delete node.data;
  if (node.resource !== null && typeof node.resource === "object") {
    const resource = { ...(node.resource as Record<string, unknown>) };
    delete resource.blob;
    node.resource = resource;
  }
  return node;
}

/**
 * The closed shapes an attachment entry may take. A read file node, an MCP
 * image or audio block, an embedded MCP resource. Anything else — including
 * data sitting outside the `attachment` array — is ordinary JSON.
 */
function mediaOf(entry: unknown): Media | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const node = entry as Record<string, unknown>;
  if (node.type === "file" && typeof node.mediaType === "string") {
    const source = typeof node.url === "string" && node.url.length > 0 ? node.url : undefined;
    if (typeof node.data === "string" && node.data.length > 0)
      return { bytes: decodeBase64(node.data), source, mediaType: node.mediaType, filename: nameOf(node.filename) };
    if (source !== undefined) return { source, mediaType: node.mediaType, filename: nameOf(node.filename) };
    return undefined;
  }
  if ((node.type === "image" || node.type === "audio") && typeof node.mimeType === "string" && typeof node.data === "string" && node.data.length > 0) {
    return { bytes: decodeBase64(node.data), mediaType: node.mimeType };
  }
  if (node.type === "resource" && node.resource !== null && typeof node.resource === "object") {
    const resource = node.resource as Record<string, unknown>;
    if (typeof resource.blob === "string" && resource.blob.length > 0 && typeof resource.mimeType === "string")
      return { bytes: decodeBase64(resource.blob), mediaType: resource.mimeType, filename: nameOf(resource.uri) };
  }
  return undefined;
}

/**
 * Store bytes already in hand, reusing `source` when its sidecar still holds
 * the same hash and type. One sha256 of the held bytes plus one sidecar read;
 * the source is never re-fetched.
 */
async function archive(center: ResourceCenter, toolName: string, bytes: Uint8Array, mediaType: string, filename?: string, source?: string): Promise<string> {
  if (source !== undefined && /^(asset|artifact):\/\//.test(source)) {
    const existing = await storedHash(center, source);
    if (existing?.contentHash === sha256(bytes) && existing.mediaType === mediaType) return source;
  }
  return center.store.writeArtifact(toolName, bytes, { mediaType, filename });
}

/** Sidecar hash and type of a store URL, or undefined when it cannot be read. */
async function storedHash(center: ResourceCenter, url: string): Promise<{ contentHash?: string; mediaType?: string } | undefined> {
  try {
    const parsed = ResourceCenter.parse(url);
    return parsed.scheme === "asset"
      ? await center.store.getMeta("asset", "", parsed.authority)
      : await center.store.getMeta("artifact", parsed.authority, parsed.segments.at(-1)!);
  } catch {
    return undefined;
  }
}

/** What the model reads for this result. */
function render(output: ToolResultOutput): string {
  if (output.type === "text") return output.value;
  if (output.type === "json") return JSON.stringify(output.value, null, 2);
  if (output.type === "content") return output.value.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");
  return "";
}

/** An attachment item with only the facts that are known. */
function itemOf(url: string, mediaType: string, filename?: string, byteLength?: number): AttachmentItem {
  return { url, mediaType, ...(filename === undefined ? {} : { filename }), ...(byteLength === undefined ? {} : { byteLength }) };
}

/** Marker left where media bytes were. */
function marker(url: string, mediaType: string, bytes?: number, filename?: string): string {
  return `[attachment: ${url}; ${mediaType}${bytes === undefined ? "" : `; ${bytes} bytes`}${filename === undefined ? "" : `; ${filename}`}]`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `{ type: 'data', data }` accepts base64, Uint8Array or ArrayBuffer. */
function bytesOf(data: unknown): Uint8Array {
  if (typeof data === "string") return decodeBase64(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new ResourceError("invalid_resource_uri", "attachment data is neither base64 nor bytes");
}

function decodeBase64(data: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1 || data.length === 0) {
    throw new ResourceError("invalid_resource_uri", "attachment data is not a base64 payload");
  }
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** A filename safe to surface; URIs and paths are not names. */
function nameOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]+$/.test(value) ? value : undefined;
}
