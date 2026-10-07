import { ResourceError } from "./center.js";

/**
 * Read-selector grammar peeled off the tail of a resource URL by the read tool:
 * - `:1-200` / `:50+30` / `:12`  line slice (1-based; `+` = count after start)
 * - `:raw`                       whole file, no line-number reflow
 * - `.a.b.0.c`                   JSON dot-path extraction (leading dot)
 *
 * Chunks chain with `:` (`:raw:1-50`), applied left to right; only line slices
 * are allowed after the first one.
 */
export type Selector = { kind: "lines"; start: number; end?: number } | { kind: "raw" } | { kind: "path"; segments: string[] };

const LINE_CHUNK = /^(-?\d+)(?:([-+])(\d+))?$/;

/** Peel the selector chain off a resource URL. Returns the bare URL and parsed chunks. */
export function splitSelectors(input: string): { url: string; selectors: Selector[] } {
  const chainStart = findSelectorColon(input);
  if (chainStart === -1) return { url: input, selectors: [] };
  const url = input.slice(0, chainStart);
  const tail = input.slice(chainStart + 1);
  const selectors: Selector[] = [];
  for (const [index, chunk] of tail.split(":").entries()) {
    if (chunk === "raw") {
      selectors.push({ kind: "raw" });
      continue;
    }
    if (chunk.startsWith(".")) {
      if (index > 0) throw new ResourceError("invalid_resource_uri", `dot-path selector must come first: ${input}`);
      if (tail.split(":").length > 1) throw new ResourceError("invalid_resource_uri", `dot-path selector cannot chain: ${input}`);
      selectors.push({ kind: "path", segments: chunk.slice(1).split(".") });
      continue;
    }
    const match = LINE_CHUNK.exec(chunk);
    if (!match) throw new ResourceError("invalid_resource_uri", `invalid selector ":${chunk}" in ${input}`);
    const start = Number(match[1]);
    if (match[2] === "+") {
      if (start < 1) throw new ResourceError("invalid_resource_uri", `line selector start must be 1-based: ${input}`);
      selectors.push({ kind: "lines", start, end: start + Number(match[3]) - 1 });
    } else {
      const end = match[3] === undefined ? undefined : Number(match[3]);
      selectors.push({ kind: "lines", start, end });
    }
  }
  return { url, selectors };
}

/**
 * Colon that opens the selector chain: the FIRST `:` after the authority
 * segment. Everything after it is the selector chain. Opaque URIs whose
 * authority itself contains a colon (`mcp://urn:example:doc`) carry the
 * wrapped resource's own syntax and never take selectors.
 */
function findSelectorColon(input: string): number {
  const schemeEnd = input.indexOf("://") + 3;
  const authorityEnd = input.indexOf("/", schemeEnd);
  const authority = input.slice(schemeEnd, authorityEnd === -1 ? input.length : authorityEnd);
  if (authority.includes(":")) return -1;
  const index = input.indexOf(":", authorityEnd === -1 ? schemeEnd : authorityEnd);
  return index === -1 ? -1 : index;
}
