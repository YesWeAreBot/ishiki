import { jsonSchema, tool, type Tool, type ToolResultOutput } from "@yesimagent/core";

import { type ResourceCenter, type ResourcePayload } from "../resources/center.js";
import { concreteMediaType } from "../resources/media.js";
import { splitSelectors, type Selector } from "../resources/selectors.js";

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
    /**
     * When false (default), images resolve to a text description instead of
     * file parts — the single multimodal degradation point for the pipeline.
     */
    imageInput: boolean;
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

function textParts(payload: ResourcePayload, selectors: readonly Selector[]): ToolResultOutput {
  let text = payload.content ?? "";
  for (const selector of selectors) {
    if (selector.kind === "lines") text = applyLineSlice(text, selector);
  }
  return { type: "text", value: text };
}

export function createReadTool(options: ReadTool.Options): Tool<ReadTool.Input, ToolResultOutput> {
  const { center, imageInput } = options;

  return tool({
    description:
      "Read a resource by URL: asset://<id> (channel media), artifact://<tool>/<name> (tool output), local://<path> (runtime home), or any scheme listed in your instructions. " +
      "Append selectors to slice text: :1-200 (line range), :50+30 (50 plus 30 lines), :raw (verbatim). Add ?view=meta for a no-download metadata probe.",
    inputSchema: jsonSchema<ReadTool.Input>({
      type: "object",
      properties: {
        url: { type: "string", description: "resource URL, optionally with a :selector suffix" },
      },
      required: ["url"],
    }),
    execute: async (input) => {
      const { url, selectors } = splitSelectors(input.url.trim(), (scheme) => center.acceptsSelectors(scheme));
      const payload = await center.resolve(url);

      if (payload.bytes !== undefined) {
        const mediaType = concreteMediaType(payload.mediaType, payload.bytes);
        if (mediaType?.startsWith("image/")) {
          if (imageInput) {
            return { type: "content", value: [{ type: "file", mediaType, filename: payload.filename, data: { type: "data", data: payload.bytes } }] };
          }
          return { type: "text", value: imageFallbackText(url, mediaType, payload.size) };
        }
        return { type: "text", value: `${url}: binary ${mediaType ?? "data"}, ${payload.size} bytes` };
      }

      return textParts(payload, selectors);
    },
  });
}
