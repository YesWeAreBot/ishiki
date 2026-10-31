import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";

import { ResourceError } from "./errors.js";
import { imageSize, sniffMediaType } from "./media.js";

export type RasterMediaType = "image/png" | "image/jpeg";

export interface RasterImage {
  width: number;
  height: number;
  data: Buffer;
  mediaType: RasterMediaType;
}

export interface EncodedImage {
  bytes: Buffer;
  mediaType: RasterMediaType;
  width: number;
  height: number;
}

export interface PreparedImage {
  bytes: Buffer;
  mediaType: RasterMediaType | "image/gif" | "image/webp";
  width: number;
  height: number;
  resized: boolean;
}

export interface ResizeBounds {
  width?: number;
  height?: number;
  maxDimension?: number;
}

function rasterType(bytes: Uint8Array, declared?: string): RasterMediaType {
  const mediaType = sniffMediaType(bytes) ?? declared;
  if (mediaType === "image/png" || mediaType === "image/jpeg") return mediaType;
  throw new ResourceError("image_format_unsupported", `supported raster formats are PNG and JPEG, received ${mediaType ?? "unknown"}`);
}

export function decodeImage(bytes: Uint8Array, declared?: string): RasterImage {
  const mediaType = rasterType(bytes, declared);
  try {
    if (mediaType === "image/png") {
      const decoded = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return {
        width: decoded.width,
        height: decoded.height,
        data: Buffer.from(decoded.data),
        mediaType,
      };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return {
      width: decoded.width,
      height: decoded.height,
      data: Buffer.from(decoded.data),
      mediaType,
    };
  } catch (error) {
    throw new ResourceError("image_decode_failed", `${mediaType} decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function targetSize(image: RasterImage, bounds: ResizeBounds): { width: number; height: number } {
  const requested = [bounds.width, bounds.height, bounds.maxDimension].filter((value): value is number => value !== undefined);
  if (requested.length === 0) throw new ResourceError("image_operation_invalid", "resize requires width, height, or maxDimension");
  for (const value of requested) {
    if (!Number.isFinite(value) || value <= 0) throw new ResourceError("image_operation_invalid", "resize dimensions must be positive");
  }

  let scale = 1;
  if (bounds.width !== undefined) scale = Math.min(scale, bounds.width / image.width);
  if (bounds.height !== undefined) scale = Math.min(scale, bounds.height / image.height);
  if (bounds.maxDimension !== undefined) scale = Math.min(scale, bounds.maxDimension / Math.max(image.width, image.height));
  if (scale >= 1) return { width: image.width, height: image.height };
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

export function resizeImage(image: RasterImage, bounds: ResizeBounds): RasterImage {
  const size = targetSize(image, bounds);
  if (size.width === image.width && size.height === image.height) return image;

  const output = Buffer.alloc(size.width * size.height * 4);
  const xScale = image.width / size.width;
  const yScale = image.height / size.height;
  for (let y = 0; y < size.height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < size.width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const at = (y * size.width + x) * 4;
      const topLeft = (y0 * image.width + x0) * 4;
      const topRight = (y0 * image.width + x1) * 4;
      const bottomLeft = (y1 * image.width + x0) * 4;
      const bottomRight = (y1 * image.width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = image.data[topLeft + channel]! * (1 - xWeight) + image.data[topRight + channel]! * xWeight;
        const bottom = image.data[bottomLeft + channel]! * (1 - xWeight) + image.data[bottomRight + channel]! * xWeight;
        output[at + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return { ...image, width: size.width, height: size.height, data: output };
}

export function cropImage(image: RasterImage, x: number, y: number, width: number, height: number): RasterImage {
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width <= 0 || height <= 0)
    throw new ResourceError("image_operation_invalid", "crop coordinates and dimensions must be positive integers");
  if (x + width > image.width || y + height > image.height)
    throw new ResourceError("image_operation_invalid", `crop ${width}x${height} at ${x},${y} exceeds ${image.width}x${image.height}`);

  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = ((y + row) * image.width + x) * 4;
    const target = row * width * 4;
    image.data.copy(data, target, source, source + width * 4);
  }
  return { ...image, width, height, data };
}

export function rotateImage(image: RasterImage, degrees: number): RasterImage {
  if (![90, 180, 270].includes(degrees)) throw new ResourceError("image_operation_invalid", "rotate degrees must be 90, 180, or 270");
  if (degrees === 180) {
    const data = Buffer.alloc(image.data.length);
    const pixels = image.width * image.height;
    for (let index = 0; index < pixels; index += 1) {
      image.data.copy(data, (pixels - 1 - index) * 4, index * 4, index * 4 + 4);
    }
    return { ...image, data };
  }

  const width = image.height;
  const height = image.width;
  const data = Buffer.alloc(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const targetX = degrees === 90 ? image.height - 1 - y : y;
      const targetY = degrees === 90 ? x : image.width - 1 - x;
      image.data.copy(data, (targetY * width + targetX) * 4, (y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
    }
  }
  return { ...image, width, height, data };
}

function flattenOnWhite(image: RasterImage): RasterImage {
  const data = Buffer.alloc(image.data.length);
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = image.data[at + 3]! / 255;
    data[at] = Math.round(image.data[at]! * alpha + 255 * (1 - alpha));
    data[at + 1] = Math.round(image.data[at + 1]! * alpha + 255 * (1 - alpha));
    data[at + 2] = Math.round(image.data[at + 2]! * alpha + 255 * (1 - alpha));
    data[at + 3] = 255;
  }
  return { ...image, data, mediaType: "image/jpeg" };
}

export function encodeImage(image: RasterImage, format: RasterMediaType = image.mediaType, quality = 85): EncodedImage {
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new ResourceError("image_operation_invalid", "JPEG quality must be between 1 and 100");
  if (format === "image/png") {
    const png = new PNG({ width: image.width, height: image.height });
    image.data.copy(png.data);
    return { bytes: PNG.sync.write(png), mediaType: format, width: image.width, height: image.height };
  }
  const opaque = image.data.some((value, index) => index % 4 === 3 && value !== 255) ? flattenOnWhite(image) : image;
  const encoded = jpeg.encode({ width: opaque.width, height: opaque.height, data: opaque.data }, quality);
  return { bytes: encoded.data, mediaType: format, width: image.width, height: image.height };
}

export function inspectImage(bytes: Uint8Array, declared?: string): EncodedImage {
  const mediaType = rasterType(bytes, declared);
  const size = imageSize(bytes);
  if (size.width === undefined || size.height === undefined) throw new ResourceError("image_decode_failed", `cannot read ${mediaType} dimensions`);
  return {
    bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mediaType,
    width: size.width,
    height: size.height,
  };
}

export function prepareImageForModel(bytes: Uint8Array, mediaType: string, maxDimension: number): PreparedImage {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) throw new ResourceError("image_operation_invalid", "maxDimension must be positive");
  const detected = sniffMediaType(bytes) ?? mediaType;
  if (detected === "image/gif" || detected === "image/webp") {
    const size = imageSize(bytes);
    if (Math.max(size.width ?? 0, size.height ?? 0) > maxDimension)
      throw new ResourceError("image_format_unsupported", `${detected} cannot be downsampled; use PNG or JPEG`);
    return {
      bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mediaType: detected,
      width: size.width ?? 0,
      height: size.height ?? 0,
      resized: false,
    };
  }

  const type = rasterType(bytes, detected);
  const initial = imageSize(bytes);
  if (initial.width !== undefined && initial.height !== undefined && Math.max(initial.width, initial.height) <= maxDimension) {
    return {
      bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mediaType: type,
      width: initial.width,
      height: initial.height,
      resized: false,
    };
  }
  const decoded = decodeImage(bytes, type);
  const resized = resizeImage(decoded, { maxDimension });
  return { ...encodeImage(resized), resized: resized.width !== decoded.width || resized.height !== decoded.height };
}
