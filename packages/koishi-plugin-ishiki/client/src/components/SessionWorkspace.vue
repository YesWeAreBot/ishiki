<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { useSessionEntries } from "../composables/useSessionEntries";
import { formatCompact, formatNumber, relativeTime } from "../lib/format";
import type { SessionSummary } from "../types";
import ConversationFeed from "./ConversationFeed.vue";
import CopyButton from "./CopyButton.vue";
import EmptyState from "./EmptyState.vue";
import Icon from "./Icon.vue";
import StatusBadge from "./StatusBadge.vue";

const ROLE_OPTIONS = ["user", "assistant", "tool", "system", "custom", "event", "state"] as const;
const ROLE_LABELS: Record<(typeof ROLE_OPTIONS)[number], string> = {
  user: "用户",
  assistant: "助手",
  tool: "工具",
  system: "系统",
  custom: "自定义",
  event: "事件",
  state: "状态",
};

const props = defineProps<{
  selectedId: string;
  summary?: SessionSummary;
}>();

const router = useRouter();
const selectedId = computed(() => props.selectedId);
const {
  entries,
  corruptLines,
  stats,
  loading,
  loadingOlder,
  refreshingLatest,
  failure,
  feedVersion,
  hasOlder,
  hasEntryFilters,
  liveStatus,
  roleFilter,
  keywordDraft,
  fromDate,
  toDate,
  loadLatest,
  loadOlder,
  retryFailure,
  applyFilters,
  clearFilters,
} = useSessionEntries(selectedId);

const filtersOpen = ref(false);
const detailsOpen = ref(false);

const entryCount = computed(() => stats.value?.entries ?? props.summary?.entries);
const messageCount = computed(() => stats.value?.messages ?? props.summary?.messages);
const turnCount = computed(() => stats.value?.turns ?? props.summary?.turns);
const tokenCount = computed(() => stats.value?.tokens ?? props.summary?.tokens);
const corruptTotal = computed(() => stats.value?.corrupt ?? props.summary?.corrupt ?? 0);
const lastActivity = computed(() => props.summary?.lastActivity);

function open(path: string): void {
  void router.push(path);
}

function openProfile(): void {
  const profileId = props.summary?.profileId;
  if (profileId === undefined) return;
  open(`/ishiki/profiles/${encodeURIComponent(profileId)}`);
}

function openRuntime(): void {
  const runtimeId = props.summary?.runtimeId;
  if (runtimeId === undefined) return;
  open(`/ishiki/runtimes?id=${encodeURIComponent(runtimeId)}`);
}

