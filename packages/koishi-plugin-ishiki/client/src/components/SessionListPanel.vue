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
          <input v-model="keyword" class="input" type="search" placeholder="搜索会话 id、profile 或文件" aria-label="搜索会话" />
        </div>
        <div class="row">
          <select v-model="profile" class="select" aria-label="按 profile 筛选">
            <option value="all">全部 profile</option>
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
        :desc="sessions.length === 0 ? '运行时产生消息后会在这里出现。' : '调整关键词、profile 或时间范围。'"
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
          <span class="list-item-main">
            <span class="list-item-title">
              <Icon name="sessions" :size="14" />
              <span class="mono">{{ session.id }}</span>
            </span>
            <span class="list-item-meta">
              <span>{{ session.profileId }}</span>
              <span>{{ session.domainLabel }}</span>
              <span>{{ formatNumber(session.entries) }} 条</span>
              <span v-if="session.corrupt > 0" class="badge badge-danger">{{ session.corrupt }} 行损坏</span>
            </span>
          </span>
          <span class="list-item-side">
            <StatusBadge :state="session.state" />
            <time :title="formatDateTime(session.lastActivity)">{{ relativeTime(session.lastActivity) }}</time>
          </span>
        </button>
      </div>
    </div>

    <div class="panel-foot">
      <span class="small muted">显示 {{ filteredSessions.length }} / {{ sessions.length }} 个会话</span>
      <span v-if="profileIds.length === 0" class="small faint">尚未加载 profile 快照</span>
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
  border-bottom: 0;
  border-radius: 9px;
  padding: 9px 10px;
}

.session-list-item .list-item-meta {
  gap: 3px 8px;
  font-size: 10.5px;
}

.session-list-item .list-item-title {
  font-size: 12px;
}

.session-list-item .list-item-side {
  gap: 4px;
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
