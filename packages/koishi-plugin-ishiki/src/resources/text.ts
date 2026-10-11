import { createReadStream } from "node:fs";

import { ResourceError } from "./errors.js";

/**
 * One text budget shared by every model-visible surface: the read tool's own
 * conversion and the unified tool-output wrapper. Because read converts
 * through the same budget, a converted read result always fits and the
 * wrapper never truncates (and archives) it a second time.
 */
export const TEXT_BUDGET = { maxLines: 2000, maxLineChars: 2000, maxChars: 30_000 } as const;

/**
 * The read tool reserves this much of the shared budget for its truncation
 * footer (3 lines, ~250 chars), so a converted read page always fits and the
 * wrapper never truncates (and archives) it a second time.
 */
const READ_FOOTER = { lines: 4, chars: 512 };

/** Whole reads without a line selector stop beyond this many characters; narrower selectors may read further. */
export const MAX_TEXT_CHARS = 8 * 1024 * 1024;

export interface Truncation {
  visible: string;
  /** 1-based line number of the first shown line in the source's line numbering. */
  startLine: number;
  /** 1-based line number of the last shown line. */
  endLine: number;
  /** Where a continuation should start; absent when nothing was cut. */
  nextLine?: number;
  /** The last shown line was cut mid-line at the character budget. */
  partialLine?: boolean;
}

/**
 * Cut `text` down to the budget. Returns undefined when everything fits.
 *
 * Lines are kept whole so the `:N+M` line-selector grammar can resume exactly
 * at `nextLine`. A single line longer than the whole budget is the one
 * exception: it is cut mid-line, and the remainder of that line is not
 * reachable through read's line selectors — read the resource inside codemode
 * or through the sandbox for full access. This is an accepted limitation.
 */
export function truncate(text: string, options: { startLine?: number; maxChars?: number; maxLines?: number } = {}): Truncation | undefined {
  const startLine = options.startLine ?? 1;
  const maxChars = options.maxChars ?? TEXT_BUDGET.maxChars;
  const maxLines = options.maxLines ?? TEXT_BUDGET.maxLines;
  const lines = text.split("\n");
  const taken: string[] = [];
  let total = 0; // length of taken.join("\n")
  let partialLine = false;
  while (taken.length < lines.length && taken.length < maxLines) {
    // A line past the per-line cap is cut here. Its tail is not addressable by
    // the `:N+M` selectors — an accepted limitation, since reaching it would
    // need an intra-line offset and that is pagination again. Read the
    // resource inside codemode or the sandbox for the whole line.
    const source = lines[taken.length]!;
    const line = source.length > TEXT_BUDGET.maxLineChars ? source.slice(0, TEXT_BUDGET.maxLineChars) : source;
    const lineCut = line.length < source.length;
    const separator = taken.length > 0 ? 1 : 0;
    if (total + separator + line.length > maxChars) {
      const room = maxChars - total - separator;
      if (room > 0) {
        taken.push(line.slice(0, room));
        partialLine = true;
      }
      break;
    }
    taken.push(line);
    total += separator + line.length;
    if (lineCut) {
      partialLine = true;
      break;
    }
  }
  const shown = taken.length;
  if (shown === 0) {
    return { visible: "", startLine, endLine: startLine - 1, nextLine: startLine, partialLine: true };
  }
  const endLine = startLine + shown - 1;
  if (shown >= lines.length && !partialLine) return undefined;
  return {
    visible: taken.join("\n"),
    startLine,
    endLine,
    nextLine: endLine + 1,
    ...(partialLine ? { partialLine: true } : {}),
  };
}

/** The footer the read conversion appends to a truncated page. */
export function describeTruncation(cut: Truncation, url: string): string {
  const partial = cut.partialLine === true ? " (last line cut at the character budget; its remainder is only reachable inside codemode or the sandbox)" : "";
  return [
    cut.visible,
    `[truncated: showing lines ${cut.startLine}-${cut.endLine}${partial}]`,
    `Full result: ${url}`,
    `Continue: read({url: "${url}:${cut.nextLine}+${TEXT_BUDGET.maxLines}"})`,
  ].join("\n");
}

/** Budget for the read tool's own conversion: the shared cap minus its footer. */
export function readBudget(): { maxChars: number; maxLines: number } {
  return { maxChars: TEXT_BUDGET.maxChars - READ_FOOTER.chars, maxLines: TEXT_BUDGET.maxLines - READ_FOOTER.lines };
}

/**
 * Collect the lines of `range` from a text source, streaming when the source
 * is an async iterable. Selected output beyond {@link MAX_TEXT_CHARS} fails:
 * narrow the range instead of materializing unbounded text.
 */
export async function selectLines(source: string | AsyncIterable<string>, range: { start?: number; end?: number } = {}): Promise<string> {
  const start = Math.max(1, range.start ?? 1);
  const end = range.end ?? Number.MAX_SAFE_INTEGER;
  const out: string[] = [];
  let line = 1;
  let chars = 0;
  const collect = (segment: string): void => {
    if (line < start || line > end) return;
    out.push(segment);
    chars += segment.length;
    if (chars > MAX_TEXT_CHARS) {
      throw new ResourceError("resource_too_large", `selected text exceeds ${MAX_TEXT_CHARS} characters; narrow the line range with :N+M selectors`);
    }
  };
  let carry = "";
  for await (const chunk of typeof source === "string" ? [source] : source) {
    carry += chunk;
    let at = 0;
    for (;;) {
      const newline = carry.indexOf("\n", at);
      if (newline < 0) break;
      collect(carry.slice(at, newline + 1));
      line += 1;
      at = newline + 1;
      if (line > end) return out.join("");
    }
    carry = carry.slice(at);
  }
  if (carry.length > 0) collect(carry);
  return out.join("");
}

export function fileText(file: string): AsyncIterable<string> {
  return createReadStream(file, { encoding: "utf8" }) as AsyncIterable<string>;
}
