<script setup lang="ts">
import { computed, ref } from "vue";

import { formatCompact, formatNumber } from "../lib/format";
import type { UsageMetricKey, UsageSeries } from "../lib/usageSeries";

/**
 * 用量折线图：多序列、时间横轴、悬停与键盘浏览。
 * 只负责绘制传入的序列；指标切换与统计联动由父页面完成。
 */
const props = withDefaults(
  defineProps<{
    series: UsageSeries[];
    height?: number;
  }>(),
  { height: 260 },
);

const chartColors: Record<UsageMetricKey, string> = {
  calls: "var(--chart-calls)",
  input: "var(--chart-input)",
  output: "var(--chart-output)",
  total: "var(--chart-total)",
  cacheRead: "var(--chart-cache-read)",
  cacheWrite: "var(--chart-cache-write)",
  reasoning: "var(--chart-reasoning)",
};

const chartDashes: Record<UsageMetricKey, string | undefined> = {
  calls: undefined,
  input: "7 3",
  output: "2 3",
  total: "10 3 2 3",
  cacheRead: "4 3",
  cacheWrite: "1 3",
  reasoning: "9 3",
};

const width = 900;
const padding = { top: 14, right: 18, bottom: 30, left: 62 };

const days = computed<number[]>(() => {
  const set = new Set<number>();
  for (const entry of props.series) for (const point of entry.points) set.add(point.t);
  return [...set].sort((left, right) => left - right);
});

const valuesOf = (entry: UsageSeries): Map<number, number> => new Map(entry.points.map((point) => [point.t, point.v]));

const plotWidth = width - padding.left - padding.right;
const plotHeight = computed(() => props.height - padding.top - padding.bottom);

const xOf = (index: number): number => {
  if (days.value.length <= 1) return padding.left + plotWidth / 2;
  return padding.left + (index / (days.value.length - 1)) * plotWidth;
};

const yOf = (value: number, max: number): number => padding.top + plotHeight.value - (value / max) * plotHeight.value;

interface SeriesMeta {
  entry: UsageSeries;
  values: Map<number, number>;
  color: string;
  dash: string | undefined;
}

const seriesMeta = computed<SeriesMeta[]>(() =>
  props.series.map((entry) => ({
    entry,
    values: valuesOf(entry),
    color: chartColors[entry.key],
    dash: chartDashes[entry.key],
  })),
);

