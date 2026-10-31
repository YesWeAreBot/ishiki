import type { UsageRecord } from "../types";

export type UsageMetricKey = "calls" | "input" | "output" | "total" | "cacheRead" | "cacheWrite" | "cacheRate";
export type UsageBucket = "hour" | "day" | "week" | "month";

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
  { key: "cacheRate", label: "缓存率", unit: "%" },
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

export interface UsageBuckets {
  bucket: UsageBucket;
  series: UsageSeries[];
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function bucketStart(timestamp: number, bucket: UsageBucket): number {
  const date = new Date(timestamp);
  if (bucket === "hour") return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
  if (bucket === "day") return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (bucket === "week") {
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (midnight.getDay() + 6) % 7;
    midnight.setDate(midnight.getDate() - offset);
    return midnight.getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function chooseBucket(span: number): UsageBucket {
  if (span <= 36 * HOUR) return "hour";
  if (span <= 90 * DAY) return "day";
  if (span <= 730 * DAY) return "week";
  return "month";
}

interface BucketSums {
  calls: number;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 图表数据只用原始用量记录：按时间跨度自动选择小时、天、周或月分桶。
 * 只有出现记录的桶会生成数据点，空档不补零。
 */
export function bucketUsage(records: readonly UsageRecord[], metrics: readonly UsageMetricKey[]): UsageBuckets {
  if (records.length === 0) return { bucket: "day", series: [] };
  let min = records[0].timestamp;
  let max = records[0].timestamp;
  for (const record of records) {
    min = Math.min(min, record.timestamp);
    max = Math.max(max, record.timestamp);
  }
  const bucket = chooseBucket(max - min);
  const buckets = new Map<number, BucketSums>();
  for (const record of records) {
    const key = bucketStart(record.timestamp, bucket);
    let sums = buckets.get(key);
    if (sums === undefined) {
      sums = { calls: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
      buckets.set(key, sums);
    }
    sums.calls += 1;
    sums.input += record.input;
    sums.output += record.output;
    sums.total += record.total;
    sums.cacheRead += record.cacheRead;
    sums.cacheWrite += record.cacheWrite;
  }
  const times = [...buckets.keys()].sort((left, right) => left - right);
  const series = metrics.map((key) => {
    const metric = USAGE_METRICS.find((entry) => entry.key === key) ?? { key, label: key, unit: "" };
    return {
      key,
      label: metric.label,
      unit: metric.unit,
      points: times.map((time) => {
        const sums = buckets.get(time)!;
        const value = key === "cacheRate" ? (sums.input > 0 ? (sums.cacheRead / sums.input) * 100 : 0) : sums[key];
        return { t: time, v: value };
      }),
    };
  });
  return { bucket, series };
}
