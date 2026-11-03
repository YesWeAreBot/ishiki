import { createUserMessage, generateText, jsonSchema, tool, type Tool, type ToolResultOutput } from "@yesimagent/core";

import type { ResourceCenter, ResourceText } from "../resource/center.js";
import { ResourceError } from "../resource/errors.js";
import { IMAGE_LIFETIMES, parseImageLifetime } from "../resource/lifetime.js";
import { renderTextPage, TEXT_BUDGET } from "../resource/text.js";
import type { ImageLifetime } from "../types/messages.js";

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
    /** Independent image-capable model used only when the URL has a non-empty question. */
    visionModel?: Parameters<typeof generateText>[0]["model"];
  }
  export interface Input {
    url: string;
    /** Media only; ignored for text results. */
    lifetime?: ImageLifetime;
  }
  export type Output = ResourceText | ReadFile;
}

/** Raw structured data in code; source-aware pages and media only at model conversion. */
export function createReadTool({ center, lifetime = false, visionModel }: ReadTool.Options): Tool<ReadTool.Input, ReadTool.Output> {
  const description = [
    "Read an existing resource URL.",
    "Text results contain {type:'text',text,url,size,source?}; media results contain {type:'file',url,mediaType,data(base64),byteLength,immutable,filename?}.",
    "File schemes support :N, :N-M, :N+M and ?view=meta; use the exact Continue URL for later pages.",
    "For an image, add a non-empty question query parameter to ask the configured vision model and receive text: read({url:'asset://<uuid>?question=...'}). This recognition call uses the visual model independently of the main model's image-input support and does not attach the original image to the main conversation.",
    "An empty question is an error. Other query parameters remain part of the resource URL; question is consumed only by this tool.",
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
      const parsed = parseReadTarget(url);
      if (parsed.question !== undefined) {
        if (visionModel === undefined)
          throw new ResourceError("vision_model_not_configured", "image recognition requires attachment.visionModel in the profile");
        const payload = await center.resolve(parsed.url);
        if (payload.type !== "file" || !payload.mediaType.startsWith("image/"))
          throw new ResourceError("vision_media_unsupported", `image recognition requires an image resource, received ${payload.mediaType ?? "text"}`);
        let recognized: string;
        try {
          const generated = await generateText({
            model: visionModel,
            messages: [
              createUserMessage([
                { type: "text", text: parsed.question },
                { type: "file", data: payload.bytes, mediaType: payload.mediaType },
              ]),
            ],
          });
          recognized = generated.text.trim();
        } catch (error) {
          throw new ResourceError("vision_request_failed", `vision request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (recognized.length === 0) throw new ResourceError("vision_request_failed", "vision model returned an empty result");
        return {
          type: "text",
          url: parsed.url,
          text: recognized,
          size: Buffer.byteLength(recognized),
          mediaType: "text/plain",
        };
      }
      const payload = await center.resolve(parsed.url);
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

function parseReadTarget(input: string): { url: string; question?: string } {
  const trimmed = input.trim();
  const queryAt = trimmed.indexOf("?");
  if (queryAt === -1) return { url: trimmed };
  const fragmentAt = trimmed.indexOf("#", queryAt + 1);
  const queryEnd = fragmentAt === -1 ? trimmed.length : fragmentAt;
  const search = new URLSearchParams(trimmed.slice(queryAt + 1, queryEnd));
  if (!search.has("question")) return { url: trimmed };
  const values = search.getAll("question");
  if (values.length !== 1) throw new ResourceError("vision_question_empty", "exactly one non-empty question is required");
  search.delete("question");
  const question = values[0]!.trim();
  if (question.length === 0) throw new ResourceError("vision_question_empty", "image recognition requires a non-empty question");
  const cleaned = `${trimmed.slice(0, queryAt)}${search.size === 0 ? "" : `?${search}`}${fragmentAt === -1 ? "" : trimmed.slice(fragmentAt)}`;
  return { url: cleaned, question };
}
