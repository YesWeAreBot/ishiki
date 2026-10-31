<script setup lang="ts">
import { computed, ref } from "vue";

import { dayEnd, dayStart } from "../lib/dateFilter";
import { formatDateTime, formatNumber, relativeTime } from "../lib/format";
import type { SessionSummary } from "../types";
import EmptyState from "./EmptyState.vue";
import Icon from "./Icon.vue";
import StatusBadge from "./StatusBadge.vue";

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
</script>

<template>
  <section class="panel session-list-panel" aria-label="会话列表">
    <div class="list-search">
      <div class="stack-sm">
        <div class="search-box">
          <Icon name="search" :size="15" />
          <input v-model="keyword" class="input" type="search" placeholder="搜索会话编号、人格配置或文件" aria-label="搜索会话" />
        </div>
        <div class="row">
          <select v-model="profile" class="select" aria-label="按人格配置筛选">
            <option value="all">全部人格配置</option>
            <option v-for="profileId in profileIds" :key="profileId" :value="profileId">{{ profileId }}</option>
          </select>
          <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">清除</button>
        </div>
        <details class="list-date-filter">
          <summary aria-label="活动日期">
            <span class="row">
              <Icon name="clock" :size="13" />
              活动日期
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
            <Icon class="session-item-icon" name="sessions" :size="14" />
            <span class="session-item-id mono" :title="session.id">{{ session.id }}</span>
            <time class="session-item-time" :title="formatDateTime(session.lastActivity)">{{ relativeTime(session.lastActivity) }}</time>
          </span>
          <span class="session-item-meta">
            <span class="session-item-profile" :title="session.profileId">{{ session.profileId }}</span>
            <StatusBadge :state="session.state" />
            <span class="session-item-domain">{{ session.domainLabel }}</span>
            <span class="session-item-count">{{ formatNumber(session.entries) }} 条</span>
            <span v-if="session.corrupt > 0" class="badge badge-danger">{{ session.corrupt }} 行损坏</span>
          </span>
        </button>
      </div>
    </div>

    <div class="panel-foot">
      <span class="small muted">显示 {{ filteredSessions.length }} / {{ sessions.length }} 个会话</span>
      <span v-if="profileIds.length === 0" class="small faint">尚未加载人格配置快照</span>
    </div>
  </section>
</template>

<style scoped>
.session-list-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.list-search {
  position: relative;
  flex: none;
  padding: 12px;
}

.list-search .row {
  flex-wrap: nowrap;
}

.list-search .row > .select,
.list-search .row > .input {
  flex: 1 1 0;
  min-width: 0;
}

.list-date-filter {
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
  font-size: 11px;
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
  transition: transform 0.14s ease;
}

.list-date-filter[open] .list-date-chevron {
  transform: rotate(180deg);
}

.list-date-range {
  padding: 0 8px 8px;
}

.list-date-range > .input {
  min-width: 0;
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
  gap: 7px;
  border-bottom: 0;
  border-radius: var(--radius-sm);
  min-height: 66px;
  padding: 10px 11px;
}

.session-item-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  width: 100%;
}

.session-item-icon {
  flex: none;
  color: var(--muted);
}

.session-item-id {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-time {
  flex: none;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.session-item-meta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto auto;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-left: 21px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}

.session-item-profile {
  min-width: 0;
  overflow: hidden;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-domain {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-count {
  flex: none;
  white-space: nowrap;
}

.session-skeleton {
  height: 64px;
  margin: 8px;
}

.panel-foot {
  flex: none;
}

@media (max-width: 900px) {
  .list-search {
    padding: 9px 10px;
  }

  .list-search .stack-sm {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(160px, 0.7fr) minmax(120px, 0.5fr);
    align-items: start;
    gap: 8px;
  }

  .list-search .row {
    flex-wrap: wrap;
  }

  .list-date-filter {
    align-self: stretch;
  }

  .session-list-item {
    padding-top: 7px;
    padding-bottom: 7px;
  }
}

@media (max-width: 720px) {
  .list-search .stack-sm {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(104px, 0.58fr) auto auto;
    align-items: center;
    gap: 6px;
  }

  .list-search .row {
    display: contents;
  }

  .list-search .row > .select {
    grid-column: 2;
  }

  .list-search .row > .btn {
    grid-column: 4;
  }

  .list-search .list-date-filter {
    grid-column: 3;
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
  .list-date-filter summary .badge,
  .list-date-filter summary .list-date-chevron {
    display: none;
  }

  .list-date-filter[open] {
    position: absolute;
    z-index: 6;
    top: calc(100% - 4px);
    right: 8px;
    width: min(280px, calc(100vw - 48px));
    box-shadow: var(--shadow-overlay);
  }

  .panel-foot {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .list-date-chevron {
    transition: none;
  }
}
</style>
