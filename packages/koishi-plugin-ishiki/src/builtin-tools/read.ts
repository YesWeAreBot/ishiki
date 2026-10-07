import { jsonSchema, tool, type JSONValue, type Tool, type ToolResultOutput } from "@yesimagent/core";

import type { ResourcePayload } from "../resources/center.js";
import { ResourceCenter, ResourceError } from "../resources/center.js";
import { AssetHandler } from "../resources/handlers.js";
import { splitSelectors, type Selector } from "../resources/selectors.js";

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
    /**
     * When false (default), images resolve to a metadata card instead of file
     * parts — the single multimodal degradation point for the whole pipeline.
     */
    imageInput: boolean;
    /** Asset byte-level reader; wired to the same AssetHandler the center holds. */
    assetReader: Pick<AssetHandler, "readBytes" | "getRecord">;
  }
  export interface Input {
    url: string;
  }
}

const MAX_LINES_OUTPUT = 2000;

/** Text returned for an image when the model cannot see images (modality off). */
function imageFallbackText(url: string, mediaType: string, byteLength: number): string {
  const size = byteLength >= 1024 ? `${(byteLength / 1024).toFixed(1)} KiB` : `${byteLength} B`;
  return `${url}: ${mediaType} image, ${size}. This model cannot view images directly.`;
}

function applyLineSlice(text: string, selector: Selector & { kind: "lines" }): string {
  const lines = text.split("\n");
  const start = Math.max(selector.start, 1);
  const end = Math.min(selector.end ?? lines.length, lines.length);
  const sliced = lines.slice(start - 1, end);
  const gutterWidth = String(end).length;
  const body = sliced.map((line, index) => `${String(start + index).padStart(gutterWidth)}| ${line}`).join("\n");
  if (lines.length > MAX_LINES_OUTPUT && selector.end === undefined) {
    return `${body}\n[truncated: showing lines ${start}-${end} of ${lines.length}; continue with :N+2000]`;
  }
  return body;
}

function extractPath(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      throw new ResourceError("resource_not_found", `path ".${segments.join(".")}" hits ${String(current)} at "${segment}"`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new ResourceError("resource_not_found", `array index out of range at "${segment}" in .${segments.join(".")}`);
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object") {
      throw new ResourceError("resource_not_found", `cannot descend into ${typeof current} at "${segment}" in .${segments.join(".")}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function textParts(payload: ResourcePayload, selectors: readonly Selector[]): ToolResultOutput {
  let text = payload.content ?? "";
  for (const selector of selectors) {
    if (selector.kind === "lines") {
      text = applyLineSlice(text, selector);
    } else if (selector.kind === "raw") {
      continue;
    } else {
      const parsed: unknown = JSON.parse(text);
      const extracted = extractPath(parsed, selector.segments);
      return { type: "json", value: extracted as JSONValue };
    }
  }
  return { type: "text", value: text };
}

export function createReadTool(options: ReadTool.Options): Tool<ReadTool.Input, ToolResultOutput> {
  const { center, imageInput, assetReader } = options;

  return tool({
    description:
      "Read a resource by URL: asset://<id> (channel media), artifact://<tool>/<name> (tool output), local://<path> (runtime home), or any scheme listed in your instructions. " +
      "Append selectors to slice: :1-200 (line range), :50+30 (50 plus 30 lines), :raw (verbatim), or .a.b.0 (JSON dot path).",
    inputSchema: jsonSchema<ReadTool.Input>({
      type: "object",
      properties: {
        url: { type: "string", description: "resource URL, optionally with a :selector suffix" },
      },
      required: ["url"],
    }),
    execute: async (input) => {
      const { url, selectors } = splitSelectors(input.url.trim());
      const parsed = ResourceCenter.parse(url);

      // Asset images need the actual bytes to decide between a file part and
      // the modality fallback text — the resolve-level card is not enough.
      if (parsed.scheme === "asset") {
        const record = await assetReader.getRecord(parsed.authority);
        if (record === undefined) throw new ResourceError("resource_not_found", `asset not found: ${url}`);
        const isImage = (record.mediaType ?? "").startsWith("image/");
        if (isImage) {
          const bytes = await assetReader.readBytes(parsed.authority);
          if (imageInput) {
            return {
              type: "content",
              value: [{ type: "file", mediaType: record.mediaType!, filename: record.filename, data: { type: "data", data: bytes } }],
            };
          }
          return { type: "text", value: imageFallbackText(url, record.mediaType!, bytes.byteLength) };
        }
        const payload = await center.resolve(url);
        return { type: "text", value: payload.content ?? url };
      }

      const payload = await center.resolve(url);
      if (payload.bytes !== undefined) {
        return { type: "text", value: `${url}: binary ${payload.mediaType ?? "data"}, ${payload.size} bytes` };
      }

      return textParts(payload, selectors);
    },
  });
}
