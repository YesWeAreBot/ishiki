import { ResourceError } from "./errors.js";

/**
 * Read-selector grammar peeled off the tail of a resource URL by the read tool:
 * `:1-200` / `:50+30` / `:12` — 1-based line slices; `+` = count after start.
 */
export type Selector = { kind: "lines"; start: number; end?: number };

const LINE_CHUNK = /^(-?\d+)(?:([-+])(\d+))?$/;
const SCHEME_PREFIX_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Peel the selector chain off a resource URL. Returns the bare URL and the
 * composed line range. Schemes that opt out (opaque wrappers like `mcp://`,
 * or unknown schemes) are never peeled — their tails carry the wrapped
 * resource's own syntax.
 */
export function splitSelectors(input: string, accepts: (scheme: string) => boolean): { url: string; range?: { start: number; end?: number } } {
  const scheme = SCHEME_PREFIX_RE.exec(input)?.[1]?.toLowerCase();
  if (scheme === undefined || !accepts(scheme)) return { url: input };
  const chainStart = findSelectorColon(input);
  if (chainStart === -1) return { url: input };
  const url = input.slice(0, chainStart);
  const tail = input.slice(chainStart + 1);
  const range: { start: number; end?: number } = { start: 1 };
  for (const chunk of tail.split(":")) {
    const match = LINE_CHUNK.exec(chunk);
    if (!match) throw new ResourceError("invalid_resource_uri", `invalid selector ":${chunk}" in ${input}`);
    const base = range.start;
    const start = base + Number(match[1]) - 1;
    if (!Number.isSafeInteger(start) || start < 1 || (match[3] !== undefined && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1)))
      throw new ResourceError("invalid_resource_uri", `invalid line range: ${input}`);
    let end: number | undefined;
    if (match[2] === "+") end = start + Number(match[3]) - 1;
    else if (match[3] === undefined) end = range.end; // a bare `:N` moves the start and keeps the prior cap
    else end = base + Number(match[3]) - 1;
    if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) throw new ResourceError("invalid_resource_uri", `reversed line range: ${input}`);
    range.start = start;
    range.end = end;
  }
  return { url, range: range.start === 1 && range.end === undefined ? undefined : range };
}

/** Colon that opens the selector chain: the FIRST `:` after the authority segment. */
function findSelectorColon(input: string): number {
  const schemeEnd = input.indexOf("://") + 3;
  const authorityEnd = input.indexOf("/", schemeEnd);
  const index = input.indexOf(":", authorityEnd === -1 ? schemeEnd : authorityEnd);
  return index === -1 ? -1 : index;
}
