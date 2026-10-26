<script setup lang="ts">
import { computed, ref } from "vue";

import { formatCompact, formatNumber } from "../lib/format";
import type { UsageSeries } from "../lib/usageSeries";

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

const palette = ["var(--accent)", "var(--info)", "var(--warning)", "var(--danger)"];

const width = 900;
const padding = { top: 14, right: 18, bottom: 30, left: 62 };

const days = computed<number[]>(() => {
  const set = new Set<number>();
  for (const entry of props.series) for (const point of entry.points) set.add(point.t);
  return [...set].sort((left, right) => left - right);
});

const valuesOf = (entry: UsageSeries): Map<number, number> => new Map(entry.points.map((point) => [point.t, point.v]));

const yMax = computed(() => {
  let max = 0;
  for (const entry of props.series) for (const point of entry.points) max = Math.max(max, point.v);
  return max <= 0 ? 1 : max;
});

const plotWidth = width - padding.left - padding.right;
const plotHeight = computed(() => props.height - padding.top - padding.bottom);

const xOf = (index: number): number => {
  if (days.value.length <= 1) return padding.left + plotWidth / 2;
  return padding.left + (index / (days.value.length - 1)) * plotWidth;
};

const yOf = (value: number): number => padding.top + plotHeight.value - (value / yMax.value) * plotHeight.value;

const seriesMeta = computed(() => props.series.map((entry, index) => ({ entry, values: valuesOf(entry), color: palette[index % palette.length] })));

/** 相邻有数据的点连成一段；缺数据的日期断开。 */
const paths = computed(() =>
  seriesMeta.value.map(({ values }) => {
    let path = "";
    let drawing = false;
    days.value.forEach((day, index) => {
      const value = values.get(day);
      if (value === undefined) {
        drawing = false;
        return;
      }
      path += `${drawing ? "L" : "M"}${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`;
      drawing = true;
    });
    return path;
  }),
);

const yTicks = computed(() => {
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, index) => {
    const value = (yMax.value / steps) * index;
    return { value, y: yOf(value), label: formatCompact(value) };
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

const activeIndex = ref<number | null>(null);
const svgRef = ref<SVGSVGElement>();

const activeDots = computed(() => {
  const index = activeIndex.value;
  if (index === null) return [];
  const day = days.value[index];
  if (day === undefined) return [];
  return seriesMeta.value.filter((meta) => meta.values.has(day)).map((meta) => ({ color: meta.color, x: xOf(index), y: yOf(meta.values.get(day) ?? 0) }));
});

interface TooltipRow {
  label: string;
  color: string;
  value: string;
}

const tooltip = computed(() => {
  const index = activeIndex.value;
  if (index === null || index < 0 || index >= days.value.length) return undefined;
  const rows: TooltipRow[] = [];
  for (const meta of seriesMeta.value) {
    const value = meta.values.get(days.value[index]);
    if (value !== undefined) rows.push({ label: meta.entry.label, color: meta.color, value: `${formatNumber(value)} ${meta.entry.unit}` });
  }
  return {
    day: days.value[index],
    x: xOf(index),
    rows,
  };
});

function nearestIndex(event: MouseEvent): number | null {
  const svg = svgRef.value;
  if (svg === undefined || days.value.length === 0) return null;
  const rect = svg.getBoundingClientRect();
  const scale = width / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const ratio = (x - padding.left) / plotWidth;
  if (ratio < -0.05 || ratio > 1.05) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.round(clamped * (days.value.length - 1));
}

function onMouseMove(event: MouseEvent): void {
  activeIndex.value = nearestIndex(event);
}

function onMouseLeave(): void {
  activeIndex.value = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (days.value.length === 0) return;
  const current = activeIndex.value;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const base = current === null ? (delta > 0 ? -1 : days.value.length) : current;
    activeIndex.value = Math.min(days.value.length - 1, Math.max(0, base + delta));
  } else if (event.key === "Home") {
    event.preventDefault();
    activeIndex.value = 0;
  } else if (event.key === "End") {
    event.preventDefault();
    activeIndex.value = days.value.length - 1;
  } else if (event.key === "Escape") {
    activeIndex.value = null;
  }
}

const hasData = computed(() => props.series.some((entry) => entry.points.length > 0));

const legend = computed(() => seriesMeta.value.map(({ entry, color }) => ({ label: entry.label, unit: entry.unit, color })));
</script>

<template>
  <div class="line-chart">
    <div v-if="!hasData" class="line-chart-empty muted small">当前指标在所选范围内没有数据点。</div>
    <template v-else>
      <div
        class="line-chart-frame"
        tabindex="0"
        role="img"
        :aria-label="`${legend.map((item) => item.label).join('、')}随时间变化的折线图，可用左右方向键浏览数据点`"
        @keydown="onKeydown"
        @mouseleave="onMouseLeave"
      >
        <svg ref="svgRef" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" class="line-chart-svg" @mousemove="onMouseMove">
          <g v-for="tick in yTicks" :key="tick.value" class="grid">
            <line :x1="padding.left" :x2="width - padding.right" :y1="tick.y" :y2="tick.y" />
            <text :x="padding.left - 8" :y="tick.y + 3" text-anchor="end" class="axis-text">{{ tick.label }}</text>
          </g>

          <g v-for="label in xLabels" :key="label.index">
            <line :x1="label.x" :x2="label.x" :y1="padding.top" :y2="padding.top + plotHeight" class="grid-faint" />
            <text :x="label.x" :y="height - 10" text-anchor="middle" class="axis-text">{{ label.label }}</text>
          </g>

          <path v-for="(path, index) in paths" :key="seriesMeta[index]?.entry.key" :d="path" fill="none" :stroke="seriesMeta[index]?.color" stroke-width="2" />

          <line v-if="tooltip !== undefined" :x1="tooltip.x" :x2="tooltip.x" :y1="padding.top" :y2="padding.top + plotHeight" class="cursor-line" />
          <circle v-for="(dot, index) in activeDots" :key="index" :cx="dot.x" :cy="dot.y" r="3.5" :fill="dot.color" />
        </svg>

        <div v-if="tooltip !== undefined" class="line-chart-tooltip" :style="{ left: `${(tooltip.x / width) * 100}%` }">
          <div class="tooltip-day mono">{{ new Date(tooltip.day).toLocaleDateString("zh-CN") }}</div>
          <div v-for="row in tooltip.rows" :key="row.label" class="tooltip-row">
            <i :style="{ background: row.color }"></i>
            <span>{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </div>
        </div>
      </div>

      <div class="line-chart-legend">
        <span v-for="item in legend" :key="item.label">
          <i :style="{ background: item.color }"></i>
          {{ item.label }}（{{ item.unit }}）
        </span>
        <span class="faint small">悬停或用 ←→ 键查看数据点</span>
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
  border-radius: 0;
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
  font-size: 10px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.cursor-line {
  stroke: var(--line-strong);
  stroke-width: 1;
}

.line-chart-tooltip {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  min-width: 148px;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 0;
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  pointer-events: none;
}

.tooltip-day {
  color: var(--muted);
  font-size: 10.5px;
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
  gap: 6px 14px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 10.5px;
}

.line-chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.line-chart-empty {
  padding: 28px 12px;
  text-align: center;
}
</style>
