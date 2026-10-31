import type { UsageRecord } from "../types";

export type UsageMetricKey = "calls" | "input" | "output" | "total" | "cacheRead" | "cacheWrite" | "reasoning";

export interface UsageMetric {
  key: UsageMetricKey;
  label: string;
  unit: string;
}

export const USAGE_METRICS: readonly UsageMetric[] = [
  { key: "calls", label: "调用次数", unit: "次" },
  { key: "input", label: "输入", unit: "Token" },
  { key: "output", label: "输出", unit: "Token" },
  { key: "total", label: "合计", unit: "Token" },
  { key: "cacheRead", label: "缓存读取", unit: "Token" },
  { key: "cacheWrite", label: "缓存写入", unit: "Token" },
  { key: "reasoning", label: "推理", unit: "Token" },
];

export interface SeriesPoint {
  t: number;
  v: number;
}

export interface UsageSeries {
  key: UsageMetricKey;
  label: string;
  unit: string;
  points: SeriesPoint[];
}

function metricValue(record: UsageRecord, key: UsageMetricKey): number {
  if (key === "calls") return 1;
  return record[key];
}

function dayStartLocal(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 图表数据只用原始用量记录：按本地日期分桶后对选定指标求和。
 * 只有出现记录的日期会生成数据点，空档不补零。
 */
export function bucketUsageByDay(records: readonly UsageRecord[], metrics: readonly UsageMetricKey[]): UsageSeries[] {
  const buckets = new Map<number, Record<string, number>>();
  for (const record of records) {
    const day = dayStartLocal(record.timestamp);
    let sums = buckets.get(day);
    if (sums === undefined) {
      sums = {};
      buckets.set(day, sums);
    }
    for (const metric of metrics) sums[metric] = (sums[metric] ?? 0) + metricValue(record, metric);
  }
  const days = [...buckets.keys()].sort((left, right) => left - right);
  return metrics.map((key) => {
    const metric = USAGE_METRICS.find((entry) => entry.key === key) ?? { key, label: key, unit: "" };
    return {
      key,
      label: metric.label,
      unit: metric.unit,
      points: days.map((day) => ({ t: day, v: buckets.get(day)?.[key] ?? 0 })),
    };
  });
}
