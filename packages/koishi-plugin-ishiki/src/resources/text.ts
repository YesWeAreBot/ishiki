import { ResourceError } from "./errors.js";

export const TEXT_BUDGET = { maxLines: 2000, maxChars: 30_000 } as const;

/** Position within the original selected representation, not within a displayed page. */
export interface FileTextSource {
  url: string;
  offset: number;
  line: number;
  column: number;
}

export function textFits(text: string): boolean {
  if (text.length > TEXT_BUDGET.maxChars) return false;
  let lines = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    if (++lines > TEXT_BUDGET.maxLines) return false;
  }
  return true;
}

function prefixEnd(text: string, chars: number, lines: number): number {
  if (chars <= 0 || lines <= 0) return 0;
  let end = Math.min(text.length, chars);
  let count = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) {
    if (++count > lines) {
      end = at;
      break;
    }
  }
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end -= 1;
  return end;
}

/** The body and the complete continuation footer share one budget. */
export function renderTextPage(text: string, source: FileTextSource): string {
  if (textFits(text)) return text;
  let end = prefixEnd(text, TEXT_BUDGET.maxChars, TEXT_BUDGET.maxLines);
  for (;;) {
    let line = source.line;
    let column = source.column;
    let last = 0;
    for (let at = text.indexOf("\n"); at !== -1 && at < end; at = text.indexOf("\n", at + 1)) {
      line += 1;
      column = 1;
      last = at + 1;
    }
    column += end - last;
    const nextUrl = `${source.url}${source.url.includes("?") ? "&" : "?"}offset=${source.offset + end}`;
    const lastLine = end > 0 && text.charCodeAt(end - 1) === 10 ? line - 1 : line;
    const footer = `\n[truncated: showing lines ${source.line}-${lastLine}; next ${line}:${column}]\nFull result: ${source.url}\nContinue: read(${JSON.stringify({ url: nextUrl })})`;
    const nextEnd = prefixEnd(text, TEXT_BUDGET.maxChars - footer.length, TEXT_BUDGET.maxLines - 3);
    if (end > 0 && end <= nextEnd) return text.slice(0, end) + footer;
    if (nextEnd === 0) throw new ResourceError("resource_too_large", "resource URL leaves no room for a progressing text page");
    end = Math.min(end, nextEnd);
  }
}

/** Collect only the selected lines and offset; do not buffer skipped file content. */
export async function selectText(
  input: string | AsyncIterable<string>,
  range: { start?: number; end?: number },
  offset: number,
): Promise<{ text: string; line: number; column: number }> {
  const start = range.start ?? 1;
  const end = range.end ?? Number.MAX_SAFE_INTEGER;
  const parts: string[] = [];
  let line = 1;
  let column = 1;
  let remaining = offset;
  let firstLine = start;
  let firstColumn = 1;
  let started = false;
  for await (const chunk of typeof input === "string" ? [input] : input) {
    let from = -1;
    let to = 0;
    for (let at = 0; at < chunk.length && line <= end;) {
      const newline = chunk.indexOf("\n", at);
      const stop = newline === -1 ? chunk.length : newline + 1;
      if (line >= start) {
        const skipped = Math.min(remaining, stop - at);
        const begin = at + skipped;
        if (
          begin > at &&
          begin < stop &&
          chunk.charCodeAt(begin - 1) >= 0xd800 &&
          chunk.charCodeAt(begin - 1) <= 0xdbff &&
          chunk.charCodeAt(begin) >= 0xdc00 &&
          chunk.charCodeAt(begin) <= 0xdfff
        ) {
          throw new ResourceError("invalid_resource_uri", "continuation offset splits a Unicode character");
        }
        remaining -= skipped;
        if (begin < stop) {
          if (!started) {
            firstLine = line;
            firstColumn = column + skipped;
            started = true;
          }
          if (from === -1) from = begin;
          to = stop;
        }
      }
      if (newline === -1) column += stop - at;
      else {
        line += 1;
        column = 1;
      }
      at = stop;
    }
    if (from !== -1) parts.push(chunk.slice(from, to));
    if (line > end) break;
  }
  return { text: parts.join(""), line: firstLine, column: firstColumn };
}
