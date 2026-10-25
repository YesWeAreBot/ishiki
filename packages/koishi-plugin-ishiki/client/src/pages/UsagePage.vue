<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import ExpandableText from "../components/ExpandableText.vue";
import Icon from "../components/Icon.vue";
import LineChart from "../components/LineChart.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { classifyReference, entityBadge, entityLabel } from "../lib/entities";
import { formatDateTime, formatNumber } from "../lib/format";
import { bucketUsageByDay, USAGE_METRICS, type UsageMetricKey } from "../lib/usageSeries";
import { store, toast } from "../store";
import type { UsageFilters, UsageSnapshot } from "../types";

type RangeKey = "all" | "24h" | "7d" | "30d" | "custom";

const rangeOptions: Array<{ value: RangeKey; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义区间" },
];

const DEFAULT_METRICS: UsageMetricKey[] = ["calls", "input", "output"];

const snapshot = ref<UsageSnapshot | undefined>(store.usage);
const scoped = ref(false);
const attempted = ref(false);
const loading = ref(false);
const errorText = ref("");
const lastFilters = ref<UsageFilters>({});
const selectedMetrics = ref<UsageMetricKey[]>([...DEFAULT_METRICS]);

const range = ref<string>("all");
const customFrom = ref("");
const customTo = ref("");
const profileFilter = ref("all");
const targetFilter = ref("all");

watch(
  () => store.usage,
  (value) => {
    if (value !== undefined && !scoped.value) snapshot.value = value;
  },
);

const totals = computed(() => snapshot.value?.totals);
const byModel = computed(() => snapshot.value?.byModel ?? []);
const quality = computed(() => snapshot.value?.quality ?? []);
const records = computed(() => snapshot.value?.records ?? []);
const recordCount = computed(() => snapshot.value?.records.length ?? 0);
const syncedAt = computed(() => snapshot.value?.syncedAt);
const bootstrapped = computed(() => store.usage !== undefined || attempted.value);
const appliedCount = computed(() => Object.keys(lastFilters.value).length);

const profileIds = computed(() => {
  const ids = new Set(store.profiles.map((profile) => profile.id));
  for (const record of snapshot.value?.records ?? []) ids.add(record.profileId);
  return [...ids].sort();
});

/**
 * 统计对象 = 具体模型 + 模型组 + 缺少映射的历史引用，三者明确分开；
 * 模型组名不作为模型名展示，缺映射的引用保留原值并标记。
 */
const entityOptions = computed<Array<{ reference: string; kind: "model" | "group" | "unmapped"; label: string }>>(() => {
  const references = new Set<string>();
  for (const option of store.options) references.add(option.reference);
  for (const row of byModel.value) references.add(row.reference);
  const kindOrder = { model: 0, group: 1, unmapped: 2 } as const;
  return [...references]
    .map((reference) => {
      const entity = classifyReference(reference, store.providers, store.groups);
      return { reference, kind: entity.kind, label: entityLabel(entity) };
    })
    .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.reference.localeCompare(right.reference));
});

const entityGroups = computed(() => [
  { key: "model" as const, label: "模型", items: entityOptions.value.filter((item) => item.kind === "model") },
  { key: "group" as const, label: "模型组", items: entityOptions.value.filter((item) => item.kind === "group") },
  { key: "unmapped" as const, label: "缺少映射", items: entityOptions.value.filter((item) => item.kind === "unmapped") },
]);

function badgeOf(reference: string): { label: string; tone: string } {
  return entityBadge(classifyReference(reference, store.providers, store.groups));
}

const chartSeries = computed(() => bucketUsageByDay(records.value, selectedMetrics.value));

