/**
 * Resolve an asset's media type: declared wins unless it is a wildcard hint
 * (`image/*` from inbound registration) — then the bytes decide. Returns
 * undefined for unrecognized binaries. Every path that touches asset bytes
 * funnels through this one rule, so callers never see a wildcard type.
 */
export function concreteMediaType(declared: string | undefined, bytes: Uint8Array): string | undefined {
  if (declared && !declared.endsWith("/*")) return declared;
  return sniffMediaType(bytes);
}

/** Detect common media formats from their magic bytes. */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  return undefined;
}

/** Inspect image dimensions without decoding, resizing or changing bytes. */
export function imageSize(bytes: Uint8Array): { width?: number; height?: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length && data[at] === 0xff) {
      const marker = data[at + 1]!;
      const length = data.readUInt16BE(at + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      if (length < 2) break;
      at += 2 + length;
    }
  }
  if (data.length >= 30 && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") {
    const encoding = data.subarray(12, 16).toString();
    if (encoding === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (encoding === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (encoding === "VP8L" && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return {};
}
