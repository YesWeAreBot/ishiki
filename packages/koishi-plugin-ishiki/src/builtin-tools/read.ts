import { jsonSchema, tool, type Tool } from "@yesimagent/core";

import type { ResourceCenter } from "../resources/center.js";
import { concreteMediaType } from "../resources/media.js";
import { splitSelectors } from "../resources/selectors.js";
import { pageDescription, textPage, type TextPage } from "../resources/text.js";

export const READ_TOOL = "read";

/** JSON-safe values remain usable inside codemode regardless of model modality. */
export type ReadResult =
  | { type: "ishiki.read"; kind: "text"; url: string; text: string; page: TextPage; end?: number }
  | { type: "ishiki.read"; kind: "file"; url: string; mediaType: string; data: string; byteLength: number; filename?: string };

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
  }
  export interface Input {
    url: string;
  }
}

export function createReadTool({ center }: ReadTool.Options): Tool<ReadTool.Input, ReadResult> {
  return tool({
    description:
      "Read asset://<id>, artifact://<tool>/<name>, local://<path> or extension resources. Text pages contain at most 2000 lines / 30000 characters. Use :1-200 or :50+30 for lines, #offset=N for character continuation, ?view=meta for metadata, artifact ?view=original for original JSON. File data is base64; preserve structured results when returning from codemode.",
    inputSchema: jsonSchema<ReadTool.Input>({ type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
    outputSchema: jsonSchema<ReadResult>({
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "ishiki.read" },
            kind: { const: "text" },
            url: { type: "string" },
            text: { type: "string" },
            end: { type: "number" },
            page: {
              type: "object",
              properties: Object.fromEntries(
                ["text", "totalLines", "totalChars", "startLine", "endLine", "offset", "nextOffset"].map((key) => [
                  key,
                  { type: key === "text" ? "string" : "number" },
                ]),
              ),
              required: ["text", "totalLines", "totalChars", "startLine", "endLine", "offset"],
            },
          },
          required: ["type", "kind", "url", "text", "page"],
        },
        {
          type: "object",
          properties: {
            type: { const: "ishiki.read" },
            kind: { const: "file" },
            url: { type: "string" },
            mediaType: { type: "string" },
            data: { type: "string", description: "Base64 bytes" },
            byteLength: { type: "number" },
            filename: { type: "string" },
          },
          required: ["type", "kind", "url", "mediaType", "data", "byteLength"],
        },
      ],
    }),
    toModelOutput: ({ output }) =>
      output.kind === "text"
        ? { type: "text", value: output.text }
        : { type: "content", value: [{ type: "file", mediaType: output.mediaType, filename: output.filename, data: { type: "data", data: output.data } }] },
    execute: async (input) => {
      const { url, selectors } = splitSelectors(input.url.trim(), (scheme) => center.acceptsSelectors(scheme));
      const range: { start?: number; end?: number; offset?: number } = {};
      for (const selector of selectors) {
        if (selector.kind === "offset") {
          range.offset = selector.offset;
          range.end = selector.end;
        } else {
          const base = range.start ?? 1;
          range.start = base + selector.start - 1;
          range.end = Math.min(range.end ?? Infinity, selector.end === undefined ? Infinity : base + selector.end - 1);
          if (range.end === Infinity) range.end = undefined;
        }
      }
      let page = await center.readTextPage(url, range);
      if (!page) {
        const payload = await center.resolve(url);
        if (payload.bytes !== undefined)
          return {
            type: "ishiki.read",
            kind: "file",
            url,
            mediaType: concreteMediaType(payload.mediaType, payload.bytes) ?? "application/octet-stream",
            data: Buffer.from(payload.bytes).toString("base64"),
            byteLength: payload.bytes.byteLength,
            filename: payload.filename,
          };
        page = await textPage(payload.content ?? "", range);
      }
      return { type: "ishiki.read", kind: "text", url, text: pageDescription(page, url, range.end), page, end: range.end };
    },
  });
}