function toggleMetric(key: UsageMetricKey): void {
  const current = selectedMetrics.value;
  selectedMetrics.value = current.includes(key)
    ? current.filter((item) => item !== key)
    : USAGE_METRICS.filter((metric) => current.includes(metric.key) || metric.key === key).map((metric) => metric.key);
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function timeBounds(): { from?: number; to?: number } | undefined {
  if (range.value === "all") return {};
  if (range.value !== "custom") {
    const days = range.value === "24h" ? 1 : range.value === "7d" ? 7 : 30;
    return { from: Date.now() - days * 86_400_000 };
  }
  const from = customFrom.value.length > 0 ? Date.parse(customFrom.value) : undefined;
  const to = customTo.value.length > 0 ? Date.parse(customTo.value) : undefined;
  if (from !== undefined && Number.isNaN(from)) {
    toast("error", "开始时间无效", "请选择有效的开始时间。");
    return undefined;
  }
  if (to !== undefined && Number.isNaN(to)) {
    toast("error", "结束时间无效", "请选择有效的结束时间。");
    return undefined;
  }
  if (from !== undefined && to !== undefined && from > to) {
    toast("error", "时间区间倒置", "开始时间晚于结束时间。");
    return undefined;
  }
  const bounds: { from?: number; to?: number } = {};
  if (from !== undefined) bounds.from = from;
  if (to !== undefined) bounds.to = to;
  return bounds;
}

function buildFilters(): UsageFilters | undefined {
  const bounds = timeBounds();
  if (bounds === undefined) return undefined;
  const filters: UsageFilters = {};
  if (profileFilter.value !== "all") filters.profileId = profileFilter.value;
  if (targetFilter.value !== "all") filters.model = targetFilter.value;
  if (bounds.from !== undefined) filters.from = bounds.from;
  if (bounds.to !== undefined) filters.to = bounds.to;
  return filters;
}

async function run(filters: UsageFilters, silent: boolean): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await call<UsageSnapshot>("ishiki/observability/usage", filters);
    snapshot.value = result;
    scoped.value = Object.keys(filters).length > 0;
    lastFilters.value = filters;
    errorText.value = "";
    if (!silent) {
      toast(
        "success",
        "用量已更新",
        result.records.length === 0
          ? "所选范围内没有记录。"
          : `${formatNumber(result.records.length)} 条记录，合计 ${formatNumber(result.totals.total)} token。`,
      );
    }
  } catch (error) {
    errorText.value = describe(error);
    toast("error", "用量读取失败", errorText.value);
  } finally {
    loading.value = false;
    attempted.value = true;
  }
}

async function apply(): Promise<void> {
  const filters = buildFilters();
  if (filters === undefined) return;
  await run(filters, false);
}

async function refresh(): Promise<void> {
  const filters = buildFilters();
  if (filters === undefined) return;
  await run(filters, false);
}

async function reset(): Promise<void> {
  range.value = "all";
  customFrom.value = "";
  customTo.value = "";
  profileFilter.value = "all";
  targetFilter.value = "all";
  await run({}, false);
}

onMounted(() => {
  if (store.usage === undefined) void run({}, true);
});
</script>

