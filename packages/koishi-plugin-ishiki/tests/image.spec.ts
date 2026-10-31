import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImage } from "../src/builtin-tools/image.js";
import { ResourceCenter } from "../src/resource/center.js";
import { decodeImage, prepareImageForModel } from "../src/resource/image.js";
import { imageSize } from "../src/resource/media.js";

let home: string;
let center: ResourceCenter;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-image-"));
  center = new ResourceCenter("image-test", home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const [red, green, blue, alpha] = pixel(x, y);
      png.data[at] = red;
      png.data[at + 1] = green;
      png.data[at + 2] = blue;
      png.data[at + 3] = alpha;
    }
  }
  return PNG.sync.write(png);
}

const SOURCE = makePng(4, 2, (x, y) => [x * 60, y * 120, 40, 255]);

async function sourceUrl(bytes = SOURCE, mediaType = "image/png"): Promise<string> {
  return center.store.writeArtifact("source", bytes, { mediaType });
}

async function outputBytes(url: string): Promise<Buffer> {
  const payload = await center.resolve(url);
  if (payload.type !== "file") throw new Error("expected file artifact");
  return Buffer.from(payload.bytes);
}

describe("raster image operations", () => {
  it("inspects real PNG and JPEG bytes without changing them", async () => {
    const pngUrl = await sourceUrl();
    const jpegBytes = jpeg.encode({ width: 3, height: 5, data: Buffer.alloc(3 * 5 * 4, 255) }, 85).data;
    const jpegUrl = await sourceUrl(Buffer.from(jpegBytes), "image/jpeg");
    const image = createImage({ center, maxDimension: 1568, imageInput: true });

    const png = await image.execute!({ url: pngUrl, operation: "inspect" }, { toolCallId: "inspect-png", messages: [] });
    const jpg = await image.execute!({ url: jpegUrl, operation: "inspect" }, { toolCallId: "inspect-jpeg", messages: [] });

    expect(png).toMatchObject({ ok: true, operation: "inspect", mediaType: "image/png", width: 4, height: 2, byteLength: SOURCE.byteLength });
    expect(jpg).toMatchObject({ ok: true, operation: "inspect", mediaType: "image/jpeg", width: 3, height: 5, byteLength: jpegBytes.byteLength });
  });

  it("resizes, crops, rotates, and converts through artifacts without exposing base64", async () => {
    const url = await sourceUrl();
    const image = createImage({ center, maxDimension: 1568, imageInput: true });

    const resized = await image.execute!({ url, operation: "resize", maxDimension: 2 }, { toolCallId: "resize", messages: [] });
    expect(resized).toMatchObject({ width: 2, height: 1, mediaType: "image/png" });
    expect(imageSize(await outputBytes(resized.url))).toEqual({ width: 2, height: 1 });

    const cropped = await image.execute!({ url, operation: "crop", x: 1, y: 1, width: 2, height: 1 }, { toolCallId: "crop", messages: [] });
    expect(cropped).toMatchObject({ width: 2, height: 1, mediaType: "image/png" });
    expect(imageSize(await outputBytes(cropped.url))).toEqual({ width: 2, height: 1 });

    const rotated = await image.execute!({ url, operation: "rotate", degrees: 90 }, { toolCallId: "rotate", messages: [] });
    expect(rotated).toMatchObject({ width: 2, height: 4, mediaType: "image/png" });
    expect(imageSize(await outputBytes(rotated.url))).toEqual({ width: 2, height: 4 });

    const converted = await image.execute!({ url, operation: "convert", format: "image/jpeg", quality: 90 }, { toolCallId: "convert", messages: [] });
    expect(converted).toMatchObject({ width: 4, height: 2, mediaType: "image/jpeg" });
    expect(imageSize(await outputBytes(converted.url))).toEqual({ width: 4, height: 2 });
    expect(converted.attachments).toHaveLength(1);
    expect(JSON.stringify(converted)).not.toContain(SOURCE.toString("base64"));
  });

  it("places transparent pixels on white when converting PNG to JPEG", async () => {
    const transparent = makePng(1, 1, () => [255, 0, 0, 0]);
    const url = await sourceUrl(transparent);
    const image = createImage({ center, maxDimension: 1568, imageInput: false });

    const converted = await image.execute!({ url, operation: "convert", format: "image/jpeg", quality: 100 }, { toolCallId: "transparent", messages: [] });
    const decoded = jpeg.decode(await outputBytes(converted.url), { useTArray: true, formatAsRGBA: true });
    expect([...decoded.data.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it("downsamples an 864x1920 PNG to a 1568-pixel long edge in the host process", async () => {
    const large = makePng(864, 1920, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
    const prepared = prepareImageForModel(large, "image/png", 1568);
    expect(prepared.resized).toBe(true);
    expect(prepared.height).toBe(1568);
    expect(prepared.width).toBe(706);
    expect(imageSize(prepared.bytes)).toEqual({ width: 706, height: 1568 });
    expect(decodeImage(prepared.bytes)).toMatchObject({ width: 706, height: 1568, mediaType: "image/png" });
  });

  it("rejects oversized GIF and WebP instead of pretending to downsample them", () => {
    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(2000, 6);
    gif.writeUInt16LE(10, 8);

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.writeUInt32LE(22, 4);
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1999, 24, 3);
    webp.writeUIntLE(9, 27, 3);

    for (const [bytes, mediaType] of [
      [gif, "image/gif"],
      [webp, "image/webp"],
    ] as const) {
      expect(() => prepareImageForModel(bytes, mediaType, 1568)).toThrow(expect.objectContaining({ code: "image_format_unsupported" }));
    }
  });
});
