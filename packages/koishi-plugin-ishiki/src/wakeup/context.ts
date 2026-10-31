/** Faithful, bounded projections preserve the referenced turn without synthetic summaries. */
export interface JevContextLine {
  id: string;
  author: string;
  authorId: string;
  text: string;
  at: number;
  self: boolean;
  mentionsBot?: boolean;
  quote?: { id?: string; author_id?: string; text: string };
}
export function clipJevText(text: string, limit = 1200): string {
  if (text.length <= limit) return text;
  const marker = "…[middle omitted]…";
  if (limit < marker.length) return text.slice(0, Math.max(0, limit));
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil((available * 2) / 3);
  return text.slice(0, head) + marker + (available > head ? text.slice(-(available - head)) : "");
}
export function projectJevLine(line: JevContextLine, now: number) {
  return {
    id: line.id,
    author: clipJevText(line.author, 120),
    author_id: line.authorId,
    is_bot: line.self,
    text: line.text,
    seconds_ago: Math.max(0, (now - line.at) / 1000),
    mentions_bot: line.mentionsBot,
    quote: line.quote,
  };
}

export function selectJevContext(
  lines: readonly JevContextLine[],
  options: { count: number; chars: number; now: number; maxAgeMs: number; pendingIds?: readonly string[]; quoteId?: string; focusId?: string },
) {
  const pending = new Set(options.pendingIds ?? []);
  const eligible = lines.filter((line) => !pending.has(line.id) && options.now - line.at <= options.maxAgeMs);
  const project = (line: JevContextLine) => projectJevLine(line, options.now);
  const chosen = new Set<number>(),
    projected = new Map<number, ReturnType<typeof project>>();
  let remaining = Math.max(0, Math.floor(options.chars) - 2);
  const add = (index: number, allowance = remaining): void => {
    if (index < 0 || chosen.has(index) || chosen.size >= options.count) return;
    const line = project(eligible[index]),
      budget = Math.min(remaining, allowance);
    let length = JSON.stringify(line).length + 1;
    if (length > budget && line.quote) {
      line.quote = { ...line.quote, text: clipJevText(line.quote.text, 120) };
      length = JSON.stringify(line).length + 1;
    }
    while (length > budget && line.text.length > 0) {
      line.text = clipJevText(line.text, Math.max(0, line.text.length - (length - budget)));
      length = JSON.stringify(line).length + 1;
    }
    if (length > budget) return;
    chosen.add(index);
    projected.set(index, line);
    remaining -= length;
  };
  if (options.focusId)
    add(
      eligible.findIndex((line) => line.id === options.focusId),
      eligible.length > 1 ? Math.floor(remaining / 2) : remaining,
    );
  const tail = Math.max(1, Math.floor(options.count * 0.7));
  for (let index = eligible.length - 1; index >= Math.max(0, eligible.length - tail); index--) add(index);
  if (options.quoteId) add(eligible.findIndex((line) => line.id === options.quoteId));
  const bot = eligible.findLastIndex((line) => line.self);
  add(bot);
  if (bot >= 0) add(bot - 1);
  for (let index = eligible.length - 1; index >= 0; index--) add(index);
  return [...chosen].sort((a, b) => eligible[a].at - eligible[b].at || a - b).map((index) => projected.get(index)!);
}
