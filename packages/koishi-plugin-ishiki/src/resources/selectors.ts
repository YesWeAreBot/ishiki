import { ResourceError } from "./errors.js";

/**
 * Read-selector grammar peeled off the tail of a resource URL by the read tool:
 * - `:1-200` / `:50+30` / `:12`  line slice (1-based; `+` = count after start)
 * - `#offset=N`                   character continuation in the readable view
 *
 * Line ranges may compose; continuations refer to the original readable view.
 */
export type Selector = { kind: "lines"; start: number; end?: number } | { kind: "offset"; offset: number; end?: number };

const LINE_CHUNK = /^(-?\d+)(?:([-+])(\d+))?$/;
const SCHEME_PREFIX_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Peel the selector chain off a resource URL. Returns the bare URL and parsed
 * chunks. Schemes that opt out (opaque wrappers like `mcp://`, or unknown
 * schemes) are never peeled — their tails carry the wrapped resource's own
 * syntax.
 */
export function splitSelectors(input: string, accepts: (scheme: string) => boolean): { url: string; selectors: Selector[] } {
  const scheme = SCHEME_PREFIX_RE.exec(input)?.[1]?.toLowerCase();
  if (scheme === undefined || !accepts(scheme)) return { url: input, selectors: [] };
  const fragment = /#offset=(\d+)(?:&end=(\d+))?$/.exec(input);
  if (fragment) {
    const offset = Number(fragment[1]);
    const end = fragment[2] === undefined ? undefined : Number(fragment[2]);
    if (!Number.isSafeInteger(offset) || (end !== undefined && (!Number.isSafeInteger(end) || end < 1)))
      throw new ResourceError("invalid_resource_uri", `invalid continuation: ${input}`);
    return { url: input.slice(0, fragment.index), selectors: [{ kind: "offset", offset, end }] };
  }
  const chainStart = findSelectorColon(input);
  if (chainStart === -1) return { url: input, selectors: [] };
  const url = input.slice(0, chainStart);
  const tail = input.slice(chainStart + 1);
  const selectors: Selector[] = [];
  for (const chunk of tail.split(":")) {
    const match = LINE_CHUNK.exec(chunk);
    if (!match) throw new ResourceError("invalid_resource_uri", `invalid selector ":${chunk}" in ${input}`);
    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 1 || (match[3] !== undefined && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1)))
      throw new ResourceError("invalid_resource_uri", `invalid line range: ${input}`);
    if (match[2] === "+") {
      if (start < 1) throw new ResourceError("invalid_resource_uri", `line selector start must be 1-based: ${input}`);
      const end = start + Number(match[3]) - 1;
      if (!Number.isSafeInteger(end)) throw new ResourceError("invalid_resource_uri", `invalid line range: ${input}`);
      selectors.push({ kind: "lines", start, end });
    } else {
      const end = match[3] === undefined ? undefined : Number(match[3]);
      if (end !== undefined && end < start) throw new ResourceError("invalid_resource_uri", `reversed line range: ${input}`);
      selectors.push({ kind: "lines", start, end });
    }
  }
  return { url, selectors };
}

/** Colon that opens the selector chain: the FIRST `:` after the authority segment. */
function findSelectorColon(input: string): number {
  const schemeEnd = input.indexOf("://") + 3;
  const authorityEnd = input.indexOf("/", schemeEnd);
  const index = input.indexOf(":", authorityEnd === -1 ? schemeEnd : authorityEnd);
  return index === -1 ? -1 : index;
}