function buildPath(meta: SeriesMeta, max: number): string {
  let path = "";
  let drawing = false;
  days.value.forEach((day, index) => {
    const value = meta.values.get(day);
    if (value === undefined) {
      drawing = false;
      return;
    }
    path += `${drawing ? "L" : "M"}${xOf(index).toFixed(1)},${yOf(value, max).toFixed(1)}`;
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

interface ChartGroup {
  unit: string;
  title: string;
  yMax: number;
  series: SeriesMeta[];
  paths: ChartPath[];
  yTicks: Array<{ value: number; y: number; label: string }>;
}

function chartTitle(unit: string): string {
  if (unit === "次") return "调用次数";
  if (unit === "Token") return "Token 用量";
  return unit.length > 0 ? `用量（${unit}）` : "用量";
}

/** 每个计量单位单独成图，避免数量级不同的数据共用一条纵轴。 */
const chartGroups = computed<ChartGroup[]>(() => {
  const units = [...new Set(props.series.map((entry) => entry.unit))];
  return units.map((unit) => {
    const series = seriesMeta.value.filter((meta) => meta.entry.unit === unit);
    let max = 0;
    for (const meta of series) for (const point of meta.entry.points) max = Math.max(max, point.v);
    const yMax = max <= 0 ? 1 : max;
    const paths = series.map((meta) => ({
      key: meta.entry.key,
      color: meta.color,
      dash: meta.dash,
      path: buildPath(meta, yMax),
    }));
    const steps = 4;
    const yTicks = Array.from({ length: steps + 1 }, (_, index) => {
      const value = (yMax / steps) * index;
      return { value, y: yOf(value, yMax), label: formatCompact(value) };
    });
    return { unit, title: chartTitle(unit), yMax, series, paths, yTicks };
  });
});

const maxLabelCount = 7;
const labelStep = computed(() => Math.max(1, Math.ceil(days.value.length / maxLabelCount)));

const xLabels = computed(() =>
  days.value
    .map((day, index) => ({ day, index }))
    .filter(({ index }) => index % labelStep.value === 0 || index === days.value.length - 1)
    .map(({ day, index }) => ({
      index,
      x: xOf(index),
      label: new Date(day).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
    })),
);

const activeByUnit = ref<Record<string, number>>({});
const activeKey = ref<UsageMetricKey | null>(null);

function setActive(unit: string, index: number | null): void {
  const next = { ...activeByUnit.value };
  if (index === null) delete next[unit];
  else next[unit] = index;
  activeByUnit.value = next;
}

interface TooltipRow {
  label: string;
  color: string;
  value: string;
}

interface ChartTooltip {
  day: number;
  x: number;
  rows: TooltipRow[];
}

interface ActiveDot {
  key: UsageMetricKey;
  color: string;
  x: number;
  y: number;
}

interface ChartView extends ChartGroup {
  activeIndex: number | null;
  tooltip: ChartTooltip | undefined;
  dots: ActiveDot[];
}

const chartViews = computed<ChartView[]>(() =>
  chartGroups.value.map((group) => {
    const stored = activeByUnit.value[group.unit];
    const activeIndex = stored !== undefined && stored >= 0 && stored < days.value.length ? stored : null;
    if (activeIndex === null) return { ...group, activeIndex, tooltip: undefined, dots: [] };
    const day = days.value[activeIndex];
    const rows: TooltipRow[] = [];
    const dots: ActiveDot[] = [];
    for (const meta of group.series) {
      const value = meta.values.get(day);
      if (value === undefined) continue;
      rows.push({ label: meta.entry.label, color: meta.color, value: `${formatNumber(value)} ${meta.entry.unit}` });
      dots.push({ key: meta.entry.key, color: meta.color, x: xOf(activeIndex), y: yOf(value, group.yMax) });
    }
    return {
      ...group,
      activeIndex,
      tooltip: { day, x: xOf(activeIndex), rows },
      dots,
    };
  }),
);

function nearestIndex(event: MouseEvent): number | null {
  const svg = event.currentTarget;
  if (!(svg instanceof SVGSVGElement) || days.value.length === 0) return null;
  const rect = svg.getBoundingClientRect();
  const scale = width / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const ratio = (x - padding.left) / plotWidth;
  if (ratio < -0.05 || ratio > 1.05) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.round(clamped * (days.value.length - 1));
}

function onMouseMove(event: MouseEvent, unit: string): void {
  setActive(unit, nearestIndex(event));
}

function onMouseLeave(unit: string): void {
  setActive(unit, null);
}

function onKeydown(event: KeyboardEvent, unit: string): void {
  if (days.value.length === 0) return;
  const current = activeByUnit.value[unit] ?? null;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const base = current === null ? (delta > 0 ? -1 : days.value.length) : current;
    setActive(unit, Math.min(days.value.length - 1, Math.max(0, base + delta)));
  } else if (event.key === "Home") {
    event.preventDefault();
    setActive(unit, 0);
  } else if (event.key === "End") {
    event.preventDefault();
    setActive(unit, days.value.length - 1);
  } else if (event.key === "Escape") {
    setActive(unit, null);
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
      <div class="line-chart-groups">
        <section v-for="group in chartViews" :key="group.unit" class="line-chart-group">
          <div class="line-chart-group-head">
            <span class="line-chart-group-title">{{ group.title }}</span>
            <span v-if="chartViews.length > 1" class="line-chart-scale">独立数轴</span>
          </div>

          <div
            class="line-chart-frame"
            tabindex="0"
            role="img"
            :aria-label="`${group.title}随时间变化的折线图，可用左右方向键浏览数据点`"
            @keydown="onKeydown($event, group.unit)"
            @mouseleave="onMouseLeave(group.unit)"
          >
            <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" class="line-chart-svg" @mousemove="onMouseMove($event, group.unit)">
              <g v-for="tick in group.yTicks" :key="tick.value" class="grid">
                <line :x1="padding.left" :x2="width - padding.right" :y1="tick.y" :y2="tick.y" />
                <text :x="padding.left - 8" :y="tick.y + 3" text-anchor="end" class="axis-text">{{ tick.label }}</text>
              </g>

              <g v-for="label in xLabels" :key="label.index">
                <line :x1="label.x" :x2="label.x" :y1="padding.top" :y2="padding.top + plotHeight" class="grid-faint" />
                <text :x="label.x" :y="height - 10" text-anchor="middle" class="axis-text">{{ label.label }}</text>
              </g>

              <path
                v-for="path in group.paths"
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

              <line
                v-if="group.tooltip !== undefined"
                :x1="group.tooltip.x"
                :x2="group.tooltip.x"
                :y1="padding.top"
                :y2="padding.top + plotHeight"
                class="cursor-line"
              />
              <circle
                v-for="dot in group.dots"
                :key="dot.key"
                :cx="dot.x"
                :cy="dot.y"
                r="3.5"
                :fill="dot.color"
                class="active-dot"
                :class="{ 'is-dimmed': activeKey !== null && activeKey !== dot.key }"
              />
            </svg>

            <div v-if="group.tooltip !== undefined" class="line-chart-tooltip" :style="{ left: `${(group.tooltip.x / width) * 100}%` }">
              <div class="tooltip-day mono">{{ new Date(group.tooltip.day).toLocaleDateString("zh-CN") }}</div>
              <div v-for="row in group.tooltip.rows" :key="row.label" class="tooltip-row">
                <i :style="{ background: row.color }"></i>
                <span>{{ row.label }}</span>
                <strong>{{ row.value }}</strong>
              </div>
            </div>
          </div>
        </section>
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
        <span class="legend-hint faint small">悬停指标高亮折线；悬停图表或用 ←→ 键查看数据点</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.line-chart-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.line-chart-group + .line-chart-group {
  padding-top: 16px;
  border-top: 1px solid var(--line);
}

.line-chart-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.line-chart-group-title {
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 600;
}

.line-chart-scale {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11px;
}

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
  transform: translateX(-50%);
  min-width: 148px;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  pointer-events: none;
  z-index: 2;
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
