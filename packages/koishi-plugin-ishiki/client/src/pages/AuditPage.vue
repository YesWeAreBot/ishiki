<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { formatDateTime, formatNumber } from "../lib/format";
import { store, toast } from "../store";
import type { AuditFilters, AuditRecord, AuditSnapshot } from "../types";

type RangeKey = "all" | "24h" | "7d" | "30d" | "custom";

const rangeOptions: Array<{ value: RangeKey; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义区间" },
];

const limitOptions: Array<{ value: string; label: string }> = [
  { value: "default", label: "服务端默认" },
  { value: "50", label: "50 条" },
  { value: "100", label: "100 条" },
  { value: "200", label: "200 条" },
  { value: "500", label: "500 条" },
];

const kindLabels: Record<string, string> = {
  "turn.failed": "轮次失败",
  "turn.aborted": "轮次中断",
  "message.deleted": "消息删除",
  "profile.save": "Profile 保存",
  "profile.stop": "Profile 停止",
  "profile.remove": "Profile 删除",
  "models.save": "模型配置保存",
  "runtime.wake": "实例唤醒",
  "runtime.restart": "实例重启",
  "runtime.stop": "实例停止",
  "runtime.interrupt": "轮次中断",
};

const snapshot = ref<AuditSnapshot | undefined>(store.audit);
const scoped = ref(false);
const attempted = ref(false);
const loading = ref(false);
const errorText = ref("");
const lastFilters = ref<AuditFilters>({});

const range = ref<string>("all");
const customFrom = ref("");
const customTo = ref("");
const kindFilter = ref("all");
const profileFilter = ref("all");
const operatorFilter = ref("all");
const limit = ref("default");
const expanded = ref<Set<string>>(new Set<string>());

watch(
  () => store.audit,
  (value) => {
    if (value !== undefined && !scoped.value) snapshot.value = value;
  },
);

const records = computed(() => snapshot.value?.records ?? []);
const capacity = computed(() => snapshot.value?.capacity ?? 0);
const bootstrapped = computed(() => store.audit !== undefined || attempted.value);
const appliedCount = computed(() => Object.keys(lastFilters.value).length);

const kindOptions = computed(() => {
  const kinds = new Set<string>(Object.keys(kindLabels));
  for (const record of records.value) kinds.add(record.kind);
  return [...kinds].sort().map((kind) => ({ kind, label: kindLabels[kind] ?? kind }));
});

const profileIds = computed(() => {
  const ids = new Set(store.profiles.map((profile) => profile.id));
  for (const record of records.value) if (record.profileId !== undefined) ids.add(record.profileId);
  return [...ids].sort();
});