<template>
  <PageShell>
    <PageHeader
      title="用量统计"
      desc="用量账本记录每次模型调用的输入、输出、缓存与推理 token。图表与汇总来自原始用量记录，模型组与具体模型分开统计。"
      eyebrow="观测 / 用量"
    >
      <template #actions>
        <span v-if="snapshot !== undefined" class="badge badge-outline"> 同步于 {{ formatDateTime(snapshot.syncedAt) }} </span>
        <span v-if="appliedCount > 0" class="badge badge-info">{{ appliedCount }} 项筛选</span>
        <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh">
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="14" />
          刷新
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <div class="panel">
        <div class="panel-body">
          <div class="form-grid three">
            <label class="field">
              <span class="field-label">时间范围</span>
              <select v-model="range" class="select" :disabled="loading">
                <option v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Profile</span>
              <select v-model="profileFilter" class="select" :disabled="loading || profileIds.length === 0">
                <option value="all">全部 Profile</option>
                <option v-for="id in profileIds" :key="id" :value="id">{{ id }}</option>
              </select>
              <span v-if="profileIds.length === 0" class="field-hint">还没有可用的 Profile。</span>
            </label>
            <label class="field">
              <span class="field-label">统计对象</span>
              <select v-model="targetFilter" class="select" :disabled="loading || entityOptions.length === 0">
                <option value="all">全部模型与模型组</option>
                <optgroup v-for="group in entityGroups" :key="group.key" :label="group.label">
                  <option v-for="item in group.items" :key="item.reference" :value="item.reference">{{ item.label }}</option>
                </optgroup>
              </select>
              <span v-if="entityOptions.length === 0" class="field-hint">还没有出现过调用的模型或模型组。</span>
            </label>
          </div>

          <div v-if="range === 'custom'" class="form-grid" style="margin-top: 12px">
            <label class="field">
              <span class="field-label">开始时间</span>
              <input v-model="customFrom" class="input" type="datetime-local" step="1" :disabled="loading" />
            </label>
            <label class="field">
              <span class="field-label">结束时间</span>
              <input v-model="customTo" class="input" type="datetime-local" step="1" :disabled="loading" />
            </label>
          </div>

          <div class="row row-wrap" style="margin-top: 12px">
            <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="apply">应用筛选</button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="reset">重置</button>
          </div>
        </div>
      </div>

      <div v-if="errorText.length > 0" class="error-panel">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <div class="strong">用量读取失败</div>
          <div class="mono">{{ errorText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh">重试</button>
      </div>

      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 4" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 64%"></div>
        </div>
      </div>

      <template v-else>
        <div v-if="snapshot === undefined" class="panel">
          <EmptyState title="用量数据尚不可用" desc="服务端还没有返回用量快照。确认控制台连接正常后重试，页面不会用示例数字填充。" icon="usage">
            <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh">重新读取</button>
          </EmptyState>
        </div>

        <template v-else>
          <div v-if="totals !== undefined">
            <div class="metric-grid">
              <div class="metric">
                <div class="metric-label"><Icon name="arrowDown" :size="13" /> 输入 token</div>
                <div class="metric-value">{{ formatNumber(totals.input) }}</div>
                <div class="metric-note">prompt 侧用量</div>
              </div>
              <div class="metric">
                <div class="metric-label"><Icon name="arrowUp" :size="13" /> 输出 token</div>
                <div class="metric-value">{{ formatNumber(totals.output) }}</div>
                <div class="metric-note">completion 侧用量</div>
              </div>
              <div class="metric">
                <div class="metric-label"><Icon name="memory" :size="13" /> 缓存读取</div>
                <div class="metric-value">{{ formatNumber(totals.cacheRead) }}</div>
                <div class="metric-note">仅在已上报时可信</div>
              </div>
              <div class="metric">
                <div class="metric-label"><Icon name="memory" :size="13" /> 缓存写入</div>
                <div class="metric-value">{{ formatNumber(totals.cacheWrite) }}</div>
                <div class="metric-note">仅在已上报时可信</div>
              </div>
            </div>

            <div class="metric-grid three usage-metric-second" style="margin-top: 10px">
              <div class="metric">
                <div class="metric-label"><Icon name="pulse" :size="13" /> 推理 token</div>
                <div class="metric-value">{{ formatNumber(totals.reasoning) }}</div>
                <div class="metric-note">reasoning 用量</div>
              </div>
              <div class="metric">
                <div class="metric-label"><Icon name="usage" :size="13" /> 合计 token</div>
                <div class="metric-value">{{ formatNumber(totals.total) }}</div>
                <div class="metric-note">服务端记录的总量</div>
              </div>
              <div class="metric">
                <div class="metric-label"><Icon name="pulse" :size="13" /> 调用次数</div>
                <div class="metric-value">{{ formatNumber(totals.calls) }}</div>
                <div class="metric-note">{{ formatNumber(recordCount) }} 条用量记录</div>
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">时间序列</div>
                <div class="panel-sub">按天汇总原始用量记录；点击指标增减曲线，悬停或用方向键查看具体数据点。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ records.length }} 条记录</span>
              </div>
            </div>
            <div class="panel-body">
              <div v-if="recordCount === 0" class="empty" style="padding: 28px 12px">
                <div class="empty-title">所选范围内没有用量记录</div>
                <p class="empty-desc">放宽时间范围或清除筛选后再试。</p>
                <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="reset">重置筛选</button>
              </div>
              <template v-else>
                <div class="chip-set" role="group" aria-label="选择图表指标" style="margin-bottom: 14px">
                  <button
                    v-for="metric in USAGE_METRICS"
                    :key="metric.key"
                    type="button"
                    class="chip-toggle"
                    :aria-pressed="selectedMetrics.includes(metric.key)"
                    @click="toggleMetric(metric.key)"
                  >
                    {{ metric.label }}（{{ metric.unit }}）
                  </button>
                </div>
                <LineChart :series="chartSeries" />
              </template>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">按统计对象汇总</div>
                <div class="panel-sub">模型组按组维度聚合，具体模型按模型引用聚合；缺少映射的引用原样列出。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ byModel.length }} 个对象</span>
              </div>
            </div>
            <div class="table-wrap">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>对象</th>
                    <th class="num">调用</th>
                    <th class="num">输入</th>
                    <th class="num">输出</th>
                    <th class="num">缓存读取</th>
                    <th class="num">缓存写入</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in byModel" :key="row.reference">
                    <td>
                      <span class="badge" :class="badgeOf(row.reference).tone">{{ badgeOf(row.reference).label }}</span>
                    </td>
                    <td>
                      <ExpandableText :value="row.reference" mode="ends" mono copy-label="对象引用" />
                    </td>
                    <td class="num">{{ formatNumber(row.calls) }}</td>
                    <td class="num">{{ formatNumber(row.input) }}</td>
                    <td class="num">{{ formatNumber(row.output) }}</td>
                    <td class="num">{{ formatNumber(row.cacheRead) }}</td>
                    <td class="num">{{ formatNumber(row.cacheWrite) }}</td>
                  </tr>
                  <tr v-if="byModel.length === 0">
                    <td colspan="7" class="muted">所选范围内没有按对象汇总的数据。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">按天汇总</div>
                <div class="panel-sub">日期按 UTC 归并，与服务端账本口径一致。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ snapshot.byDay.length }} 天</span>
              </div>
            </div>
            <div class="table-wrap day-scroll">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th class="num">调用</th>
                    <th class="num">输入</th>
                    <th class="num">输出</th>
                    <th class="num">合计</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in snapshot.byDay" :key="row.day">
                    <td class="mono">{{ row.day }}</td>
                    <td class="num">{{ formatNumber(row.calls) }}</td>
                    <td class="num">{{ formatNumber(row.input) }}</td>
                    <td class="num">{{ formatNumber(row.output) }}</td>
                    <td class="num strong">{{ formatNumber(row.total) }}</td>
                  </tr>
                  <tr v-if="snapshot.byDay.length === 0">
                    <td colspan="5" class="muted">所选范围内没有按天汇总的数据。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">数据质量</div>
                <div class="panel-sub">缺失或推导的原因原样展示，页面不会补齐缓存字段，也不会估算金额。</div>
              </div>
              <div class="panel-actions">
                <span class="badge" :class="quality.length > 0 ? 'badge-warning' : 'badge-outline'"> {{ quality.length }} 类标记 </span>
              </div>
            </div>
            <div class="panel-body">
              <div v-if="recordCount === 0" class="empty" style="padding: 24px 12px">
                <div class="empty-title">所选范围内没有用量记录</div>
                <p class="empty-desc">可以放宽时间范围或清除 Profile / 统计对象筛选后再试。</p>
                <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="reset">重置筛选</button>
              </div>
              <div v-else-if="quality.length === 0" class="muted small">所选范围内没有触发数据质量标记。</div>
              <div v-else class="quality-list">
                <div v-for="row in quality" :key="row.reason" class="quality-row">
                  <Icon name="warningCircle" :size="14" />
                  <div>
                    <div class="quality-title">{{ row.reason }}</div>
                    <div class="quality-note">{{ formatNumber(row.count) }} 条记录带有该标记</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </template>
    </div>
  </PageShell>
</template>

<style scoped>
.usage-metric-second {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.day-scroll {
  max-height: 340px;
  overflow-y: auto;
}
</style>
