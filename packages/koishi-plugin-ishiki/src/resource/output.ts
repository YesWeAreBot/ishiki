import { createHash } from "node:crypto";

import type { JSONValue, ToolResultOutput } from "@yesimagent/core";

import type { AttachmentItem, ImageLifetime } from "../types/messages.js";
import type { ResourceCenter, ResourcePayload } from "./center.js";
import { ResourceError } from "./errors.js";
import { parseImageLifetime } from "./lifetime.js";
import { renderTextPage, textFits, type FileTextSource } from "./text.js";

/** One part of a `content` tool result. */
type ContentPart = Extract<ToolResultOutput, { type: "content" }>["value"][number];

/** The two non-media results the model exit can still rewrite. */
type TextOrJson = Extract<ToolResultOutput, { type: "text" | "json" }>;

/** Bytes already decoded, plus the provenance and type needed to archive them. */
interface Media {
  /** Absent when the entry only names a resource URL. */
  bytes?: Uint8Array;
  /** Resource URL the entry names: reused when immutable, snapshotted otherwise. */
  source?: string;
  mediaType: string;
  filename?: string;
}

/** A resolved media reference: the stable URL to attach, or why the URL is not one. */
type Reference = { url: string; byteLength: number } | { reason: string };

export interface ProcessedOutput {
  /** What the model sees for this result. */
  output: ToolResultOutput;
  /** References the runtime submits with the tool's attachment message; a missing lifetime means `once`. */
  items: AttachmentItem[];
}

