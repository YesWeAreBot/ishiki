import { jsonSchema, tool, type Tool, type ToolResultOutput } from "@yesimagent/core";

import type { ResourceCenter, ResourceText } from "../resources/center.js";
import { renderTextPage, TEXT_BUDGET } from "../resources/text.js";

export const READ_TOOL = "read";

export interface ReadFile {
  type: "file";
  url: string;
  mediaType: string;
  data: string;
  byteLength: number;
  filename?: string;
  immutable: boolean;
}

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
  }
  export interface Input {
    url: string;
  }
  export type Output = ResourceText | ReadFile;
}

/** Raw structured data in code; source-aware pages and media only at model conversion. */
export function createReadTool({ center }: ReadTool.Options): Tool<ReadTool.Input, ReadTool.Output> {
  return tool({
    description: `Read an existing resource URL. Inside codemode, text results contain {type:'text',text,url,size,source?}; file results contain {type:'file',data(base64),mediaType,url,byteLength,filename?,immutable}. Pass text or media data to another tool according to its input schema, or include media in the final attachments array. File schemes support :N, :N-M, :N+M and ?view=meta; use the exact Continue URL for later pages. Model-visible text is limited to ${TEXT_BUDGET.maxLines} lines / ${TEXT_BUDGET.maxChars} characters. Ordinary oversized results are saved as artifact snapshots; file pages retain their source. Media cannot bypass model capabilities or quotas.`,
    inputSchema: jsonSchema<ReadTool.Input>({ type: "object", properties: { url: { type: "string" } }, required: ["url"] }),
    outputSchema: jsonSchema<ReadTool.Output>({
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "text" },
            url: { type: "string" },
            text: { type: "string" },
            size: { type: "number" },
            mediaType: { type: "string" },
            filename: { type: "string" },
            source: {
              type: "object",
              properties: {
                url: { type: "string" },
                offset: { type: "integer", minimum: 0 },
                line: { type: "integer", minimum: 1 },
                column: { type: "integer", minimum: 1 },
              },
              required: ["url", "offset", "line", "column"],
            },
          },
          required: ["type", "url", "text", "size"],
        },
        {
          type: "object",
          properties: {
            type: { const: "file" },
            url: { type: "string" },
            mediaType: { type: "string" },
            data: { type: "string", description: "Base64 media bytes" },
            byteLength: { type: "number" },
            filename: { type: "string" },
            immutable: { type: "boolean" },
          },
          required: ["type", "url", "mediaType", "data", "byteLength", "immutable"],
        },
      ],
    }),
    toModelOutput: ({ output }): ToolResultOutput => {
      if (output.type === "text") return { type: "text", value: output.source === undefined ? output.text : renderTextPage(output.text, output.source) };
      return {
        type: "content",
        value: [
          {
            type: "file",
            mediaType: output.mediaType,
            ...(output.filename === undefined ? {} : { filename: output.filename }),
            data: output.immutable ? { type: "url", url: new URL(output.url), originalUrl: output.url } : { type: "data", data: output.data },
          },
        ],
      };
    },
    execute: async ({ url }) => {
      const payload = await center.resolve(url.trim());
      if (payload.type === "text") return payload;
      return {
        type: "file",
        url: payload.url,
        mediaType: payload.mediaType,
        data: Buffer.from(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength).toString("base64"),
        byteLength: payload.size,
        immutable: payload.immutable,
        ...(payload.filename === undefined ? {} : { filename: payload.filename }),
      };
    },
  });
}
