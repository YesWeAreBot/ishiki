export const STATUS_LABELS: Record<string, string> = {
  active: "运行中",
  stopped: "已停止",
  activating: "激活中",
  stopping: "停止中",
  error: "失败",
  waiting: "等待依赖",
  idle: "空闲",
  running: "运行中",
  empty: "空会话",
  unreadable: "读取失败",
};

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

export const STATUS_TONES: Record<string, StatusTone> = {
  active: "success",
  idle: "success",
  running: "info",
  stopped: "neutral",
  empty: "neutral",
  activating: "warning",
  stopping: "warning",
  waiting: "warning",
  error: "danger",
  unreadable: "danger",
};

export function statusLabel(state: string): string {
  return STATUS_LABELS[state] ?? state;
}

export function statusTone(state: string): StatusTone {
  return STATUS_TONES[state] ?? "neutral";
}
