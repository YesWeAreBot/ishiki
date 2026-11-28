import { PNG } from "pngjs";

const MAX_PIXELS = 4_194_304;

/**
 * Decode the first visual frame of a GIF87a/GIF89a byte stream into PNG bytes.
 * Used to normalize animated GIFs into a static PNG before calling vision models,
 * while preserving the original GIF file on disk.
 */
export function gifFirstFrameToPng(bytes: Uint8Array): Uint8Array | undefined {
  try {
    if (bytes.length < 14) return undefined;
    const header = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
    if (header !== "GIF87a" && header !== "GIF89a") return undefined;

    const screenWidth = bytes[6]! | (bytes[7]! << 8);
    const screenHeight = bytes[8]! | (bytes[9]! << 8);
    if (screenWidth <= 0 || screenHeight <= 0 || screenWidth * screenHeight > MAX_PIXELS) return undefined;

    const packed = bytes[10]!;
    const hasGct = (packed & 0x80) !== 0;
    const gctSize = hasGct ? 1 << ((packed & 0x07) + 1) : 0;
    let offset = 13;

    let gct: Uint8Array | undefined;
    if (hasGct) {
      const byteLength = gctSize * 3;
      if (offset + byteLength > bytes.length) return undefined;
      gct = bytes.subarray(offset, offset + byteLength);
      offset += byteLength;
    }

    let transparentIndex = -1;
    while (offset < bytes.length) {
      const blockId = bytes[offset++]!;
      if (blockId === 0x3b) return undefined; // Trailer before any image descriptor
      if (blockId === 0x21) {
        if (offset >= bytes.length) return undefined;
        const label = bytes[offset++]!;
        if (label === 0xf9 && offset < bytes.length && bytes[offset]! >= 4) {
          const gceSize = bytes[offset]!;
          const gceFlags = bytes[offset + 1]!;
          if ((gceFlags & 0x01) !== 0) transparentIndex = bytes[offset + 4]!;
          offset += 1 + gceSize;
          if (offset < bytes.length && bytes[offset] === 0) offset += 1;
          else offset = skipSubBlocks(bytes, offset);
        } else {
          offset = skipSubBlocks(bytes, offset);
        }
        continue;
      }

      if (blockId !== 0x2c) return undefined;
      if (offset + 9 > bytes.length) return undefined;
      const left = bytes[offset]! | (bytes[offset + 1]! << 8);
      const top = bytes[offset + 2]! | (bytes[offset + 3]! << 8);
      const frameWidth = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
      const frameHeight = bytes[offset + 6]! | (bytes[offset + 7]! << 8);
      const localPacked = bytes[offset + 8]!;
      offset += 9;

      if (frameWidth <= 0 || frameHeight <= 0 || left + frameWidth > screenWidth || top + frameHeight > screenHeight) {
        return undefined;
      }

      const hasLct = (localPacked & 0x80) !== 0;
      const interlaced = (localPacked & 0x40) !== 0;
      const lctSize = hasLct ? 1 << ((localPacked & 0x07) + 1) : 0;
      let palette = gct;
      if (hasLct) {
        const byteLength = lctSize * 3;
        if (offset + byteLength > bytes.length) return undefined;
        palette = bytes.subarray(offset, offset + byteLength);
        offset += byteLength;
      }
      if (!palette || offset >= bytes.length) return undefined;

      const minCodeSize = bytes[offset++]!;
      if (minCodeSize < 2 || minCodeSize > 8) return undefined;
      const compressed = collectSubBlocks(bytes, offset);
      if (compressed.length === 0) return undefined;

      const indices = decodeLzw(compressed, minCodeSize, frameWidth * frameHeight);
      if (!indices) return undefined;

      const png = new PNG({ width: screenWidth, height: screenHeight, fill: true });
      const deinterlaced = interlaced ? deinterlace(indices, frameWidth, frameHeight) : indices;
      renderFrameToRgba(png.data, screenWidth, left, top, frameWidth, frameHeight, deinterlaced, palette, transparentIndex);
      return new Uint8Array(PNG.sync.write(png));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset++]!;
    if (size === 0) return offset;
    offset += size;
  }
  return bytes.length;
}

