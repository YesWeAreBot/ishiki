const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat("zh-CN");

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return exactNumber.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return compactNumber.format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatClock(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatDate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function relativeTime(value: number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return "—";
  const delta = Math.max(0, now - value);
  if (delta < 45_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return formatDate(value);
}

export function maskSecret(value: string): string {
  if (value.startsWith("${")) return value;
  if (value.length <= 8) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function duration(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
