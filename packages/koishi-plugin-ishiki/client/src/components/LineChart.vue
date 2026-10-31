<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { formatCompact, formatNumber, formatPercent } from "../lib/format";
import type { UsageBucket, UsageMetricKey, UsageSeries } from "../lib/usageSeries";

/**
 * 用量折线图：多序列、时间横轴、左侧 Token 轴、右侧调用次数与缓存率轴。
 * 只负责绘制传入的序列；指标切换与统计联动由父页面完成。
 */
const props = withDefaults(
  defineProps<{
    series: UsageSeries[];
    bucket?: UsageBucket;
    height?: number;
  }>(),
  { bucket: "day", height: 260 },
);

const chartColors: Record<UsageMetricKey, string> = {
  calls: "var(--chart-calls)",
  input: "var(--chart-input)",
  output: "var(--chart-output)",
  total: "var(--chart-total)",
  cacheRead: "var(--chart-cache-read)",
  cacheWrite: "var(--chart-cache-write)",
  cacheRate: "var(--chart-rate)",
};

const chartDashes: Record<UsageMetricKey, string | undefined> = {
  calls: undefined,
  input: "7 3",
  output: "2 3",
  total: "10 3 2 3",
  cacheRead: "4 3",
  cacheWrite: "1 3",
  cacheRate: "1 4",
};

const frame = ref<HTMLElement>();
const width = ref(900);
let observer: ResizeObserver | undefined;

onMounted(() => {
  if (frame.value === undefined) return;
  const update = (): void => {
    width.value = Math.max(280, Math.round(frame.value!.getBoundingClientRect().width));
  };
  update();
  observer = new ResizeObserver(update);
  observer.observe(frame.value);
});

onBeforeUnmount(() => observer?.disconnect());

const padding = { top: 14, right: 96, bottom: 30, left: 62 };
const axisSteps = 4;
const countUnit = "次";
const rateUnit = "%";
const rateMax = 100;

const times = computed<number[]>(() => {
  const set = new Set<number>();
  for (const entry of props.series) for (const point of entry.points) set.add(point.t);
  return [...set].sort((left, right) => left - right);
});

const valuesOf = (entry: UsageSeries): Map<number, number> => new Map(entry.points.map((point) => [point.t, point.v]));

const plotWidth = computed(() => width.value - padding.left - padding.right);
const plotHeight = computed(() => props.height - padding.top - padding.bottom);

const xOf = (index: number): number => {
  if (times.value.length <= 1) return padding.left + plotWidth.value / 2;
  return padding.left + (index / (times.value.length - 1)) * plotWidth.value;
};

const yOf = (value: number, max: number): number => padding.top + plotHeight.value - (value / max) * plotHeight.value;

type Axis = "left" | "right" | "rate";

interface SeriesMeta {
  entry: UsageSeries;
  values: Map<number, number>;
  color: string;
  dash: string | undefined;
  axis: Axis;
}

const seriesMeta = computed<SeriesMeta[]>(() =>
  props.series.map((entry) => ({
    entry,
    values: valuesOf(entry),
    color: chartColors[entry.key],
    dash: chartDashes[entry.key],
    axis: entry.unit === countUnit ? "right" : entry.unit === rateUnit ? "rate" : "left",
  })),
);

const leftSeries = computed(() => seriesMeta.value.filter((meta) => meta.axis === "left"));
const rightSeries = computed(() => seriesMeta.value.filter((meta) => meta.axis === "right"));
const rateSeries = computed(() => seriesMeta.value.filter((meta) => meta.axis === "rate"));

function axisMax(series: SeriesMeta[]): number {
  let raw = 0;
  for (const meta of series) for (const point of meta.entry.points) raw = Math.max(raw, point.v);
  if (raw <= 0) return 1;
  return Math.ceil(raw / axisSteps) * axisSteps;
}

const leftMax = computed(() => axisMax(leftSeries.value));
const rightMax = computed(() => axisMax(rightSeries.value));

