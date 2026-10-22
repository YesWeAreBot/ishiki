<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import { formatCompact, formatNumber, formatPercent, relativeTime } from "../lib/format";
import { aggregateUsage, navigate, store } from "../store";

const range = ref<"24h" | "7d" | "all">("7d");
const profileFilter = ref("all");
const modelFilter = ref("all");
const loading = ref(true);

onMounted(() => {
  window.setTimeout(() => {
    loading.value = false;
  }, 420);
});

const rangeStart = computed(() => {
  if (range.value === "24h") return store.now - 24 * 60 * 60 * 1000;
  if (range.value === "7d") return store.now - 7 * 24 * 60 * 60 * 1000;
  return 0;
});

const ranges = [
  { value: "24h" as const, label: "近 24 小时" },
  { value: "7d" as const, label: "近 7 天" },
  { value: "all" as const, label: "全部" },
];

const profileIds = computed(() => [...new Set(store.usageRecords.map((record) => record.profileId))].sort());
const modelRefs = computed(() => [...new Set(store.usageRecords.map((record) => record.reference))].sort());

const filtered = computed(() =>
  store.usageRecords.filter((record) => {
    if (record.timestamp < rangeStart.value) return false;
    if (profileFilter.value !== "all" && record.profileId !== profileFilter.value) return false;
    if (modelFilter.value !== "all" && record.reference !== modelFilter.value) return false;
    return true;
  }),
);

const totals = computed(() => aggregateUsage(filtered.value));
const recorded = computed(() => filtered.value.filter((record) => record.source === "recorded"));
const latest = computed(() => filtered.value.reduce((max, record) => Math.max(max, record.timestamp), 0));
const hasRecords = computed(() => filtered.value.length > 0);

const byModel = computed(() => {
  const map = new Map<
    string,
    {
      reference: string;
      calls: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      total: number;
      unavailable: number;
    }
  >();
  for (const record of recorded.value) {
    const row = map.get(record.reference) ?? {
      reference: record.reference,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      unavailable: 0,
    };
    row.calls += 1;
    row.input += record.input;
    row.output += record.output;
    row.cacheRead += record.cacheRead;
    row.cacheWrite += record.cacheWrite;
    row.reasoning += record.reasoning;
    row.total += record.total;
    if (!record.cacheReported) row.unavailable += 1;
    map.set(record.reference, row);
  }
  return [...map.values()].sort((left, right) => right.total - left.total);
});

const maxInput = computed(() => Math.max(1, ...byModel.value.map((row) => row.input)));

const byProfile = computed(() => {
  const map = new Map<string, { profileId: string; calls: number; total: number; input: number; cacheRead: number; missing: number }>();
  for (const record of filtered.value) {
    const row = map.get(record.profileId) ?? { profileId: record.profileId, calls: 0, total: 0, input: 0, cacheRead: 0, missing: 0 };
    if (record.source === "missing") row.missing += 1;
    else {
      row.calls += 1;
      row.total += record.total;
      row.input += record.input;
      row.cacheRead += record.cacheRead;
    }
    map.set(record.profileId, row);
  }
  return [...map.values()].sort((left, right) => right.total - left.total);
});

const qualityFor = computed(() => new Map(store.dataQuality.map((row) => [row.profileId, row])));
const empty = computed(() => !loading.value && filtered.value.length === 0);
const callsPerProfile = computed(() => byProfile.value.reduce((sum, row) => sum + row.calls, 0));
const cacheRate = computed(() => (totals.value.input === 0 ? null : totals.value.cacheRead / totals.value.input));

function qualityLabel(state: string): string {
  if (state === "recorded") return "完整";
  if (state === "partial") return "部分缺失";
  if (state === "missing") return "已停止";
  return "读取失败";
}

function qualityTone(state: string): string {
  if (state === "recorded") return "badge-success";
  if (state === "partial") return "badge-warning";
  if (state === "missing") return "badge-neutral";
  return "badge-danger";
}