watch(
  () => props.selectedId,
  () => {
    filtersOpen.value = false;
    detailsOpen.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <section class="panel session-workspace">
    <header v-if="selectedId.length > 0" class="chat-head">
      <div class="chat-identity">
        <div class="chat-avatar" aria-hidden="true"><Icon name="sessions" :size="19" /></div>
        <div class="chat-identity-text">
          <div class="chat-title mono">{{ selectedId }}</div>
          <div class="chat-subline">
            <template v-if="summary !== undefined">
              {{ summary.profileId }} · {{ summary.domainLabel }} · {{ formatNumber(summary.messages) }} 条消息
            </template>
            <template v-else>会话不在当前列表快照中，仍可直接读取日志。</template>
          </div>
        </div>
      </div>
      <div class="chat-actions">
        <StatusBadge v-if="summary !== undefined" :state="summary.state" />
        <CopyButton :value="selectedId" label="会话编号" />
        <button
          type="button"
          class="btn btn-ghost btn-sm chat-tool"
          :class="{ 'is-active': filtersOpen }"
          :aria-pressed="filtersOpen"
          aria-label="显示或隐藏条目筛选"
          @click="filtersOpen = !filtersOpen"
        >
          <Icon name="filter" :size="14" />
          <span class="chat-tool-label">筛选</span>
          <span v-if="hasEntryFilters" class="chat-tool-dot" aria-hidden="true"></span>
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm chat-tool"
          :class="{ 'is-active': detailsOpen }"
          :aria-pressed="detailsOpen"
          aria-label="显示或隐藏会话信息"
          @click="detailsOpen = !detailsOpen"
        >
          <Icon name="file" :size="14" />
          <span class="chat-tool-label">信息</span>
        </button>
        <button
          type="button"
          class="btn btn-soft btn-sm chat-tool"
          :disabled="loading || refreshingLatest"
          aria-label="刷新到最新消息"
          @click="loadLatest(true)"
        >
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="13" />
          <span class="chat-tool-label">刷新</span>
        </button>
      </div>
    </header>

    <div v-if="selectedId.length > 0" class="chat-metrics">
      <span
        ><strong>{{ formatNumber(entryCount) }}</strong> 条目</span
      >
      <span
        ><strong>{{ formatNumber(messageCount) }}</strong> 消息</span
      >
      <span
        ><strong>{{ formatNumber(turnCount) }}</strong> 轮次</span
      >
      <span
        ><strong>{{ formatCompact(tokenCount) }}</strong> Token</span
      >
      <span :class="{ 'metric-warning': corruptTotal > 0 }"
        ><strong>{{ formatNumber(corruptTotal) }}</strong> 损坏行</span
      >
      <span class="metric-activity"
        ><strong>{{ relativeTime(lastActivity) }}</strong> 最后活动</span
      >
      <span class="metric-loaded"
        >已载入 <strong>{{ formatNumber(entries.length) }}</strong></span
      >
      <span class="metric-live" :class="{ 'is-syncing': refreshingLatest }">
        <span class="metric-live-dot" aria-hidden="true"></span>
        {{ refreshingLatest ? "同步中" : "实时更新" }}
      </span>
    </div>
    <span class="visually-hidden" role="status" aria-live="polite">{{ liveStatus }}</span>

    <div v-if="filtersOpen || detailsOpen || (failure !== undefined && entries.length > 0) || corruptLines.length > 0 || corruptTotal > 0" class="chat-aux">
      <form v-if="filtersOpen" class="entry-filters" @submit.prevent="applyFilters">
        <label class="field">
          <span class="field-label">角色</span>
          <select v-model="roleFilter" class="select" @change="applyFilters">
            <option value="all">全部</option>
            <option v-for="role in ROLE_OPTIONS" :key="role" :value="role">{{ ROLE_LABELS[role] }}</option>
          </select>
        </label>
        <label class="field field-keyword">
          <span class="field-label">关键词</span>
          <input v-model="keywordDraft" class="input" type="search" placeholder="搜索条目内容" />
        </label>
        <label class="field">
          <span class="field-label">起始时间</span>
          <input v-model="fromDate" class="input" type="date" @change="applyFilters" />
        </label>
        <label class="field">
          <span class="field-label">结束时间</span>
          <input v-model="toDate" class="input" type="date" @change="applyFilters" />
        </label>
        <div class="entry-filter-actions">
          <button type="submit" class="btn btn-primary btn-sm" :disabled="loading">应用筛选</button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="!hasEntryFilters" @click="clearFilters">清除筛选</button>
        </div>
      </form>

      <div v-if="detailsOpen" class="chat-details">
        <div class="chat-detail-actions">
          <button v-if="summary !== undefined" type="button" class="btn btn-sm btn-ghost" @click="openProfile">
            <Icon name="profile" :size="13" />
            打开人格配置
          </button>
          <button v-if="summary !== undefined" type="button" class="btn btn-sm btn-ghost" @click="openRuntime">
            <Icon name="runtimes" :size="13" />
            打开运行实例
          </button>
        </div>
        <div v-if="summary !== undefined" class="chat-file">
          <span class="field-label">日志文件</span>
          <code>{{ summary.file }}</code>
          <CopyButton :value="summary.file" label="日志文件路径" />
        </div>
        <div v-else class="notice notice-info">
          <Icon name="info" :size="14" />
          <span>该会话不在当前列表快照中，条目仍会按会话编号直接读取。</span>
        </div>
      </div>

      <div v-if="failure !== undefined && entries.length > 0" class="error-panel chat-error">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <strong>{{ failure.scope === "older" ? "加载更早记录失败" : "同步新消息失败" }}</strong>
          <p class="small">{{ failure.message }}</p>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="loadingOlder || refreshingLatest" @click="retryFailure">重试</button>
      </div>

      <details v-if="corruptLines.length > 0" class="chat-corrupt">
        <summary>
          <span class="row">
            <Icon name="alert" :size="14" />
            已载入范围内有 {{ corruptLines.length }} 行无法解析
          </span>
          <span class="small faint">展开查看</span>
        </summary>
        <ul class="corrupt-lines">
          <li v-for="line in corruptLines" :key="line.line">第 {{ line.line }} 行 · {{ line.error }}</li>
        </ul>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="loading" @click="loadLatest(true)">
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="13" />
          重新载入
        </button>
      </details>
      <div v-else-if="corruptTotal > 0" class="notice notice-info chat-corrupt-note">
        <Icon name="info" :size="14" />
        <span>整个日志文件有 {{ corruptTotal }} 行损坏，当前载入范围内没有遇到。</span>
      </div>
    </div>

    <div class="chat-stage">
      <div v-if="selectedId.length === 0" class="chat-empty">
        <EmptyState title="选择一个会话" desc="从左侧会话列表选择，或使用会话编号直接打开。" icon="sessions" />
      </div>

      <div v-else-if="loading" class="chat-loading" aria-busy="true">
        <div class="chat-loading-note"><span class="spinner" aria-hidden="true"></span> 正在定位最新消息</div>
        <div v-for="index in 4" :key="index" class="skeleton chat-loading-row" :class="`row-${index}`"></div>
      </div>

      <div v-else-if="failure !== undefined && entries.length === 0" class="chat-empty">
        <div class="error-panel chat-fatal">
          <Icon name="alert" :size="17" />
          <div class="flex-1">
            <strong>读取会话条目失败</strong>
            <p class="small">{{ failure.message }}</p>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" @click="retryFailure">重试</button>
        </div>
      </div>

      <div v-else-if="entries.length === 0" class="chat-empty">
        <EmptyState
          :title="hasEntryFilters ? '没有匹配的条目' : '会话还没有条目'"
          :desc="hasEntryFilters ? '当前筛选条件下没有匹配，清除筛选后可看到全部条目。' : '运行时会话在产生消息后写入日志。'"
          icon="inbox"
        >
          <button v-if="hasEntryFilters" type="button" class="btn btn-ghost btn-sm" @click="clearFilters">清除筛选</button>
        </EmptyState>
      </div>

      <ConversationFeed
        v-else
        :key="`${selectedId}:${feedVersion}`"
        :entries="entries"
        :has-older="hasOlder"
        :loading-older="loadingOlder"
        @load-older="loadOlder"
      />
    </div>
  </section>
</template>

<style scoped>
.session-workspace {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.chat-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 14px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-head);
}

.chat-identity {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.chat-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line));
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.chat-identity-text {
  min-width: 0;
}

