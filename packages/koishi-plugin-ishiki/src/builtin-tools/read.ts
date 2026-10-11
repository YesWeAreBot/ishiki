import { jsonSchema, tool, type Tool, type ToolResultOutput } from "@yesimagent/core";

import type { ResourceCenter } from "../resources/center.js";
import { concreteMediaType } from "../resources/media.js";
import { splitSelectors } from "../resources/selectors.js";
import { describeTruncation, readBudget, selectLines, truncate } from "../resources/text.js";

export const READ_TOOL = "read";

/** A file payload: the whole `type: 'file'` node an attachment array accepts verbatim. */
export interface ReadFile {
  type: "file";
  url: string;
  mediaType: string;
  data: string;
  byteLength: number;
  filename?: string;
}

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
  }
  export interface Input {
    url: string;
  }
  /** Full text of the requested line range, or the complete file node. */
  export type Output = string | ReadFile;
}

/**
 * The read tool. `execute` returns the raw payload — full text of the
 * requested line range, or the file node with base64 data — so codemode can
 * keep processing it. Truncation happens in `toModelOutput`, whose anchor
 * points at the source URL; the unified wrapper then finds the result inside
 * the shared budget and never archives a read page twice.
 */
export function createReadTool({ center }: ReadTool.Options): Tool<ReadTool.Input, ReadTool.Output> {
  const accepts = (scheme: string): boolean => center.acceptsSelectors(scheme);
  return tool({
    description:
      "Read an existing resource by asset://<id>, artifact://<tool>/<name>, local://<path> or extension URL. Text returns the full content of the requested line range (:1-200 or :50+30 selects lines; whole reads are size-capped); binary files return {type:'file', url, mediaType, data(base64), byteLength, filename?}. Inside codemode, pass the file node into another tool, or return it inside the attachment array to carry the media to your next step. ?view=meta probes metadata without fetching bytes. Direct calls show at most 2000 lines / 30000 characters of text with a Continue anchor; images become attachments automatically — inspect the attachment before reading the same image again. Reading cannot bypass model modality or image quotas.",
    inputSchema: jsonSchema<ReadTool.Input>({ type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
    outputSchema: jsonSchema<ReadTool.Output>({
      oneOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            type: { const: "file" },
            url: { type: "string" },
            mediaType: { type: "string" },
            data: { type: "string", description: "Base64 bytes" },
            byteLength: { type: "number" },
            filename: { type: "string" },
          },
          required: ["type", "url", "mediaType", "data", "byteLength"],
        },
      ],
    }),
    toModelOutput: ({ input, output }): ToolResultOutput => {
      if (typeof output === "string") {
        // The selector in the request gives the slice its absolute line numbers,
        // so a truncated slice anchors past its own head instead of looping.
        const { url, range } = splitSelectors(input.url.trim(), accepts);
        const cut = truncate(output, { startLine: range?.start ?? 1, ...readBudget() });
        return { type: "text", value: cut === undefined ? output : describeTruncation(cut, url) };
      }
      return {
        type: "content",
        value: [
          {
            type: "file",
            mediaType: output.mediaType,
            ...(output.filename === undefined ? {} : { filename: output.filename }),
            // `URL` with originalUrl preserves non-HTTP resource schemes verbatim.
            data: { type: "url", url: new URL(output.url), originalUrl: output.url },
          },
        ],
      };
    },
    execute: async (input) => {
      const { url, range } = splitSelectors(input.url.trim(), accepts);
      // Fast path: stream the requested lines from disk for file-backed schemes.
      const streamed = await center.readTextLines(url, range ?? {});
      if (streamed !== undefined) return streamed;
      const payload = await center.resolve(url);
      if (payload.bytes !== undefined) {
        return {
          type: "file",
          url,
          mediaType: concreteMediaType(payload.mediaType, payload.bytes) ?? "application/octet-stream",
          data: Buffer.from(payload.bytes).toString("base64"),
          byteLength: payload.bytes.byteLength,
          ...(payload.filename === undefined ? {} : { filename: payload.filename }),
        } satisfies ReadFile;
      }
      return selectLines(payload.content ?? "", range ?? {});
    },
  });
}
