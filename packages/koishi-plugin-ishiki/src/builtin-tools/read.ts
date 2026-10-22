import { jsonSchema, tool, type Tool, type ToolResultOutput } from "@yesimagent/core";

import type { ResourceCenter, ResourceText } from "../resource/center.js";
import { ResourceError } from "../resource/errors.js";
import { IMAGE_LIFETIMES, parseImageLifetime } from "../resource/lifetime.js";
import { renderTextPage, TEXT_BUDGET } from "../resource/text.js";
import type { ImageLifetime } from "../types.js";

export const READ_TOOL = "read";

export interface ReadFile {
  type: "file";
  url: string;
  mediaType: string;
  data: string;
  byteLength: number;
  filename?: string;
  immutable: boolean;
  /** Chosen attachment lifetime; only set when the call site allows choosing one. */
  lifetime?: ImageLifetime;
}

export namespace ReadTool {
  export interface Options {
    center: ResourceCenter;
    /**
     * Whether a read may choose an attachment lifetime. Direct reads opt in
     * only when image input is enabled and codemode is off: with codemode the
     * lifetime belongs on the final `attachments` entry, and without image
     * input nothing is ever supplied.
     */
    lifetime?: boolean;
  }
  export interface Input {
    url: string;
    /** Media only; ignored for text results. */
    lifetime?: ImageLifetime;
  }
  export type Output = ResourceText | ReadFile;
}

/** Raw structured data in code; source-aware pages and media only at model conversion. */
export function createReadTool({ center, lifetime = false }: ReadTool.Options): Tool<ReadTool.Input, ReadTool.Output> {
  const description = [
    "Read an existing resource URL.",
    "Text results contain {type:'text',text,url,size,source?}; media results contain {type:'file',url,mediaType,data(base64),byteLength,immutable,filename?}.",
    "File schemes support :N, :N-M, :N+M and ?view=meta; use the exact Continue URL for later pages.",
    `Model-visible text is limited to ${TEXT_BUDGET.maxLines} lines / ${TEXT_BUDGET.maxChars} characters.`,
    "Ordinary oversized results are saved as artifact snapshots; file pages retain their source.",
    "Media cannot bypass model capabilities or quotas.",
    ...(lifetime
      ? [
          "A media read accepts lifetime ('once' default, 'recent', 'retain') to choose how long that attachment keeps being supplied; the result echoes the choice.",
        ]
      : []),
  ].join(" ");
  return tool({
    description,
    inputSchema: jsonSchema<ReadTool.Input>({
      type: "object",
      properties: {
        url: { type: "string" },
        ...(lifetime
          ? { lifetime: { type: "string", enum: [...IMAGE_LIFETIMES], description: "Attachment lifetime for a media read; applies only to media results." } }
          : {}),
      },
      required: ["url"],
    }),
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
            ...(lifetime ? { lifetime: { type: "string", enum: [...IMAGE_LIFETIMES] } } : {}),
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
    execute: async ({ url, lifetime: requested }) => {
      const attachmentLifetime = parseImageLifetime(requested);
      if (attachmentLifetime !== undefined && !lifetime)
        throw new ResourceError("invalid_attachment_lifetime", "attachment lifetimes are unavailable at this call site; the attachment is supplied once");
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
        ...(attachmentLifetime === undefined ? {} : { lifetime: attachmentLifetime }),
      };
    },
  });
}