function collectSubBlocks(bytes: Uint8Array, start: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset++]!;
    if (size === 0) break;
    const end = Math.min(bytes.length, offset + size);
    const slice = bytes.subarray(offset, end);
    chunks.push(slice);
    total += slice.length;
    offset = end;
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }
  return merged;
}

function decodeLzw(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array | undefined {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = new Uint8Array(pixelCount);

  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let available = clearCode + 2;
  let oldCode = -1;
  let first = 0;
  let outPos = 0;

  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let dataPos = 0;

  const resetDictionary = () => {
    codeSize = minCodeSize + 1;
    codeMask = (1 << codeSize) - 1;
    available = clearCode + 2;
    oldCode = -1;
  };

  for (let i = 0; i < clearCode; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  while (outPos < pixelCount) {
    while (bitsInBuffer < codeSize && dataPos < data.length) {
      bitBuffer |= data[dataPos++]! << bitsInBuffer;
      bitsInBuffer += 8;
    }
    if (bitsInBuffer < codeSize) break;

    const code = bitBuffer & codeMask;
    bitBuffer >>= codeSize;
    bitsInBuffer -= codeSize;

    if (code === clearCode) {
      resetDictionary();
      continue;
    }
    if (code === endCode) break;

    if (oldCode === -1) {
      if (code >= clearCode) return undefined;
      output[outPos++] = suffix[code]!;
      oldCode = code;
      first = code;
      continue;
    }

    let inCode = code;
    let stackTop = 0;
    if (code === available) {
      stack[stackTop++] = first;
      inCode = oldCode;
    } else if (code > available) {
      return undefined;
    }

    while (inCode >= clearCode) {
      if (stackTop >= 4096) return undefined;
      stack[stackTop++] = suffix[inCode]!;
      inCode = prefix[inCode]!;
      if (inCode < 0) return undefined;
    }

    first = suffix[inCode]!;
    stack[stackTop++] = first;

    if (available < 4096) {
      prefix[available] = oldCode;
      suffix[available] = first;
      available += 1;
      if ((available & codeMask) === 0 && available < 4096) {
        codeSize += 1;
        codeMask = (1 << codeSize) - 1;
      }
    }
    oldCode = code;

    while (stackTop > 0 && outPos < pixelCount) {
      output[outPos++] = stack[--stackTop]!;
    }
  }

  return outPos > 0 ? output : undefined;
}

function deinterlace(indices: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(indices.length);
  const starts = [0, 4, 2, 1];
  const steps = [8, 8, 4, 2];
  let srcRow = 0;
  for (let pass = 0; pass < 4; pass++) {
    for (let y = starts[pass]!; y < height; y += steps[pass]!) {
      const srcOffset = srcRow * width;
      const dstOffset = y * width;
      result.set(indices.subarray(srcOffset, srcOffset + width), dstOffset);
      srcRow += 1;
    }
  }
  return result;
}

function renderFrameToRgba(
  rgba: Buffer,
  screenWidth: number,
  left: number,
  top: number,
  frameWidth: number,
  frameHeight: number,
  indices: Uint8Array,
  palette: Uint8Array,
  transparentIndex: number,
): void {
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      const colorIndex = indices[y * frameWidth + x]!;
      const dst = ((top + y) * screenWidth + (left + x)) * 4;
      if (colorIndex === transparentIndex || colorIndex * 3 + 2 >= palette.length) {
        rgba[dst + 3] = 0;
        continue;
      }
      const p = colorIndex * 3;
      rgba[dst] = palette[p]!;
      rgba[dst + 1] = palette[p + 1]!;
      rgba[dst + 2] = palette[p + 2]!;
      rgba[dst + 3] = 255;
    }
  }
}