/** Store URLs whose sidecar can prove that held bytes are the stored bytes. */
const REUSABLE_SOURCE = /^(asset|artifact):\/\//;
const ASSET_URL = /^asset:\/\/([a-f0-9]{32})\/?$/;
const ARTIFACT_URL = /^artifact:\/\/([^/?#]+)\/([^/?#]+)$/;

/**
 * The unified model exit for one tool result: media bytes are archived (or an
 * existing immutable reference is reused), media placeholders stay in the
 * visible value, and an over-budget text result is archived once and shown as
 * a page of that archive.
 *
 * Two shapes arrive here. A `content` result carries SDK file parts (the MCP
 * and read conversions); a `json` result may carry a top-level `attachments`
 * array whose entries are the closed shapes of {@link mediaOf} — a read file
 * node, an MCP image/audio block, an embedded MCP resource. Only that array
 * is parsed. Everything else stays plain JSON and is only subject to the
 * shared text budget.
 *
 * `raw` is the tool's own execute result. It is consulted for two things: a
 * text payload that still carries read provenance is the complete text behind
 * a read page, so such a result is never archived again — the page is
 * re-rendered from its source instead; and a read file result may name the
 * attachment lifetime it chose, which the SDK file part has no field for.
 *
 * `imageInput` is the profile capability; when it is off, lifetime metadata is
 * ignored while media bytes are still archived.
 */
export async function processOutput(
  center: ResourceCenter,
  toolName: string,
  converted: ToolResultOutput,
  raw?: unknown,
  imageInput = true,
): Promise<ProcessedOutput> {
  if (converted.type === "error-text" || converted.type === "error-json" || converted.type === "execution-denied") {
    return { output: await externalizeError(center, toolName, converted), items: [] };
  }

  const items: AttachmentItem[] = [];
  const output =
    converted.type === "content"
      ? await externalizeContent(center, toolName, converted, items)
      : await externalizeJson(center, toolName, converted, items, imageInput);

  // Only a direct read can hand its lifetime over through a raw result: the
  // content part carries no lifetime field, and provider options reach the
  // provider, so they must not transport runtime bookkeeping.
  const lifetime = imageInput && converted.type === "content" && items.length > 0 ? rawLifetime(raw) : undefined;
  if (lifetime !== undefined) for (const item of items) item.lifetime = lifetime;

  let visible: string;
  if (output.type === "text") visible = output.value;
  else if (output.type === "json") visible = JSON.stringify(output.value, null, 2);
  else visible = output.value.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");

  if (textFits(visible)) return { output, items };
  const page = readSource(raw);
  if (page !== undefined && output.type === "text") return { output: { ...output, value: renderTextPage(page.text, page.source) }, items };
  const artifact = await center.store.writeArtifact(toolName, Buffer.from(visible, "utf8"), {
    mediaType: output.type === "json" ? "application/json" : "text/plain",
  });
  return { output: { type: "text", value: renderTextPage(visible, { url: artifact, offset: 0, line: 1, column: 1 }) }, items };
}

/** Keep error semantics while replacing an over-budget error body with a safe archive reference. */
async function externalizeError(
  center: ResourceCenter,
  toolName: string,
  output: Extract<ToolResultOutput, { type: "error-text" | "error-json" | "execution-denied" }>,
): Promise<Extract<ToolResultOutput, { type: "error-text" | "error-json" | "execution-denied" }>> {
  const visible = output.type === "error-text" ? output.value : output.type === "error-json" ? JSON.stringify(output.value, null, 2) : (output.reason ?? "");
  if (textFits(visible)) return output;
  const artifact = await center.store.writeArtifact(toolName, Buffer.from(visible, "utf8"), {
    mediaType: output.type === "error-json" ? "application/json" : "text/plain",
  });
  const summary = `Tool failed; complete error output archived at ${artifact} (${visible.length} characters).`;
  if (output.type === "error-text") return { ...output, value: summary };
  if (output.type === "execution-denied") return { ...output, reason: summary };
  return {
    ...output,
    value: {
      error: "Tool failed; complete error output archived",
      artifact,
      characters: visible.length,
    },
  };
}

/**
 * The read provenance of a raw tool result, recognized structurally. A page
 * is identified by its complete text plus source, never by tool name or
 * footer wording.
 */
function readSource(raw: unknown): { text: string; source: FileTextSource } | undefined {
  if (raw === null || typeof raw !== "object" || !("type" in raw) || raw.type !== "text") return undefined;
  if (!("text" in raw) || typeof raw.text !== "string" || !("source" in raw)) return undefined;
  const source = raw.source;
  if (source === null || typeof source !== "object") return undefined;
  if (!("url" in source) || typeof source.url !== "string") return undefined;
  if (!("offset" in source) || typeof source.offset !== "number") return undefined;
  if (!("line" in source) || typeof source.line !== "number") return undefined;
  if (!("column" in source) || typeof source.column !== "number") return undefined;
  return { text: raw.text, source: { url: source.url, offset: source.offset, line: source.line, column: source.column } };
}

/**
 * The lifetime an attachment entry requested. Present on any entry, media or
 * not, because a mistyped lifetime must be reported instead of passing
 * silently; entries without one stay untouched.
 */
function entryLifetime(entry: unknown): ImageLifetime | undefined {
  if (entry === null || typeof entry !== "object" || !Object.hasOwn(entry, "lifetime")) return undefined;
  return parseImageLifetime((entry as Record<string, unknown>).lifetime);
}

/** The lifetime a direct read chose, recognized by its file result shape. */
function rawLifetime(raw: unknown): ImageLifetime | undefined {
  if (raw === null || typeof raw !== "object" || !("type" in raw) || raw.type !== "file" || !("lifetime" in raw)) return undefined;
  return parseImageLifetime(raw.lifetime);
}

/** Replace file parts with markers, archiving their bytes in part order. */
async function externalizeContent(
  center: ResourceCenter,
  toolName: string,
  converted: Extract<ToolResultOutput, { type: "content" }>,
  items: AttachmentItem[],
): Promise<Extract<ToolResultOutput, { type: "content" }>> {
  const settled = await Promise.all(converted.value.map((part) => externalizePart(center, toolName, part)));
  for (const { item } of settled) if (item !== undefined) items.push(item);
  return { type: "content", value: settled.map(({ part }) => part) };
}

/** One content part: text passes through, a file part becomes a marker. */
async function externalizePart(center: ResourceCenter, toolName: string, part: ContentPart): Promise<{ part: ContentPart; item?: AttachmentItem }> {
  const providerOptions = "providerOptions" in part ? part.providerOptions : undefined;
  const text = (value: string) => ({ type: "text" as const, text: value, ...(providerOptions === undefined ? {} : { providerOptions }) });
  if (part.type !== "file") return { part: text(part.type === "text" ? part.text : JSON.stringify(part)) };
  const data = part.data;
  if (data.type === "text") return { part: text(data.text) };
  if (data.type === "reference") return { part: text(`[provider media reference: ${JSON.stringify(data.reference)}]`) };

  const filename = part.filename;
  let target: string | undefined;
  let reference: Reference;
  if (data.type === "url") {
    // `originalUrl` preserves opaque resource URLs that URL parsing would rewrite.
    target = data.originalUrl ?? (data.url instanceof URL ? data.url.href : String(data.url ?? ""));
    reference = await referenceOf(center, toolName, target, part.mediaType, filename);
  } else {
    const bytes = bytesOf(data.data);
    reference = { url: await archive(center, toolName, bytes, part.mediaType, filename), byteLength: bytes.byteLength };
  }
  if ("reason" in reference) return { part: text(`[unloaded media: ${target}; ${reference.reason}]`) };
  return {
    part: text(`[attachment: ${reference.url}; ${part.mediaType}; ${reference.byteLength} bytes${filename === undefined ? "" : `; ${filename}`}]`),
    item: { url: reference.url, mediaType: part.mediaType, ...(filename === undefined ? {} : { filename }), byteLength: reference.byteLength },
  };
}

/**
 * Normalize a JSON value the way the SDK does (raw Dates and undefined do not
 * survive), then externalize its `attachments` array if it has one.
 */
async function externalizeJson(
  center: ResourceCenter,
  toolName: string,
  converted: TextOrJson,
  items: AttachmentItem[],
  imageInput: boolean,
): Promise<TextOrJson> {
  if (converted.type !== "json") return converted;
  const value: unknown = JSON.parse(JSON.stringify(converted.value) ?? "null");
  const attachments = attachmentEntries(value);
  if (attachments === undefined) return { type: "json", value: value as JSONValue, providerOptions: converted.providerOptions };
  const extracted: unknown[] = [];
  for (const entry of attachments.entries) extracted.push(await externalizeEntry(center, toolName, entry, items, imageInput));
  // The parsed object already holds plain JSON; only the attachments array changes.
  const replaced: unknown = { ...attachments.node, attachments: extracted };
  return { type: "json", value: replaced as JSONValue, providerOptions: converted.providerOptions };
}

/** The parsed object and its `attachments` array, when the value has one. */
function attachmentEntries(value: unknown): { node: Record<string, unknown>; entries: unknown[] } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("attachments" in value)) return undefined;
  if (!Array.isArray(value.attachments)) return undefined;
  // Parsed JSON is a plain object here; entries are still validated one by one in mediaOf.
  const node = value as Record<string, unknown>;
  return { node, entries: value.attachments };
}

