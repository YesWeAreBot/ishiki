function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** Host tools may stream partial values; the caller keeps the final one. */
export async function settled(value: unknown): Promise<unknown> {
  if (!isAsyncIterable(value)) return value;
  let last: unknown;
  for await (const item of value) last = item;
  return last;
}
