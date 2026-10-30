export function dayStart(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

export function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 60 * 60 * 1000 - 1;
}