/**
 * Archive one attachment entry and return the node with its payload removed.
 * Submitted bytes win over an accompanying URL — a matching source is reused
 * only when its sidecar proves both hash and type agree.
 */
async function externalizeEntry(center: ResourceCenter, toolName: string, entry: unknown, items: AttachmentItem[], imageInput: boolean): Promise<unknown> {
  const lifetime = imageInput ? entryLifetime(entry) : undefined;
  const media = mediaOf(entry);
  if (media === undefined) return entry;

  let url: string;
  let byteLength: number;
  if (media.bytes !== undefined) {
    url = await archive(center, toolName, media.bytes, media.mediaType, media.filename, media.source);
    byteLength = media.bytes.byteLength;
  } else if (media.source !== undefined) {
    const reference = await referenceOf(center, toolName, media.source, media.mediaType, media.filename);
    if ("reason" in reference) {
      // mediaOf already narrowed this parsed JSON entry to a media object.
      const failed = entry as Record<string, unknown>;
      return { ...failed, error: reference.reason };
    }
    url = reference.url;
    byteLength = reference.byteLength;
  } else {
    return entry;
  }

  items.push({
    url,
    mediaType: media.mediaType,
    ...(media.filename === undefined ? {} : { filename: media.filename }),
    byteLength,
    ...(lifetime === undefined ? {} : { lifetime }),
  });
  // The entry was parsed JSON; spreading keeps its ordinary fields readable as-is.
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
 * image or audio block, an embedded MCP resource with a blob or a bare URI.
 * Anything else — including data sitting outside the `attachments` array —
 * is ordinary JSON.
 */
function mediaOf(entry: unknown): Media | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  // Parsed JSON object; every field below is checked before use.
  const node = entry as Record<string, unknown>;
  if (node.type === "file" && typeof node.mediaType === "string") {
    const source = typeof node.url === "string" && node.url.length > 0 ? node.url : undefined;
    const filename = nameOf(node.filename);
    if (typeof node.data === "string" && node.data.length > 0) return { bytes: decodeBase64(node.data), source, mediaType: node.mediaType, filename };
    if (source !== undefined) return { source, mediaType: node.mediaType, filename };
    return undefined;
  }
  if ((node.type === "image" || node.type === "audio") && typeof node.mimeType === "string" && typeof node.data === "string" && node.data.length > 0) {
    return { bytes: decodeBase64(node.data), mediaType: node.mimeType };
  }
  if (node.type === "resource" && node.resource !== null && typeof node.resource === "object") {
    const resource = node.resource as Record<string, unknown>;
    if (typeof resource.mimeType !== "string") return undefined;
    const filename = nameOf(resource.uri);
    if (typeof resource.blob === "string" && resource.blob.length > 0) return { bytes: decodeBase64(resource.blob), mediaType: resource.mimeType, filename };
    if (typeof resource.text !== "string" && typeof resource.uri === "string" && resource.uri.length > 0)
      return { source: resource.uri, mediaType: resource.mimeType, filename };
  }
  return undefined;
}

