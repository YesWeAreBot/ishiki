import { createHash } from "node:crypto";

import type { ToolResultOutput } from "@yesimagent/core";

import type { ReadResult } from "../builtin-tools/read.js";
import type { ResourceCenter } from "../resources/center.js";
import { decodeDataUrl } from "../resources/store.js";
import { pageDescription, textPage } from "../resources/text.js";
import type { AttachmentItem } from "../types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Inspect dimensions without decoding, resizing or changing image bytes. */
export function imageSize(bytes: Uint8Array): { width?: number; height?: number } {
  const data = Buffer.from(bytes);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length && data[at] === 0xff) {
      const marker = data[at + 1]!;
      const length = data.readUInt16BE(at + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      if (length < 2) break;
      at += 2 + length;
    }
  }
  if (data.length >= 30 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") {
    const encoding = data.subarray(12, 16).toString();
    if (encoding === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (encoding === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (encoding === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return {};
}

/** Explicit media nodes only. Ordinary JSON data fields and strings are never interpreted as images. */
export async function processOutput(
  center: ResourceCenter,
  toolName: string,
  toolCallId: string,
  original: unknown,
  converted: ToolResultOutput,
): Promise<{ output: ToolResultOutput; items: AttachmentItem[] }> {
  if (converted.type === "error-text" || converted.type === "error-json" || converted.type === "execution-denied") return { output: converted, items: [] };
  const items: AttachmentItem[] = [];
  const originalRead = record(original)?.type === "ishiki.read" ? (original as ReadResult) : undefined;
  const addMedia = async (node: Record<string, unknown>, mediaType: string, data: unknown, source?: string): Promise<string> => {
    const tagged = record(data);
    if (tagged?.type === "reference") return `[unloaded ${mediaType}: ${String(tagged.reference ?? "unknown")}]`;
    if (tagged?.type === "url") {
      const url = String(tagged.url ?? "");
      if (/^(asset|artifact|local):\/\//.test(url)) source = url;
      else return `[unloaded ${mediaType}: ${url}]`;
    }
    if (tagged?.type === "text") return String(tagged.text ?? "");
    const encoded = tagged?.data ?? (tagged?.type === "url" ? undefined : data);
    let bytes: Uint8Array;
    if (encoded === undefined && source) {
      const resource = await center.resolve(source);
      if (!resource.bytes) throw new Error(`Media source is not binary: ${source}`);
      bytes = resource.bytes;
    } else if (encoded instanceof Uint8Array) bytes = encoded;
    else if (encoded instanceof ArrayBuffer) bytes = new Uint8Array(encoded);
    else if (typeof encoded === "string" && encoded.startsWith("data:")) bytes = decodeDataUrl(encoded);
    else if (typeof encoded === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && encoded.length % 4 !== 1) bytes = Buffer.from(encoded, "base64");
    else throw new Error(`Invalid ${mediaType} media data from ${toolName}`);
    let url: string | undefined;
    if (source && /^(asset|artifact):\/\//.test(source)) {
      try {
        const existing = await center.resolve(source);
        if (
          existing.bytes &&
          createHash("sha256").update(existing.bytes).digest("hex") === createHash("sha256").update(bytes).digest("hex") &&
          existing.mediaType === mediaType
        )
          url = source;
      } catch {
        // Stale provenance cannot prevent archival of bytes that are already in hand.
      }
    }
    const dimensions = mediaType.startsWith("image/") ? imageSize(bytes) : {};
    const filename = typeof node.filename === "string" ? node.filename : undefined;
    url ??= await center.store.writeArtifact(toolName, bytes, { mediaType, filename, toolCallId, ...dimensions });
    items.push({ url, mediaType, filename, byteLength: bytes.byteLength, ...dimensions });
    return `[attachment: ${url}; ${mediaType}; ${bytes.byteLength} bytes]`;
  };
  const visit = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const entry of value) result.push(await visit(entry));
      return result;
    }
    const node = record(value);
    if (!node) return value;
    if (node.type === "ishiki.read") {
      if (node.kind === "text") return node.text;
      if (node.kind === "file" && typeof node.mediaType === "string")
        return addMedia(node, node.mediaType, node.data, typeof node.url === "string" ? node.url : undefined);
    }
    if (node.type === "content" && Array.isArray(node.value)) return visit(node.value);
    if (
      ["image", "audio", "video", "file", "media", "image-data", "file-data"].includes(String(node.type)) &&
      typeof (node.mediaType ?? node.mimeType) === "string"
    ) {
      return addMedia(node, String(node.mediaType ?? node.mimeType), node.data, typeof node.url === "string" ? node.url : originalRead?.url);
    }
    if (node.type === "resource" && record(node.resource)) {
      const resource = record(node.resource)!;
      if (typeof resource.blob === "string") return addMedia(resource, String(resource.mimeType ?? "application/octet-stream"), resource.blob);
      if (typeof resource.text === "string") return resource.text;
    }
    if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) return value;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(node)) result[key] = await visit(entry);
    return result;
  };
  const jsonRead = record(converted.value)?.type === "ishiki.read" ? (converted.value as unknown as ReadResult) : undefined;
  const read = originalRead ?? jsonRead;
  const isBlock = (value: unknown): boolean => ["text", "image", "audio", "video", "file", "resource", "resource_link"].includes(String(record(value)?.type));
  const content =
    converted.type === "content" ||
    record(converted.value)?.type === "content" ||
    (Array.isArray(converted.value) && converted.value.length > 0 && converted.value.every(isBlock));
  const transformed = await visit(jsonRead ?? converted.value);
  let output: ToolResultOutput;
  if (converted.type === "content") {
    output = { type: "content", value: (transformed as unknown[]).map((part) => (typeof part === "string" ? { type: "text", text: part } : (part as never))) };
  } else if (content) {
    output = {
      type: "text",
      value: (transformed as unknown[])
        .map((part) => (typeof part === "string" ? part : record(part)?.type === "text" ? String(record(part)!.text) : JSON.stringify(part, null, 2)))
        .join("\n"),
    };
  } else if (jsonRead) output = { type: "text", value: String(transformed) };
  else output = { ...converted, value: transformed } as ToolResultOutput;
  if (output.type === "json") {
    const serialized = JSON.stringify(output.value);
    output = { ...output, value: serialized === undefined ? null : JSON.parse(serialized) };
  }
  // Unmodified read pages already have a source and precise continuation. Do not create a read artifact chain.
  if (read?.kind === "text" && read.page && read.text === pageDescription(read.page, read.url, read.end)) return { output, items };
  const readable =
    output.type === "text"
      ? output.value
      : output.type === "json"
        ? JSON.stringify(output.value, null, 2)
        : output.type === "content"
          ? output.value.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n")
          : "";
  const page = await textPage(readable);
  if (page.nextOffset !== undefined) {
    const raw = typeof original === "string" ? original : (JSON.stringify(original) ?? "null");
    const url = await center.store.writeArtifact(
      toolName,
      Buffer.from(raw, "utf8"),
      { mediaType: typeof original === "string" ? "text/plain" : "application/json", toolCallId },
      typeof original === "string" && readable === original ? undefined : readable,
    );
    output = { type: "text", value: pageDescription(page, url), ...("providerOptions" in converted ? { providerOptions: converted.providerOptions } : {}) };
  }
  return { output, items };
}
