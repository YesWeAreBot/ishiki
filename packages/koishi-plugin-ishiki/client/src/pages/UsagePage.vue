<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { formatDateTime, formatNumber, relativeTime } from "../lib/format";
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

const snapshot = ref<UsageSnapshot | undefined>(store.usage);
const scoped = ref(false);
const attempted = ref(false);
const loading = ref(false);
const errorText = ref("");
const lastFilters = ref<UsageFilters>({});

const range = ref<string>("all");
const customFrom = ref("");
const customTo = ref("");
const profileFilter = ref("all");
const modelFilter = ref("all");

watch(
  () => store.usage,
  (value) => {
    if (value !== undefined && !scoped.value) snapshot.value = value;
  },
);

const totals = computed(() => snapshot.value?.totals);
const byModel = computed(() => snapshot.value?.byModel ?? []);
const byDay = computed(() => snapshot.value?.byDay ?? []);
const quality = computed(() => snapshot.value?.quality ?? []);
const recordCount = computed(() => snapshot.value?.records.length ?? 0);
const syncedAt = computed(() => snapshot.value?.syncedAt);
const bootstrapped = computed(() => store.usage !== undefined || attempted.value);
const appliedCount = computed(() => Object.keys(lastFilters.value).length);

const profileIds = computed(() => {
  const ids = new Set(store.profiles.map((profile) => profile.id));
  for (const record of snapshot.value?.records ?? []) ids.add(record.profileId);
  return [...ids].sort();
});

const modelOptions = computed(() => {
  const labels = new Map<string, string>();
  for (const option of store.options) {
    if (option.kind === "model") labels.set(option.reference, option.label.length > 0 ? option.label : option.reference);
  }
  for (const row of byModel.value) {
    if (!labels.has(row.reference)) labels.set(row.reference, row.reference);
  }
  return [...labels.entries()].map(([reference, label]) => ({ reference, label })).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
});

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
  if (modelFilter.value !== "all") filters.model = modelFilter.value;
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
  modelFilter.value = "all";
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
      desc="用量账本记录每次模型调用的输入、输出、缓存与推理 token。页面只展示服务端汇总的数字与缺失原因，不把 token 换算成金额。"
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
              <span class="field-label">模型</span>
              <select v-model="modelFilter" class="select" :disabled="loading || modelOptions.length === 0">
                <option value="all">全部模型</option>
                <option v-for="option in modelOptions" :key="option.reference" :value="option.reference">{{ option.label }}</option>
              </select>
              <span v-if="modelOptions.length === 0" class="field-hint">还没有出现过调用的模型。</span>
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
            <span class="spacer"></span>
            <span class="muted small">缺失字段与推导来源按服务端判定原样列出。</span>
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

            <div class="metric-grid three" style="margin-top: 10px">
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
                <div class="panel-title">按模型汇总</div>
                <div class="panel-sub">调用次数与 token 均来自账本记录，按输入与输出之和降序。</div>
              </div>
              <div class="panel-actions">
                <span class="badge badge-outline">{{ byModel.length }} 个模型</span>
              </div>
            </div>
            <div class="table-wrap">
              <table class="table table-compact">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th class="num">调用</th>
                    <th class="num">输入</th>
                    <th class="num">输出</th>
                    <th class="num">缓存读取</th>
                    <th class="num">缓存写入</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in byModel" :key="row.reference">
                    <td class="mono">{{ row.reference }}</td>
                    <td class="num">{{ formatNumber(row.calls) }}</td>
                    <td class="num">{{ formatNumber(row.input) }}</td>
                    <td class="num">{{ formatNumber(row.output) }}</td>
                    <td class="num">{{ formatNumber(row.cacheRead) }}</td>
                    <td class="num">{{ formatNumber(row.cacheWrite) }}</td>
                  </tr>
                  <tr v-if="byModel.length === 0">
                    <td colspan="6" class="muted">所选范围内没有按模型汇总的数据。</td>
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
                <span class="badge badge-outline">{{ byDay.length }} 天</span>
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
                  <tr v-for="row in byDay" :key="row.day">
                    <td class="mono">{{ row.day }}</td>
                    <td class="num">{{ formatNumber(row.calls) }}</td>
                    <td class="num">{{ formatNumber(row.input) }}</td>
                    <td class="num">{{ formatNumber(row.output) }}</td>
                    <td class="num strong">{{ formatNumber(row.total) }}</td>
                  </tr>
                  <tr v-if="byDay.length === 0">
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
                <p class="empty-desc">可以放宽时间范围或清除 Profile / 模型筛选后再试。</p>
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

          <div class="notice notice-info">
            <Icon name="info" :size="15" />
            <span>
              <strong>口径说明</strong>
              调用次数等于账本记录条数；每次调用可能来自消息响应、轮次汇总或缺失回退，来源会体现在数据质量中。缓存读取与写入按服务端上报值展示，字段缺失的记录会进入数据质量，不能据此判断缓存是否命中。最近同步：{{
                formatDateTime(syncedAt)
              }}（{{ relativeTime(syncedAt) }}）。
            </span>
          </div>
        </template>
      </template>
    </div>
  </PageShell>
</template>

<style scoped>
.metric-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.day-scroll {
  max-height: 340px;
  overflow-y: auto;
}
</style>