/**
 * Turn a media URL into a stable reference. An immutable resource is reused
 * as it is; a live one is read now and snapshotted, so a later step cannot
 * see different bytes. A failed read or unusable resource reports why instead
 * of fabricating a reference.
 */
async function referenceOf(center: ResourceCenter, toolName: string, url: string, mediaType: string, filename?: string): Promise<Reference> {
  if (url.length === 0) return { reason: "empty media URL" };
  let payload: ResourcePayload;
  try {
    payload = await center.resolve(url);
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  if (payload.type !== "file") return { reason: "resource is text, not media" };
  if (payload.immutable) return { url: payload.url, byteLength: payload.size };
  return { url: await archive(center, toolName, payload.bytes, mediaType, filename ?? payload.filename), byteLength: payload.bytes.byteLength };
}

/**
 * Store bytes already in hand, reusing `source` when its sidecar still holds
 * the same hash and type. One sha256 of the held bytes plus one sidecar read;
 * the source is never re-fetched and never trusted by URL alone.
 */
async function archive(center: ResourceCenter, toolName: string, bytes: Uint8Array, mediaType: string, filename?: string, source?: string): Promise<string> {
  if (source !== undefined && REUSABLE_SOURCE.test(source)) {
    const existing = await storedMeta(center, source);
    if (existing?.contentHash === createHash("sha256").update(bytes).digest("hex") && existing.mediaType === mediaType) return source;
  }
  return center.store.writeArtifact(toolName, bytes, { mediaType, filename });
}

/** Sidecar hash and type of a store URL, or undefined when it is not one. */
async function storedMeta(center: ResourceCenter, url: string): Promise<{ contentHash?: string; mediaType?: string } | undefined> {
  const base = url.split(/[?#]/, 1)[0]!;
  try {
    const asset = ASSET_URL.exec(base);
    if (asset !== null) return await center.store.getMeta("asset", "", asset[1]!);
    const artifact = ARTIFACT_URL.exec(base);
    if (artifact !== null) return await center.store.getMeta("artifact", artifact[1]!, artifact[2]!);
  } catch {
    // Unreadable sidecar: the held bytes are archived as a new snapshot.
  }
  return undefined;
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
  return Buffer.from(data, "base64");
}

/** A filename safe to surface; URIs and paths are not names. */
function nameOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]+$/.test(value) ? value : undefined;
}