const operators = computed(() => {
  const names = new Set<string>();
  for (const record of records.value) names.add(record.operator);
  return [...names].sort((left, right) => left.localeCompare(right, "zh-CN"));
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

function buildFilters(): AuditFilters | undefined {
  const bounds = timeBounds();
  if (bounds === undefined) return undefined;
  const filters: AuditFilters = {};
  if (kindFilter.value !== "all") filters.kind = kindFilter.value;
  if (profileFilter.value !== "all") filters.profileId = profileFilter.value;
  if (operatorFilter.value !== "all") filters.operator = operatorFilter.value;
  if (bounds.from !== undefined) filters.from = bounds.from;
  if (bounds.to !== undefined) filters.to = bounds.to;
  if (limit.value !== "default") filters.limit = Number(limit.value);
  return filters;
}

async function run(filters: AuditFilters, silent: boolean): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await call<AuditSnapshot>("ishiki/observability/audit", filters);
    snapshot.value = result;
    scoped.value = Object.keys(filters).length > 0;
    lastFilters.value = filters;
    errorText.value = "";
    if (!silent) {
      toast(
        "success",
        "审计日志已更新",
        result.records.length === 0 ? "所选范围内没有记录。" : `显示 ${formatNumber(result.records.length)} 条，共 ${formatNumber(result.capacity)} 条。`,
      );
    }
  } catch (error) {
    errorText.value = describe(error);
    toast("error", "审计日志读取失败", errorText.value);
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
  kindFilter.value = "all";
  profileFilter.value = "all";
  operatorFilter.value = "all";
  limit.value = "default";
  await run({}, false);
}

function collapseAll(): void {
  expanded.value = new Set<string>();
}

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function isExpanded(id: string): boolean {
  return expanded.value.has(id);
}

function kindLabel(kind: string): string {
  return kindLabels[kind] ?? kind;
}

function resultLabel(record: AuditRecord): string {
  return record.result === "ok" ? "成功" : "失败";
}

function detailText(record: AuditRecord): string {
  if (record.detail === undefined) return "";
  try {
    return JSON.stringify(record.detail, null, 2);
  } catch {
    return "detail 无法序列化为 JSON。";
  }
}

onMounted(() => {
  if (store.audit === undefined) void run({}, true);
});
</script>

<template>
  <PageShell>
    <PageHeader
      title="审计日志"
      desc="唤醒、重启、停止、中断、Profile 与模型配置的变更都会写入审计日志。筛选在服务端执行，表格按时间倒序展示。"
      eyebrow="观测 / 审计"
    >
      <template #actions>
        <span v-if="snapshot !== undefined" class="badge badge-outline"> 共 {{ formatNumber(capacity) }} 条 </span>
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
              <span class="field-label">类型</span>
              <select v-model="kindFilter" class="select" :disabled="loading">
                <option value="all">全部类型</option>
                <option v-for="option in kindOptions" :key="option.kind" :value="option.kind">{{ option.label }}</option>
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
              <span class="field-label">操作者</span>
              <select v-model="operatorFilter" class="select" :disabled="loading || operators.length === 0">
                <option value="all">全部操作者</option>
                <option v-for="operator in operators" :key="operator" :value="operator">{{ operator }}</option>
              </select>
              <span v-if="operators.length === 0" class="field-hint">当前记录里还没有操作者。</span>
            </label>
          </div>

          <div class="form-grid three" style="margin-top: 12px">
            <label class="field">
              <span class="field-label">时间范围</span>
              <select v-model="range" class="select" :disabled="loading">
                <option v-for="option in rangeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">显示条数</span>
              <select v-model="limit" class="select" :disabled="loading">
                <option v-for="option in limitOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <div class="field">
              <span class="field-label">操作</span>
              <div class="row">
                <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="apply">应用筛选</button>
                <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="reset">重置</button>
              </div>
            </div>
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
        </div>
      </div>

      <div v-if="errorText.length > 0" class="error-panel">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <div class="strong">审计日志读取失败</div>
          <div class="mono">{{ errorText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh">重试</button>
      </div>

      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 5" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 58%"></div>
        </div>
      </div>

      <div v-else-if="snapshot === undefined" class="panel">
        <EmptyState title="审计数据尚不可用" desc="服务端还没有返回审计快照。确认控制台连接正常后重试，页面不会用示例记录填充。" icon="audit">
          <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh">重新读取</button>
        </EmptyState>
      </div>

      <div v-else-if="records.length === 0" class="panel">
        <EmptyState title="没有匹配的审计记录" desc="调整类型、Profile、操作者或时间范围后重试。审计记录只在服务端产生，页面不会生成占位条目。" icon="audit">
          <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="reset">重置筛选</button>
        </EmptyState>
      </div>

      <div v-else class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">审计记录</div>
            <div class="panel-sub">显示 {{ formatNumber(records.length) }} 条，容量 {{ formatNumber(capacity) }} 条。</div>
          </div>
          <div class="panel-actions">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="expanded.size === 0" @click="collapseAll">收起全部</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table table-compact">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>操作者</th>
                <th>摘要</th>
                <th>结果</th>
                <th>目标</th>
                <th class="num">Revision</th>
                <th>错误</th>
                <th class="actions">详情</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="record in records" :key="record.id">
                <tr :class="{ 'row-open': isExpanded(record.id) }">
                  <td class="nowrap">{{ formatDateTime(record.timestamp) }}</td>
                  <td>
                    <span class="badge badge-outline">{{ kindLabel(record.kind) }}</span>
                    <div class="kind mono">{{ record.kind }}</div>
                  </td>
                  <td class="mono">{{ record.operator }}</td>
                  <td class="summary-cell">{{ record.summary }}</td>
                  <td>
                    <span class="badge" :class="record.result === 'ok' ? 'badge-success' : 'badge-danger'">
                      {{ resultLabel(record) }}
                    </span>
                  </td>
                  <td class="mono target-cell">{{ record.target ?? "—" }}</td>
                  <td class="num mono">{{ record.revision ?? "—" }}</td>
                  <td class="error-cell">
                    <span v-if="record.error !== undefined" class="mono">{{ record.error }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="btn btn-icon btn-ghost btn-sm"
                      :aria-expanded="isExpanded(record.id)"
                      :title="isExpanded(record.id) ? '收起详情' : '展开详情'"
                      @click="toggle(record.id)"
                    >
                      <Icon :name="isExpanded(record.id) ? 'chevronDown' : 'chevron'" :size="14" />
                    </button>
                  </td>
                </tr>
                <tr v-if="isExpanded(record.id)" class="detail-row">
                  <td colspan="9" class="detail-cell">
                    <div v-if="record.detail !== undefined" class="detail-head">
                      <span class="mono">{{ record.id }}</span>
                      <span class="muted small">detail 原始 JSON</span>
                    </div>
                    <pre v-if="record.detail !== undefined" class="json-block">{{ detailText(record) }}</pre>
                    <div v-else class="muted small detail-empty">该记录没有附加 detail。</div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="notice notice-info">
        <Icon name="info" :size="15" />
        <span>
          审计日志由服务端按 JSONL 保存，查询结果按时间倒序并截断到所选条数。展开行显示 <span class="mono">detail</span> 的原始 JSON，
          不做字段重写。操作者、目标与 revision 直接取自记录本身。
        </span>
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.kind {
  margin-top: 3px;
  color: var(--faint);
  font-size: 10px;
}

.summary-cell {
  min-width: 220px;
  max-width: 400px;
  overflow-wrap: anywhere;
}

.target-cell {
  max-width: 220px;
  overflow-wrap: anywhere;
}

.error-cell {
  min-width: 120px;
  max-width: 260px;
  overflow-wrap: anywhere;
  font-size: 11px;
}

.detail-row:hover {
  background: transparent;
}

.detail-cell {
  padding: 0;
  background: var(--surface-inset);
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-top: 1px solid var(--line);
}

.detail-empty {
  padding: 12px;
  border-top: 1px solid var(--line);
}

.detail-cell .json-block {
  border-top: 1px solid var(--line);
  border-radius: 0;
}

.row-open td {
  background: var(--surface-inset);
}
</style>
