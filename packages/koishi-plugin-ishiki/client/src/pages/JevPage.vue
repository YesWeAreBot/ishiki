<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { ApiError, call } from "../api";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import { formatDateTime, formatNumber, relativeTime } from "../lib/format";
import { store, toast } from "../store";
import type { JevDecisionView, JevSnapshot } from "../types";

type BooleanKey = "ready" | "receptive" | "worthwhile" | "social" | "withdrawn" | "closed" | "interested";

const RELATION_LABELS: Record<string, string> = {
  addressed: "对机器人说",
  followup: "延续对话",
  open: "公开讨论",
  other: "对别人说",
  ambient: "普通闲聊",
};

const BOOLEAN_ROWS: Array<{ key: BooleanKey; label: string; hint: string }> = [
  { key: "ready", label: "说完了", hint: "对方这句话是否完整" },
  { key: "receptive", label: "可插话", hint: "此刻插入是否自然" },
  { key: "worthwhile", label: "信息价值", hint: "能否提供实质内容" },
  { key: "social", label: "社交理由", hint: "是否有具体的玩梗或共情理由" },
  { key: "withdrawn", label: "已取消", hint: "对方是否让你别说" },
  { key: "closed", label: "已结束", hint: "这段对话是否收尾" },
  { key: "interested", label: "命中兴趣", hint: "话题是否匹配配置兴趣" },
];

const snapshot = ref<JevSnapshot | undefined>(store.jev);
const loading = ref(false);
const attempted = ref(false);
const errorText = ref("");

watch(
  () => store.jev,
  (value) => {
    if (value !== undefined) snapshot.value = value;
  },
);

const decisions = computed(() => snapshot.value?.decisions ?? []);
const bootstrapped = computed(() => store.jev !== undefined || attempted.value);

const counts = computed(() => {
  let reply = 0;
  let join = 0;
  let wait = 0;
  for (const item of decisions.value) {
    if (item.error !== undefined) continue;
    if (item.mode === "reply") reply += 1;
    else if (item.mode === "join") join += 1;
    else wait += 1;
  }
  return { reply, join, wait };
});

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function modeMeta(item: JevDecisionView): { tone: string; label: string } {
  if (item.error !== undefined) return { tone: "badge-danger", label: "调用失败" };
  if (item.mode === "reply") return { tone: "badge-success", label: "回复" };
  if (item.mode === "join") return { tone: "badge-warning", label: "主动加入" };
  return { tone: "badge-neutral", label: "保持沉默" };
}

function relationRows(item: JevDecisionView): Array<{ key: string; label: string; value: number }> {
  const relation = item.evidence?.relation ?? {};
  return Object.keys(RELATION_LABELS).map((key) => ({
    key,
    label: RELATION_LABELS[key],
    value: typeof relation[key] === "number" ? relation[key] : 0,
  }));
}

function booleanRows(item: JevDecisionView): Array<{ key: BooleanKey; label: string; hint: string; value: number }> {
  return BOOLEAN_ROWS.map((row) => ({
    ...row,
    value: typeof item.evidence?.[row.key] === "number" ? (item.evidence?.[row.key] as number) : 0,
  }));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function width(value: number): string {
  return `${Math.min(100, Math.max(0, value * 100)).toFixed(1)}%`;
}

async function refresh(silent = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const result = await call<JevSnapshot>("ishiki/jev/trace");
    snapshot.value = result;
    errorText.value = "";
    if (!silent) toast("success", "判定记录已刷新", `共 ${formatNumber(result.decisions.length)} 条。`);
  } catch (error) {
    errorText.value = describe(error);
    toast("error", "读取判定记录失败", errorText.value);
  } finally {
    loading.value = false;
    attempted.value = true;
  }
}

onMounted(() => {
  if (store.jev === undefined) void refresh(true);
});
</script>