.chat-title {
  overflow: hidden;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-subline {
  overflow: hidden;
  margin-top: 2px;
  color: var(--muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
}

.chat-tool {
  position: relative;
  min-height: 34px;
}

.chat-tool.is-active,
.chat-tool[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.chat-tool-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.chat-metrics {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0;
  min-height: 34px;
  overflow-x: auto;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 10.5px;
  scrollbar-width: none;
  white-space: nowrap;
}

.chat-metrics::-webkit-scrollbar {
  display: none;
}

.chat-metrics > span {
  flex: none;
  padding: 0 11px;
  border-right: 1px solid var(--line);
}

.chat-metrics strong {
  color: var(--ink);
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
}

.chat-metrics .metric-loaded {
  margin-left: auto;
}

.chat-metrics .metric-warning strong {
  color: var(--danger-ink);
}

.chat-metrics .metric-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-right: 0;
  color: var(--success-ink);
}

.metric-live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success);
}

.metric-live.is-syncing .metric-live-dot {
  animation: live-pulse 1s ease-in-out infinite;
}

.chat-aux {
  flex: none;
  max-height: min(38vh, 320px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 11px 13px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-muted);
}

.entry-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 10px;
}

.entry-filters .field {
  flex: 1 1 118px;
  min-width: 0;
}

