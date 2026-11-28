import crypto from "node:crypto";

import { imageSize, sniffMediaType } from "koishi-plugin-ishiki";

export type SupportedStickerMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const MIME_TO_EXT: Record<SupportedStickerMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, SupportedStickerMime> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface CandidateImageInfo {
  sha256: string;
  mime: SupportedStickerMime;
  ext: string;
  size: number;
  width: number;
  height: number;
}

export type ValidationResult = { ok: true; info: CandidateImageInfo } | { ok: false; code: string; reason: string };

export function detectStickerMime(bytes: Uint8Array): SupportedStickerMime | undefined {
  const sniffed = sniffMediaType(bytes);
  if (sniffed === "image/png" || sniffed === "image/jpeg" || sniffed === "image/gif" || sniffed === "image/webp") {
    return sniffed;
  }
  return undefined;
}

export function extForMime(mime: SupportedStickerMime): string {
  return MIME_TO_EXT[mime];
}

export function mimeForFilename(filename: string): SupportedStickerMime | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXT_TO_MIME[filename.slice(dot).toLowerCase()];
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function validateCandidateBytes(
  bytes: Uint8Array,
  options: {
    maxFileBytes: number;
    maxAspectRatio: number;
    minDimension?: number;
  },
): ValidationResult {
  if (bytes.byteLength === 0) {
    return { ok: false, code: "empty_file", reason: "图片内容为空" };
  }
  if (bytes.byteLength > options.maxFileBytes) {
    return {
      ok: false,
      code: "file_too_large",
      reason: `图片体积 ${(bytes.byteLength / (1024 * 1024)).toFixed(2)} MiB 超过上限`,
    };
  }

  const mime = detectStickerMime(bytes);
  if (!mime) {
    return { ok: false, code: "unsupported_media", reason: "仅支持 PNG、JPEG、GIF 或 WebP 图片" };
  }

  const dims = imageSize(bytes);
  const width = dims.width ?? 0;
  const height = dims.height ?? 0;
  const minDim = options.minDimension ?? 24;
  if (width < minDim || height < minDim) {
    return { ok: false, code: "image_too_small", reason: `图片尺寸过小 (${width}x${height})` };
  }
  if (width * height > 16_777_216) {
    return { ok: false, code: "image_too_large", reason: `图片像素尺寸过大 (${width}x${height})` };
  }

  const ratio = Math.max(width / height, height / width);
  if (ratio > options.maxAspectRatio) {
    return {
      ok: false,
      code: "screenshot_aspect_ratio",
      reason: `宽高比 ${ratio.toFixed(2)} 超过阈值 ${options.maxAspectRatio}（疑似长截图或横幅）`,
    };
  }

  return {
    ok: true,
    info: {
      sha256: sha256Hex(bytes),
      mime,
      ext: extForMime(mime),
      size: bytes.byteLength,
      width,
      height,
    },
  };
}