<template>
  <PageShell>
    <PageHeader
      title="唤醒判定"
      eyebrow="JEV"
      desc="每次判定都会记录模型给出的语义证据与本地规则的最终结论。证据各自独立，不相乘也不平均；阈值只作用于对应的那一条规则。"
    >
      <template #actions>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh(false)">
          <Icon v-if="loading" name="loading" :size="14" />
          <Icon v-else name="refresh" :size="14" />
          刷新
        </button>
      </template>
    </PageHeader>

    <div class="stack">
      <div v-if="errorText.length > 0" class="error-panel">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <div class="strong">读取判定记录失败</div>
          <div class="mono">{{ errorText }}</div>
        </div>
        <button type="button" class="btn btn-sm btn-soft" :disabled="loading" @click="refresh(false)">重试</button>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">最近判定汇总</div>
            <div class="panel-sub">只统计成功返回的判定；调用失败单独标记，不混进沉默。</div>
          </div>
          <div class="panel-actions">
            <span class="badge badge-success">回复 {{ counts.reply }}</span>
            <span class="badge badge-warning">加入 {{ counts.join }}</span>
            <span class="badge badge-neutral">沉默 {{ counts.wait }}</span>
          </div>
        </div>
      </div>

      <div v-if="!bootstrapped" class="panel">
        <div class="loading-list">
          <div v-for="index in 4" :key="index" class="skeleton skeleton-line" style="width: 100%"></div>
          <div class="skeleton skeleton-line" style="width: 58%"></div>
        </div>
      </div>

      <div v-else-if="decisions.length === 0" class="panel">
        <EmptyState
          title="还没有判定记录"
          desc="判定发生在群里有人说话之后。收到消息并完成一次判定后，这里会显示证据与结论；历史记录只保存在内存中，重启后清空。"
          icon="cache"
        >
          <button type="button" class="btn btn-sm btn-primary" :disabled="loading" @click="refresh(false)">重新读取</button>
        </EmptyState>
      </div>

      <div v-for="item in decisions" v-else :key="item.id" class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">
              {{ modeMeta(item).label }}
              <span class="muted">·</span>
              <span class="mono">{{ item.reason }}</span>
            </div>
            <div class="panel-sub">
              {{ formatDateTime(item.at) }} · {{ relativeTime(item.at) }} · 群 {{ item.channelId }} · {{ formatNumber(item.pendingCount) }} 条合批 ·
              {{ item.durationMs }} ms
            </div>
          </div>
          <div class="panel-actions">
            <span class="badge" :class="modeMeta(item).tone">{{ modeMeta(item).label }}</span>
            <span class="badge badge-outline mono">p={{ item.probability.toFixed(2) }}</span>
            <span class="badge badge-outline mono">门槛 {{ item.threshold.toFixed(2) }}</span>
          </div>
        </div>

        <div class="panel-body">
          <div v-if="item.error !== undefined" class="error-panel" style="margin-bottom: 12px">
            <Icon name="alert" :size="15" />
            <div class="flex-1 mono">{{ item.error }}</div>
          </div>

          <div v-if="item.focused.length > 0" class="jev-focus">
            <span class="jev-focus-label">焦点消息</span>
            <span>{{ item.focused }}</span>
          </div>

          <template v-if="item.evidence !== undefined">
            <div class="jev-section-title">消息关系分布</div>
            <div class="jev-rows">
              <div v-for="row in relationRows(item)" :key="row.key" class="jev-row">
                <span class="jev-row-label">{{ row.label }}</span>
                <span class="jev-track"><span class="jev-fill jev-fill-relation" :style="{ width: width(row.value) }" /></span>
                <span class="jev-row-value mono">{{ percent(row.value) }}</span>
              </div>
            </div>

            <div class="jev-section-title">独立语义证据</div>
            <div class="jev-chips">
              <span v-for="row in booleanRows(item)" :key="row.key" class="jev-chip" :class="{ 'is-on': row.value > 0.5 }" :title="row.hint">
                {{ row.label }} <span class="mono">{{ percent(row.value) }}</span>
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.jev-focus {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: var(--k-color-bg-2, rgba(127, 127, 127, 0.08));
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

.jev-focus-label {
  flex: none;
  color: var(--k-color-fg-3, #8a8a8a);
  font-size: 12px;
}

.jev-section-title {
  margin: 4px 0 8px;
  color: var(--k-color-fg-3, #8a8a8a);
  font-size: 12px;
  letter-spacing: 0.02em;
}

.jev-rows {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
}

.jev-row {
  display: grid;
  grid-template-columns: 92px 1fr 48px;
  gap: 10px;
  align-items: center;
  font-size: 12px;
}

.jev-row-label {
  color: var(--k-color-fg-2, #555);
}

.jev-track {
  display: block;
  height: 6px;
  border-radius: 999px;
  background: var(--k-color-bg-3, rgba(127, 127, 127, 0.16));
  overflow: hidden;
}

.jev-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--k-color-primary, #4f7cff);
}

.jev-fill-relation {
  background: var(--k-color-primary, #4f7cff);
}

.jev-row-value {
  text-align: right;
  color: var(--k-color-fg-3, #8a8a8a);
}

.jev-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.jev-chip {
  padding: 3px 9px;
  border: 1px solid var(--k-color-border, rgba(127, 127, 127, 0.28));
  border-radius: 999px;
  color: var(--k-color-fg-3, #8a8a8a);
  font-size: 12px;
  line-height: 1.5;
}

.jev-chip.is-on {
  border-color: var(--k-color-primary, #4f7cff);
  color: var(--k-color-primary, #4f7cff);
}
</style>