function resetFilters(): void {
  range.value = "7d";
  profileFilter.value = "all";
  modelFilter.value = "all";
}
</script>

<template>
  <PageHeader
    title="用量"
    desc="按 Profile、模型与时间范围汇总 assistant 消息中记录的 usage。缺失的 usage 不按 0 计入，并在数据质量中单独标注。"
    eyebrow="观测 / 用量"
  >
    <template #actions>
      <button type="button" class="btn" @click="navigate('/cost')"><Icon name="cost" :size="15" /> 查看成本</button>
    </template>
  </PageHeader>

  <div class="panel" style="margin-bottom: 16px">
    <div class="panel-body" style="padding: 13px 16px">
      <div class="row row-wrap">
        <div class="segmented" role="group" aria-label="时间范围">
          <button v-for="item in ranges" :key="item.value" type="button" :aria-pressed="range === item.value" @click="range = item.value">
            {{ item.label }}
          </button>
        </div>
        <select v-model="profileFilter" class="select" aria-label="按 Profile 筛选" style="width: 150px">
          <option value="all">全部 Profile</option>
          <option v-for="id in profileIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <select v-model="modelFilter" class="select" aria-label="按模型筛选" style="width: 220px">
          <option value="all">全部模型</option>
          <option v-for="reference in modelRefs" :key="reference" :value="reference">{{ reference }}</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm" @click="resetFilters">重置</button>
        <span class="spacer"></span>
        <span class="field-hint">最后活动 {{ relativeTime(latest === 0 ? undefined : latest) }}</span>
      </div>
    </div>
  </div>

  <div v-if="loading" class="metric-grid" style="margin-bottom: 16px">
    <div v-for="index in 4" :key="index" class="metric">
      <div class="skeleton skeleton-line" style="width: 40%"></div>
      <div class="skeleton" style="height: 26px; width: 62%; margin-top: 8px"></div>
    </div>
  </div>
  <div v-else class="metric-grid" style="margin-bottom: 16px">
    <div class="metric">
      <div class="metric-label">输入 tokens <span class="badge badge-outline">input</span></div>
      <div class="metric-value">{{ hasRecords ? formatCompact(totals.input) : "无记录" }}</div>
      <div class="metric-note">{{ hasRecords ? `${formatNumber(totals.input)} tokens · ${totals.calls} 次调用累加` : "当前时间范围没有调用" }}</div>
    </div>
    <div class="metric">
      <div class="metric-label">输出 tokens <span class="badge badge-outline">output</span></div>
      <div class="metric-value">{{ hasRecords ? formatCompact(totals.output) : "无记录" }}</div>
      <div class="metric-note">{{ hasRecords ? `推理 ${formatCompact(totals.reasoning)} tokens` : "当前时间范围没有调用" }}</div>
    </div>
    <div class="metric">
      <div class="metric-label">缓存读取 <span class="badge badge-outline">cache read</span></div>
      <div class="metric-value">{{ hasRecords ? formatCompact(totals.cacheRead) : "无记录" }}</div>
      <div class="metric-note">{{ hasRecords ? `占输入 ${cacheRate === null ? "—" : formatPercent(cacheRate)}` : "当前时间范围没有调用" }}</div>
    </div>
    <div class="metric">
      <div class="metric-label">调用次数</div>
      <div class="metric-value">{{ hasRecords ? formatNumber(totals.calls) : "无记录" }}</div>
      <div class="metric-note">
        <span v-if="hasRecords" :style="{ color: totals.missing > 0 ? 'var(--warning-ink)' : undefined }">缺失 usage {{ totals.missing }} 条</span>
        <span v-else>没有可统计的调用</span>
      </div>
    </div>
  </div>

  <div v-if="empty" class="panel">
    <EmptyState
      title="当前筛选没有记录"
      desc="时间范围、Profile 或模型组合没有已记录的 usage。会把「没有记录」与「数值为零」分开呈现，不会把缺失数据当成 0。"
      icon="usage"
    >
      <button type="button" class="btn btn-soft" @click="resetFilters">重置筛选</button>
    </EmptyState>
  </div>

  <div v-else class="stack">
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">按模型</div>
          <div class="panel-sub">按输入与输出 tokens 合计排序；条宽按输入 tokens 归一化。</div>
        </div>
        <div class="panel-actions">
          <div class="legend">
            <span><i></i>输入</span>
            <span><i style="background: var(--info)"></i>缓存读取</span>
          </div>
        </div>
      </div>
      <div class="panel-body">
        <div v-if="byModel.length === 0" class="empty" style="padding: 24px">
          <div class="empty-title">没有已记录的调用</div>
          <p class="empty-desc">当前筛选只包含缺失 usage 的记录；这些记录无法参与 token 汇总。</p>
        </div>
        <div v-else class="stack-sm">
          <div v-for="row in byModel" :key="row.reference" class="bar-row">
            <span class="bar-label" :title="row.reference">{{ row.reference }}</span>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: `${Math.max(2, (row.input / maxInput) * 100)}%` }"></div>
            </div>
            <span class="bar-value">{{ formatCompact(row.input) }}</span>
          </div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table table-compact">
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" class="num">调用</th>
              <th scope="col" class="num">输入</th>
              <th scope="col" class="num">输出</th>
              <th scope="col" class="num">缓存读取</th>
              <th scope="col" class="num">缓存写入</th>
              <th scope="col" class="num">推理</th>
              <th scope="col" class="num">合计</th>
              <th scope="col">缓存明细</th>
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
              <td class="num">{{ formatNumber(row.reasoning) }}</td>
              <td class="num strong">{{ formatNumber(row.total) }}</td>
              <td>
                <span v-if="row.unavailable > 0" class="badge badge-warning">provider 未提供</span>
                <span v-else class="badge badge-success">已提供</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-grid">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">按 Profile</div>
          <div class="panel-actions">
            <span class="panel-sub">{{ callsPerProfile }} 次已记录调用</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table table-compact">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col" class="num">调用</th>
                <th scope="col" class="num">tokens</th>
                <th scope="col" class="num">缓存命中</th>
                <th scope="col">采集状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in byProfile" :key="row.profileId">
                <td class="mono">{{ row.profileId }}</td>
                <td class="num">{{ formatNumber(row.calls) }}</td>
                <td class="num">{{ formatNumber(row.total) }}</td>
                <td class="num">{{ row.input === 0 ? "—" : formatPercent(row.cacheRead / row.input) }}</td>
                <td>
                  <span class="badge" :class="qualityTone(qualityFor.get(row.profileId)?.state ?? 'recorded')">
                    {{ qualityLabel(qualityFor.get(row.profileId)?.state ?? "recorded") }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">数据质量</div></div>
        <div class="panel-body">
          <div class="quality-list">
            <div v-for="row in store.dataQuality" :key="row.profileId" class="quality-row">
              <Icon
                :name="row.state === 'recorded' ? 'checkCircle' : row.state === 'partial' ? 'warningCircle' : row.state === 'missing' ? 'info' : 'xCircle'"
                :size="15"
              />
              <div>
                <div class="row" style="gap: 6px">
                  <span class="quality-title">{{ row.label }}</span>
                  <span class="badge" :class="qualityTone(row.state)">{{ qualityLabel(row.state) }}</span>
                </div>
                <div class="quality-note">{{ row.note }}</div>
              </div>
            </div>
          </div>
          <div class="notice" style="margin-top: 12px">
            <Icon name="info" :size="14" />
            <span>数值为零表示已采集且确实为零；「无记录」表示时间范围内没有调用；「缺失」表示消息没有 usage；读取失败会单独标出。</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
