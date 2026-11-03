<script setup lang="ts">
import { computed, ref } from "vue";

import { dayEnd, dayStart } from "../lib/dateFilter";
import { formatDateTime, formatNumber, relativeTime } from "../lib/format";
import { statusLabel, statusTone } from "../lib/status";
import type { SessionSummary } from "../types";
import EmptyState from "./EmptyState.vue";
import Icon from "./Icon.vue";

const props = defineProps<{
  sessions: SessionSummary[];
  selectedId: string;
  busy: boolean;
  profileIds: string[];
}>();

const emit = defineEmits<{
  select: [session: SessionSummary];
}>();

const keyword = ref("");
const profile = ref("all");
const fromDate = ref("");
const toDate = ref("");

const hasFilters = computed(() => keyword.value.trim().length > 0 || profile.value !== "all" || fromDate.value.length > 0 || toDate.value.length > 0);

const filteredSessions = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  const from = dayStart(fromDate.value);
  const to = dayEnd(toDate.value);
  return props.sessions
    .filter((session) => {
      if (profile.value !== "all" && session.profileId !== profile.value) return false;
      const activity = session.lastActivity;
      if (from !== undefined && (activity === undefined || activity < from)) return false;
      if (to !== undefined && (activity === undefined || activity > to)) return false;
      if (needle.length === 0) return true;
      const haystack = `${session.id} ${session.profileId} ${session.domainLabel} ${session.file}`.toLowerCase();
      return haystack.includes(needle);
    })
    .sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
});

function resetFilters(): void {
  keyword.value = "";
  profile.value = "all";
  fromDate.value = "";
  toDate.value = "";
}

/** 会话 ID 前半段是平台与账号，列表里只留能区分会话的尾段。 */
function shortSessionId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
</script>

<template>
  <section class="panel session-list-panel" aria-label="会话列表">
    <div class="panel-head" style="padding-bottom: 12px">
      <div class="panel-title">会话列表</div>
      <div class="panel-actions">
        <span class="badge badge-outline">{{ filteredSessions.length }} / {{ sessions.length }}</span>
      </div>
    </div>
    <div class="list-search">
      <div class="stack-sm">
        <div class="search-box">
          <Icon name="search" :size="15" />
          <input v-model="keyword" class="input" type="search" placeholder="搜索会话或人格" aria-label="搜索会话" />
        </div>
        <div class="row">
          <select v-model="profile" class="select" aria-label="按人格配置筛选">
            <option value="all">全部人格</option>
            <option v-for="profileId in profileIds" :key="profileId" :value="profileId">{{ profileId }}</option>
          </select>
          <details class="list-date-filter">
            <summary aria-label="活动日期">
              <span class="row">
                <Icon name="clock" :size="13" />
                <span class="list-date-label">活动日期</span>
              </span>
              <span v-if="fromDate.length > 0 || toDate.length > 0" class="badge badge-info">已限定</span>
              <Icon class="list-date-chevron" name="chevronDown" :size="13" />
            </summary>
            <div class="row list-date-range">
              <input v-model="fromDate" class="input" type="date" aria-label="活动起始日期" />
              <span class="faint small">至</span>
              <input v-model="toDate" class="input" type="date" aria-label="活动结束日期" />
            </div>
          </details>
          <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">清除</button>
        </div>
      </div>
    </div>

    <div class="session-list-scroll">
      <div v-if="busy && sessions.length === 0" class="loading-list">
        <div v-for="index in 5" :key="index" class="skeleton session-skeleton"></div>
      </div>

      <EmptyState
        v-else-if="filteredSessions.length === 0"
        :title="sessions.length === 0 ? '暂无会话' : '没有匹配的会话'"
        :desc="sessions.length === 0 ? '运行实例产生消息后会在这里出现。' : '调整关键词、人格配置或时间范围。'"
        icon="sessions"
      >
        <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">清除筛选</button>
      </EmptyState>

      <div v-else class="list">
        <button
          v-for="session in filteredSessions"
          :key="session.id"
          type="button"
          class="list-item session-list-item"
          :aria-current="selectedId === session.id ? 'true' : undefined"
          @click="emit('select', session)"
        >
          <span class="session-item-top">
            <span class="session-item-id mono" :title="session.id">{{ shortSessionId(session.id) }}</span>
            <span class="session-item-state" :class="`is-${statusTone(session.state)}`">{{ statusLabel(session.state) }}</span>
            <time class="session-item-time" :title="formatDateTime(session.lastActivity)">{{ relativeTime(session.lastActivity) }}</time>
          </span>
          <span class="session-item-meta">
            <span class="session-item-profile" :title="session.id">{{ session.profileId }}</span>
            <span class="session-item-count">{{ formatNumber(session.entries) }} 条</span>
            <span v-if="session.corrupt > 0" class="badge badge-danger">{{ session.corrupt }} 行损坏</span>
          </span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.session-list-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
}

