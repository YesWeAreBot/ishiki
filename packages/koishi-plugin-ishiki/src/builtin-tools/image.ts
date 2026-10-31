import { jsonSchema, tool, type Tool } from "@yesimagent/core";

import type { ResourceCenter } from "../resource/center.js";
import { cropImage, decodeImage, encodeImage, inspectImage, resizeImage, rotateImage, type RasterImage, type RasterMediaType } from "../resource/image.js";

export const IMAGE_TOOL = "image";

export namespace ImageTool {
  export interface Options {
    center: ResourceCenter;
    maxDimension: number;
    imageInput: boolean;
  }

  export interface Input {
    url: string;
    operation: "inspect" | "resize" | "crop" | "rotate" | "convert";
    width?: number;
    height?: number;
    maxDimension?: number;
    x?: number;
    y?: number;
    degrees?: number;
    format?: RasterMediaType;
    quality?: number;
  }

  export interface Attachment {
    type: "file";
    url: string;
    mediaType: RasterMediaType;
    byteLength: number;
    lifetime: "once";
  }

  export interface Output {
    ok: true;
    operation: Input["operation"];
    sourceUrl: string;
    url: string;
    mediaType: string;
    width: number;
    height: number;
    byteLength: number;
    attachments?: Attachment[];
  }
}

function requireInteger(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export function createImage({ center, maxDimension, imageInput }: ImageTool.Options): Tool<ImageTool.Input, ImageTool.Output> {
  return tool({
    description: [
      "Inspect or transform a PNG/JPEG image from an existing resource URL.",
      "Operations: inspect, resize, crop, rotate, convert.",
      "resize only shrinks and preserves aspect ratio; it accepts width, height, or maxDimension.",
      "crop needs x, y, width, and height. rotate accepts 90, 180, or 270 degrees.",
      "convert accepts format image/png or image/jpeg; JPEG uses quality 85 by default and transparent areas are placed on white.",
      "Transformed images are stored as artifacts and returned as attachments. The readable output never contains base64.",
    ].join(" "),
    inputSchema: jsonSchema<ImageTool.Input>({
      type: "object",
      properties: {
        url: { type: "string", description: "Existing asset://, artifact://, local://, or workspace:// image URL." },
        operation: { type: "string", enum: ["inspect", "resize", "crop", "rotate", "convert"] },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        maxDimension: { type: "integer", minimum: 1 },
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        degrees: { type: "integer", enum: [90, 180, 270] },
        format: { type: "string", enum: ["image/png", "image/jpeg"] },
        quality: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["url", "operation"],
      additionalProperties: false,
    }),
    outputSchema: jsonSchema<ImageTool.Output>({
      type: "object",
      properties: {
        ok: { const: true },
        operation: { type: "string" },
        sourceUrl: { type: "string" },
        url: { type: "string" },
        mediaType: { type: "string" },
        width: { type: "integer" },
        height: { type: "integer" },
        byteLength: { type: "integer" },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { const: "file" },
              url: { type: "string" },
              mediaType: { type: "string" },
              byteLength: { type: "integer" },
              lifetime: { type: "string" },
            },
            required: ["type", "url", "mediaType", "byteLength", "lifetime"],
          },
        },
      },
      required: ["ok", "operation", "sourceUrl", "url", "mediaType", "width", "height", "byteLength"],
    }),
    execute: async (input) => {
      const sourceUrl = input.url.trim();
      if (sourceUrl.length === 0) throw new Error("url must not be empty");
      const payload = await center.resolve(sourceUrl);
      if (payload.type !== "file") throw new Error(`${sourceUrl} is text, not an image`);

      if (input.operation === "inspect") {
        const inspected = inspectImage(payload.bytes, payload.mediaType);
        return {
          ok: true,
          operation: input.operation,
          sourceUrl,
          url: sourceUrl,
          mediaType: inspected.mediaType,
          width: inspected.width,
          height: inspected.height,
          byteLength: payload.size,
        };
      }

      let image: RasterImage = decodeImage(payload.bytes, payload.mediaType);
      if (input.operation === "resize") {
        image = resizeImage(image, {
          width: input.width,
          height: input.height,
          maxDimension: input.maxDimension ?? (input.width === undefined && input.height === undefined ? maxDimension : undefined),
        });
      } else if (input.operation === "crop") {
        image = cropImage(
          image,
          requireInteger(input.x, "x"),
          requireInteger(input.y, "y"),
          requireInteger(input.width, "width"),
          requireInteger(input.height, "height"),
        );
      } else if (input.operation === "rotate") {
        image = rotateImage(image, requireInteger(input.degrees, "degrees"));
      }

      const format = input.operation === "convert" ? input.format : undefined;
      if (input.operation === "convert" && format === undefined) throw new Error("convert requires format");
      const encoded = encodeImage(image, format ?? image.mediaType, input.quality ?? 85);
      const artifact = await center.store.writeArtifact(IMAGE_TOOL, encoded.bytes, {
        mediaType: encoded.mediaType,
        filename: encoded.mediaType === "image/png" ? "image.png" : "image.jpg",
      });
      return {
        ok: true,
        operation: input.operation,
        sourceUrl,
        url: artifact,
        mediaType: encoded.mediaType,
        width: encoded.width,
        height: encoded.height,
        byteLength: encoded.bytes.byteLength,
        ...(imageInput
          ? {
              attachments: [
                {
                  type: "file" as const,
                  url: artifact,
                  mediaType: encoded.mediaType,
                  byteLength: encoded.bytes.byteLength,
                  lifetime: "once" as const,
                },
              ],
            }
          : {}),
      };
    },
  });
}