.entry-filters .field-keyword {
  flex: 2 1 210px;
}

.entry-filter-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.chat-details {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding-top: 10px;
}

.entry-filters + .chat-details {
  margin-top: 10px;
  border-top: 1px solid var(--line);
}

.chat-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.chat-file {
  display: flex;
  flex: 1 1 300px;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.chat-file code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 10.5px;
}

.chat-error,
.chat-fatal {
  margin-top: 9px;
}

.chat-error p,
.chat-fatal p {
  margin-top: 3px;
  overflow-wrap: anywhere;
}

.chat-corrupt {
  margin-top: 9px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warning) 34%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 7%, var(--surface));
}

.chat-corrupt summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--warning-ink);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.chat-corrupt summary::-webkit-details-marker {
  display: none;
}

.chat-corrupt .corrupt-lines {
  max-height: 110px;
  margin: 7px 0;
  padding-left: 18px;
  overflow-y: auto;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.55;
}

.chat-corrupt .corrupt-lines li {
  overflow-wrap: anywhere;
}

.chat-corrupt-note {
  margin-top: 9px;
}

.chat-stage {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.chat-empty {
  display: grid;
  flex: 1;
  min-height: 0;
  place-items: center;
  padding: 24px;
  overflow-y: auto;
}

.chat-fatal {
  width: min(100%, 620px);
  margin: 0;
}

.chat-loading {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 22px;
  overflow: hidden;
  background: var(--surface-inset);
}

.chat-loading-note {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 11px;
}

.chat-loading-row {
  height: 64px;
  width: min(74%, 660px);
}

.chat-loading-row.row-2,
.chat-loading-row.row-4 {
  align-self: flex-end;
}

.chat-loading-row.row-2 {
  width: min(56%, 520px);
}

.chat-loading-row.row-3 {
  width: min(66%, 580px);
}

.chat-loading-row.row-4 {
  width: min(48%, 460px);
}

@keyframes live-pulse {
  50% {
    opacity: 0.4;
  }
}

@media (max-width: 1080px) {
  .chat-tool-label {
    display: none;
  }

  .chat-tool {
    padding-right: 9px;
    padding-left: 9px;
  }
}

@media (max-width: 900px) {
  .chat-aux {
    max-height: 32vh;
  }
}

@media (max-width: 720px) {
  .chat-head {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
    padding: 10px;
  }

  .chat-identity {
    flex-basis: 100%;
  }

  .chat-avatar {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
  }

  .chat-actions {
    width: 100%;
    justify-content: flex-start;
    padding-left: 42px;
    gap: 3px;
  }

  .chat-tool {
    min-height: 32px;
  }

  .chat-metrics {
    flex-wrap: wrap;
    align-content: center;
    overflow: visible;
    padding: 3px 0;
    white-space: normal;
  }

  .chat-metrics > span {
    display: inline-flex;
    align-items: center;
    min-height: 26px;
    padding: 0 8px;
    white-space: nowrap;
  }

  .chat-metrics .metric-live {
    display: none;
  }

  .chat-metrics .metric-loaded {
    display: none;
  }

  .chat-metrics .metric-activity {
    display: none;
  }

  .chat-aux {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 5;
    max-height: 57%;
    padding: 10px;
    border-top: 1px solid var(--line);
    border-bottom: 0;
    border-radius: var(--radius) var(--radius) 0 0;
    box-shadow: var(--shadow-overlay);
  }

  .entry-filters .field {
    flex-basis: 112px;
  }

  .entry-filters .field-keyword {
    flex-basis: 100%;
  }

  .entry-filter-actions {
    width: 100%;
    margin-left: 0;
  }

  .chat-file {
    flex-basis: 100%;
  }

  .chat-loading {
    padding: 14px 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .metric-live.is-syncing .metric-live-dot {
    animation: none;
  }
}
</style>