function maxOf(meta: SeriesMeta): number {
  if (meta.axis === "rate") return rateMax;
  return meta.axis === "right" ? rightMax.value : leftMax.value;
}

function buildPath(meta: SeriesMeta): string {
  let path = "";
  let drawing = false;
  times.value.forEach((time, index) => {
    const value = meta.values.get(time);
    if (value === undefined) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${xOf(index).toFixed(1)},${yOf(value, maxOf(meta)).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

interface ChartPath {
  key: UsageMetricKey;
  color: string;
  dash: string | undefined;
  path: string;
}

const paths = computed<ChartPath[]>(() =>
  seriesMeta.value.map((meta) => ({
    key: meta.entry.key,
    color: meta.color,
    dash: meta.dash,
    path: buildPath(meta),
  })),
);

interface AxisTick {
  value: number;
  y: number;
  label: string;
}

function ticksOf(max: number, suffix = ""): AxisTick[] {
  return Array.from({ length: axisSteps + 1 }, (_, index) => {
    const value = (max / axisSteps) * index;
    return { value, y: yOf(value, max), label: `${formatCompact(value)}${suffix}` };
  });
}

const leftTicks = computed(() => ticksOf(leftMax.value));
const rightTicks = computed(() => ticksOf(rightMax.value));
const rateTicks = computed(() => ticksOf(rateMax, "%"));
const gridTicks = computed(() => {
  if (leftSeries.value.length > 0) return leftTicks.value;
  if (rightSeries.value.length > 0) return rightTicks.value;
  return rateTicks.value;
});

const labelWidth = computed(() => (props.bucket === "hour" ? 74 : props.bucket === "month" ? 58 : 36));
const maxLabelCount = computed(() => Math.max(2, Math.min(8, Math.floor(plotWidth.value / (labelWidth.value + 10)))));
const labelStep = computed(() => Math.max(1, Math.ceil((times.value.length - 1) / Math.max(1, maxLabelCount.value - 1))));

function bucketLabel(time: number, long: boolean): string {
  const date = new Date(time);
  if (props.bucket === "hour") {
    return long
      ? `${date.toLocaleDateString("zh-CN")} ${String(date.getHours()).padStart(2, "0")}:00`
      : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:00`;
  }
  if (props.bucket === "week")
    return long ? `${date.toLocaleDateString("zh-CN")} 起` : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (props.bucket === "month")
    return long ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月` : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return long ? date.toLocaleDateString("zh-CN") : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const xLabels = computed(() =>
  times.value
    .map((time, index) => ({ time, index }))
    .filter(({ index }) => index % labelStep.value === 0 || index === times.value.length - 1)
    .map(({ time, index }) => ({
      index,
      x: xOf(index),
      anchor: times.value.length <= 1 ? "middle" : index === 0 ? "start" : index === times.value.length - 1 ? "end" : "middle",
      label: bucketLabel(time, false),
    })),
);

const activeIndex = ref<number | null>(null);
const activeKey = ref<UsageMetricKey | null>(null);

function setActive(index: number | null): void {
  activeIndex.value = index;
}

watch(times, () => setActive(null));

interface TooltipRow {
  label: string;
  color: string;
  value: string;
}

interface ActiveDot {
  key: UsageMetricKey;
  color: string;
  x: number;
  y: number;
}

interface ChartActive {
  time: number;
  x: number;
  rows: TooltipRow[];
  dots: ActiveDot[];
  align: "is-left" | "is-center" | "is-right";
}

const active = computed<ChartActive | undefined>(() => {
  const index = activeIndex.value;
  if (index === null || index < 0 || index >= times.value.length) return undefined;
  const time = times.value[index];
  const x = xOf(index);
  const ratio = x / width.value;
  const rows: TooltipRow[] = [];
  const dots: ActiveDot[] = [];
  for (const meta of seriesMeta.value) {
    const value = meta.values.get(time);
    if (value === undefined) continue;
    const text = meta.axis === "rate" ? formatPercent(value / 100) : `${formatNumber(value)} ${meta.entry.unit}`;
    rows.push({ label: meta.entry.label, color: meta.color, value: text });
    dots.push({
      key: meta.entry.key,
      color: meta.color,
      x,
      y: yOf(value, maxOf(meta)),
    });
  }
  return {
    time,
    x,
    rows,
    dots,
    align: ratio < 0.33 ? "is-left" : ratio > 0.67 ? "is-right" : "is-center",
  };
});

function nearestIndex(event: MouseEvent): number | null {
  const svg = event.currentTarget;
  if (!(svg instanceof SVGSVGElement) || times.value.length === 0) return null;
  const rect = svg.getBoundingClientRect();
  const scale = width.value / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const ratio = (x - padding.left) / plotWidth.value;
  if (ratio < -0.05 || ratio > 1.05) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.round(clamped * (times.value.length - 1));
}

function onMouseMove(event: MouseEvent): void {
  setActive(nearestIndex(event));
}

function onMouseLeave(): void {
  setActive(null);
}

function onKeydown(event: KeyboardEvent): void {
  if (times.value.length === 0) return;
  const current = activeIndex.value;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const base = current === null ? (delta > 0 ? -1 : times.value.length) : current;
    setActive(Math.min(times.value.length - 1, Math.max(0, base + delta)));
  } else if (event.key === "Home") {
    event.preventDefault();
    setActive(0);
  } else if (event.key === "End") {
    event.preventDefault();
    setActive(times.value.length - 1);
  } else if (event.key === "Escape") {
    setActive(null);
  }
}

const hasData = computed(() => props.series.some((entry) => entry.points.length > 0));

const legend = computed(() => seriesMeta.value.map(({ entry, color }) => ({ key: entry.key, label: entry.label, unit: entry.unit, color })));

function highlightLegend(key: UsageMetricKey): void {
  activeKey.value = key;
}

function clearLegendHighlight(): void {
  activeKey.value = null;
}
</script>

<template>
  <div class="line-chart">
    <div v-if="!hasData" class="line-chart-empty muted small">当前指标在所选范围内没有数据点。</div>
    <template v-else>
      <div
        ref="frame"
        class="line-chart-frame"
        tabindex="0"
        role="img"
        aria-label="用量随时间变化的折线图，Token 使用左侧数轴，调用次数与缓存率使用右侧数轴，可用左右方向键浏览数据点"
        @keydown="onKeydown"
        @mouseleave="onMouseLeave"
      >
        <svg :viewBox="`0 0 ${width} ${height}`" :style="{ height: `${height}px` }" preserveAspectRatio="none" class="line-chart-svg" @mousemove="onMouseMove">
          <g v-for="tick in gridTicks" :key="tick.value" class="grid">
            <line :x1="padding.left" :x2="width - padding.right" :y1="tick.y" :y2="tick.y" />
            <text v-if="leftSeries.length > 0" :x="padding.left - 8" :y="tick.y + 3" text-anchor="end" class="axis-text">{{ tick.label }}</text>
          </g>

          <g v-if="rightSeries.length > 0">
            <text v-for="tick in rightTicks" :key="`right-${tick.value}`" :x="width - padding.right + 8" :y="tick.y + 3" text-anchor="start" class="axis-text">
              {{ tick.label }}
            </text>
          </g>

          <g v-if="rateSeries.length > 0">
            <text v-for="tick in rateTicks" :key="`rate-${tick.value}`" :x="width - padding.right + 44" :y="tick.y + 3" text-anchor="start" class="axis-text">
              {{ tick.label }}
            </text>
          </g>

          <g v-for="label in xLabels" :key="label.index">
            <line :x1="label.x" :x2="label.x" :y1="padding.top" :y2="padding.top + plotHeight" class="grid-faint" />
            <text :x="label.x" :y="height - 10" :text-anchor="label.anchor" class="axis-text">{{ label.label }}</text>
          </g>

          <path
            v-for="path in paths"
            :key="path.key"
            :d="path.path"
            fill="none"
            :stroke="path.color"
            :stroke-dasharray="path.dash"
            stroke-width="2"
            stroke-linecap="round"
            class="line-path"
            :class="{ 'is-dimmed': activeKey !== null && activeKey !== path.key }"
          />

          <line v-if="active !== undefined" :x1="active.x" :x2="active.x" :y1="padding.top" :y2="padding.top + plotHeight" class="cursor-line" />
          <circle
            v-for="dot in active?.dots ?? []"
            :key="dot.key"
            :cx="dot.x"
            :cy="dot.y"
            r="3.5"
            :fill="dot.color"
            class="active-dot"
            :class="{ 'is-dimmed': activeKey !== null && activeKey !== dot.key }"
          />
        </svg>

        <div v-if="active !== undefined" class="line-chart-tooltip" :class="active.align" :style="{ left: `${(active.x / width) * 100}%` }">
          <div class="tooltip-day mono">{{ bucketLabel(active.time, true) }}</div>
          <div v-for="row in active.rows" :key="row.label" class="tooltip-row">
            <i :style="{ background: row.color }"></i>
            <span>{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </div>
        </div>
      </div>

      <div class="line-chart-legend" role="list" aria-label="图表指标">
        <span
          v-for="item in legend"
          :key="item.key"
          class="legend-item"
          :class="{ 'is-active': activeKey === item.key, 'is-dimmed': activeKey !== null && activeKey !== item.key }"
          role="listitem"
          tabindex="0"
          @mouseenter="highlightLegend(item.key)"
          @mouseleave="clearLegendHighlight"
          @focus="highlightLegend(item.key)"
          @blur="clearLegendHighlight"
        >
          <i :style="{ background: item.color }"></i>
          {{ item.label }}（{{ item.unit }}）
        </span>
        <span class="legend-hint faint small">悬停指标高亮折线；悬停图表或用 ←→ 键查看数据点，调用次数与缓存率使用右侧数轴</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.line-chart-frame {
  position: relative;
  outline: none;
}

.line-chart-frame:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.line-chart-svg {
  display: block;
  width: 100%;
  height: auto;
}

.grid line {
  stroke: var(--line);
  stroke-width: 1;
}

.grid-faint {
  stroke: var(--line);
  stroke-width: 1;
  stroke-dasharray: 3 5;
  opacity: 0.6;
}

.axis-text {
  fill: var(--muted);
  font-size: 11px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.cursor-line {
  stroke: var(--line-strong);
  stroke-width: 1;
}

.line-path,
.active-dot {
  transition: opacity 0.12s ease;
}

.line-path.is-dimmed,
.active-dot.is-dimmed {
  opacity: 0.16;
}

.line-chart-tooltip {
  position: absolute;
  top: 8px;
  min-width: 148px;
  max-width: min(220px, calc(100% - 16px));
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  pointer-events: none;
  transform: translateX(-50%);
  z-index: 2;
}

.line-chart-tooltip.is-left {
  transform: translateX(0);
}

.line-chart-tooltip.is-right {
  transform: translateX(-100%);
}

.tooltip-day {
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 4px;
}

.tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

.tooltip-row span {
  color: var(--muted);
  flex: 1;
}

.tooltip-row strong {
  font-family: var(--mono);
  font-weight: 600;
}

.tooltip-row i,
.line-chart-legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}

.line-chart-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 11.5px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  outline: none;
  transition:
    color 0.12s ease,
    opacity 0.12s ease;
}

.legend-item:hover,
.legend-item:focus-visible,
.legend-item.is-active {
  background: var(--surface-muted);
  color: var(--ink);
}

.legend-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.legend-item.is-dimmed {
  opacity: 0.38;
}

.legend-hint {
  margin-left: 4px;
}

.line-chart-empty {
  padding: 28px 12px;
  text-align: center;
}
</style>