.list-search {
  position: relative;
  flex: none;
  --search-pad: var(--gutter);
  padding: 12px var(--search-pad);
}

.list-search .row {
  flex-wrap: wrap;
}

.list-search .row > .select,
.list-search .row > .input {
  flex: 1 1 0;
  min-width: 0;
}

.list-search .row > .select {
  min-width: 96px;
}

.list-search .row > .btn {
  margin-left: auto;
}

.list-date-filter {
  flex: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.list-date-filter summary {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 9px;
  color: var(--muted);
  font-size: var(--fs-micro);
  cursor: pointer;
  list-style: none;
}

.list-date-filter summary::-webkit-details-marker {
  display: none;
}

.list-date-filter summary .row {
  flex: 1;
}

.list-date-chevron {
  transition: transform var(--dur-micro) var(--ease-out);
}

.list-date-filter[open] .list-date-chevron {
  transform: rotate(180deg);
}

.list-date-range {
  padding: 0 8px 8px;
}

.list-date-filter[open] .list-date-range {
  position: absolute;
  top: calc(100% + 4px);
  right: var(--search-pad);
  left: var(--search-pad);
  z-index: 20;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  flex-wrap: nowrap;
  align-items: center;
}

.list-date-range > .input {
  min-width: 0;
}

.list-date-filter[open] .list-date-range > .input {
  flex: 1 1 0;
  width: 0;
}

.session-list-panel:has(.list-date-filter[open]) .session-list-scroll {
  padding-top: 60px;
}

.list-date-filter:has(.badge) summary .list-date-label {
  display: none;
}

@container (max-width: 320px) {
  .list-date-filter summary .list-date-label {
    display: none;
  }

  .list-date-filter summary .badge {
    width: 6px;
    height: 6px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--cool);
    color: transparent;
    font-size: 0;
  }
}

.session-list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.session-list-scroll .list {
  gap: 2px;
  padding: 7px;
}

.session-list-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-bottom: 0;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}

.session-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.session-item-id {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ink);
  font-size: var(--fs-label);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--muted);
  font-size: var(--fs-micro);
  white-space: nowrap;
}

.session-item-state::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.session-item-state.is-success {
  color: var(--success-ink);
}

.session-item-state.is-info {
  color: var(--cool-ink);
}

.session-item-state.is-warning {
  color: var(--warning-ink);
}

.session-item-state.is-danger {
  color: var(--danger-ink);
}

.session-item-time {
  flex: none;
  color: var(--muted);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--muted);
  font-size: var(--fs-micro);
  line-height: 1.45;
}

.session-item-profile {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-count {
  flex: none;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.session-skeleton {
  height: 64px;
  margin: 8px;
}

@media (max-width: 900px) {
  .list-search {
    --search-pad: 10px;
    padding: 9px var(--search-pad);
  }

  .session-list-item {
    padding-top: 7px;
    padding-bottom: 7px;
  }
}

@media (max-width: 720px) {
  .session-list-panel .panel-head {
    flex-wrap: nowrap;
  }

  .session-list-panel .panel-actions {
    width: auto;
    margin-left: auto;
  }

  .list-search .stack-sm {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(104px, 0.58fr) auto auto;
    align-items: center;
    gap: 6px;
  }

  .list-search > .stack-sm > .row {
    display: contents;
  }

  .list-search .row > .select {
    grid-column: 2;
    grid-row: 1;
  }

  .list-search .row > .btn {
    grid-column: 4;
    grid-row: 1;
  }

  .list-search .list-date-filter {
    grid-column: 3;
    grid-row: 1;
    align-self: center;
  }

  .list-date-filter summary {
    justify-content: center;
    min-height: 34px;
    padding: 0 9px;
  }

  .list-date-filter summary .row {
    display: flex;
    flex: none;
  }

  .list-date-filter summary .row > span,
  .list-date-filter summary .list-date-label,
  .list-date-filter summary .badge,
  .list-date-filter summary .list-date-chevron {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .list-date-chevron {
    transition: none;
  }
}
</style>
