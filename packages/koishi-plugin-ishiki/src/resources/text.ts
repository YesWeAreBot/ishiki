import { createReadStream } from "node:fs";

export const TEXT_BUDGET = { maxLines: 2000, maxChars: 30_000 } as const;

export interface TextPage {
  text: string;
  totalLines: number;
  totalChars: number;
  startLine: number;
  endLine: number;
  offset: number;
  nextOffset?: number;
}

/** Offsets count UTF-16 characters in the stable readable view, including newlines. */
export async function textPage(source: string | AsyncIterable<string>, range: { start?: number; end?: number; offset?: number } = {}): Promise<TextPage> {
  let position = 0;
  let line = 1;
  let text = "";
  let startLine = 1;
  let endLine = 1;
  let offset = range.offset ?? 0;
  let nextOffset: number | undefined;
  let started = false;
  let selectedLines = 0;
  const chunks = typeof source === "string" ? [source] : source;
  for await (const chunk of chunks) {
    let at = 0;
    while (at < chunk.length) {
      const newline = chunk.indexOf("\n", at);
      const end = newline < 0 ? chunk.length : newline + 1;
      const segment = chunk.slice(at, end);
      const eligible = line >= (range.start ?? 1) && line <= (range.end ?? Infinity) && position + segment.length > (range.offset ?? 0);
      if (eligible) {
        const skip = Math.max(0, (range.offset ?? 0) - position);
        if (!started) {
          started = true;
          offset = position + skip;
          startLine = line;
        }
        const available = segment.slice(skip);
        const count = selectedLines < TEXT_BUDGET.maxLines ? Math.min(available.length, TEXT_BUDGET.maxChars - text.length) : 0;
        if (count > 0 && nextOffset === undefined) {
          text += available.slice(0, count);
          endLine = line;
        }
        if (count < available.length && nextOffset === undefined) nextOffset = position + skip + count;
        if (newline >= 0) selectedLines += 1;
      }
      position += segment.length;
      if (newline >= 0) line += 1;
      at = end;
    }
  }
  // Do not split a surrogate pair at the budget boundary.
  if (nextOffset !== undefined && /[\uD800-\uDBFF]$/.test(text)) {
    text = text.slice(0, -1);
    nextOffset -= 1;
  }
  return started
    ? { text, totalLines: line, totalChars: position, startLine, endLine, offset, nextOffset }
    : { text: "", totalLines: line, totalChars: position, startLine: range.start ?? line, endLine: range.start ?? line, offset: Math.min(offset, position) };
}

export function fileText(file: string): AsyncIterable<string> {
  return createReadStream(file, { encoding: "utf8" }) as AsyncIterable<string>;
}

export function pageDescription(page: TextPage, url: string, end?: number): string {
  if (page.nextOffset === undefined) return page.text;
  const continuation = `${url}#offset=${page.nextOffset}${end === undefined ? "" : `&end=${end}`}`;
  return `${page.text}\n[truncated: lines ${page.startLine}-${page.endLine} of ${page.totalLines}; characters ${page.offset}-${page.nextOffset} of ${page.totalChars}]\nFull result: ${url}\nContinue: read({url: "${continuation}"})`;
}
