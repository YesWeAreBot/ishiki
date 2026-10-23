<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { ApiError, call } from "../api";
import CopyButton from "../components/CopyButton.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import SessionEntry from "../components/SessionEntry.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { formatCompact, formatDateTime, formatNumber, relativeTime } from "../lib/format";
import { store, toast } from "../store";
import type { CorruptLine, LogEntry, SessionEntries, SessionEntryFilters, SessionFilters, SessionSummary } from "../types";

const ENTRY_PAGE_SIZE = 100;
const ROLE_OPTIONS = ["user", "assistant", "tool", "system", "custom", "event", "state"] as const;

interface EntrySlice {
  cursor: string | undefined;
  entries: LogEntry[];
  corrupt: CorruptLine[];
  nextCursor: string | undefined;
}

const route = useRoute();
const router = useRouter();

const selectedId = computed(() => {
  const raw = route.params.page;
  const segments = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return segments[0] === "sessions" && typeof segments[1] === "string" ? segments[1] : "";
});
const selectedSummary = computed(() => sessions.value.find((session) => session.id === selectedId.value));

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function dayStart(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function dayEnd(value: string): number | undefined {
  const start = dayStart(value);
  return start === undefined ? undefined : start + 24 * 60 * 60 * 1000 - 1;
}

/* 会话列表：优先使用推送快照，刷新接口返回的列表作为临时覆盖。 */

const refreshedSessions = ref<SessionSummary[] | undefined>(undefined);
const sessions = computed(() => refreshedSessions.value ?? store.sessions);

watch(
  () => store.sessions,
  () => {
    refreshedSessions.value = undefined;
  },
);

const listKeyword = ref("");
const listProfile = ref("all");
const listFrom = ref("");
const listTo = ref("");
const listBusy = ref(false);

const hasListFilters = computed(
  () => listKeyword.value.trim().length > 0 || listProfile.value !== "all" || listFrom.value.length > 0 || listTo.value.length > 0,
);

const filteredSessions = computed(() => {
  const keyword = listKeyword.value.trim().toLowerCase();
  const from = dayStart(listFrom.value);
  const to = dayEnd(listTo.value);
  return sessions.value
    .filter((session) => {
      if (listProfile.value !== "all" && session.profileId !== listProfile.value) return false;
      const activity = session.lastActivity;
      if (from !== undefined && (activity === undefined || activity < from)) return false;
      if (to !== undefined && (activity === undefined || activity > to)) return false;
      if (keyword.length === 0) return true;
      const haystack = `${session.id} ${session.profileId} ${session.domainLabel} ${session.file}`.toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((left, right) => (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
});

function resetListFilters(): void {
  listKeyword.value = "";
  listProfile.value = "all";
  listFrom.value = "";
  listTo.value = "";
}

async function refreshList(): Promise<void> {
  if (listBusy.value) return;
  listBusy.value = true;
  try {
    const filters: SessionFilters = {};
    const list = await call<SessionSummary[]>("ishiki/sessions/list", filters);
    refreshedSessions.value = list;
    toast("success", "会话列表已刷新", `服务端扫描到 ${list.length} 个会话。`);
  } catch (error_) {
    toast("error", "刷新会话列表失败", describe(error_));
  } finally {
    listBusy.value = false;
  }
}

/* 会话条目：按游标分页，只保留已加载的切片。 */

const slices = ref<EntrySlice[]>([]);
const stats = ref<SessionEntries["stats"] | undefined>(undefined);
const loading = ref(false);
const loadingMore = ref(false);
const retrying = ref(false);
const error = ref("");
let generation = 0;

const entries = computed(() => slices.value.flatMap((slice) => slice.entries));
const corruptLines = computed(() => slices.value.flatMap((slice) => slice.corrupt));
const nextCursor = computed(() => slices.value[slices.value.length - 1]?.nextCursor);

const entryCount = computed(() => stats.value?.entries ?? selectedSummary.value?.entries);
const messageCount = computed(() => stats.value?.messages ?? selectedSummary.value?.messages);
const turnCount = computed(() => stats.value?.turns ?? selectedSummary.value?.turns);
const tokenCount = computed(() => stats.value?.tokens ?? selectedSummary.value?.tokens);
const corruptTotal = computed(() => stats.value?.corrupt ?? selectedSummary.value?.corrupt ?? 0);
const lastActivity = computed(() => selectedSummary.value?.lastActivity);

const roleFilter = ref("all");
const keywordDraft = ref("");
const keyword = ref("");
const fromDate = ref("");
const toDate = ref("");

const hasEntryFilters = computed(() => roleFilter.value !== "all" || keyword.value.length > 0 || fromDate.value.length > 0 || toDate.value.length > 0);

function currentEntryFilters(): SessionEntryFilters {
  const filters: SessionEntryFilters = {};
  if (roleFilter.value !== "all") filters.role = roleFilter.value;
  if (keyword.value.length > 0) filters.keyword = keyword.value;
  const from = dayStart(fromDate.value);
  if (from !== undefined) filters.from = from;
  const to = dayEnd(toDate.value);
  if (to !== undefined) filters.to = to;
  return filters;
}

function toSlice(cursor: string | undefined, result: SessionEntries): EntrySlice {
  const next = result.nextCursor === cursor ? undefined : result.nextCursor;
  return { cursor, entries: result.entries, corrupt: result.corrupt, nextCursor: next };
}

function clearEntryFilters(): void {
  roleFilter.value = "all";
  keyword.value = "";
  keywordDraft.value = "";
  fromDate.value = "";
  toDate.value = "";
  void loadFirst();
}

function applyFilters(): void {
  keyword.value = keywordDraft.value.trim();
  void loadFirst();
}

async function loadFirst(notify = false): Promise<void> {
  const id = selectedId.value;
  const token = ++generation;
  loadingMore.value = false;
  retrying.value = false;
  error.value = "";
  slices.value = [];
  stats.value = undefined;
  if (id.length === 0) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await call<SessionEntries>("ishiki/sessions/entries", id, undefined, ENTRY_PAGE_SIZE, currentEntryFilters());
    if (token !== generation) return;
    slices.value = [toSlice(undefined, result)];
    stats.value = result.stats;
    if (notify) toast("success", "条目已刷新", `从首个游标读取 ${result.entries.length} 条。`);
  } catch (error_) {
    if (token !== generation) return;
    error.value = describe(error_);
    if (notify) toast("error", "刷新条目失败", error.value);
  } finally {
    if (token === generation) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const id = selectedId.value;
  const cursor = nextCursor.value;
  if (id.length === 0 || cursor === undefined || loading.value || loadingMore.value) return;
  const token = generation;
  loadingMore.value = true;
  try {
    const result = await call<SessionEntries>("ishiki/sessions/entries", id, cursor, ENTRY_PAGE_SIZE, currentEntryFilters());
    if (token !== generation) return;
    slices.value = [...slices.value, toSlice(cursor, result)];
    stats.value = result.stats;
  } catch (error_) {
    if (token !== generation) return;
    toast("error", "加载更多失败", describe(error_));
  } finally {
    if (token === generation) loadingMore.value = false;
  }
}

async function retryLast(): Promise<void> {
  const id = selectedId.value;
  if (id.length === 0 || retrying.value) return;
  const last = slices.value[slices.value.length - 1];
  if (last === undefined) {
    await loadFirst();
    return;
  }
  const token = ++generation;
  retrying.value = true;
  error.value = "";
  try {
    const result = await call<SessionEntries>("ishiki/sessions/entries", id, last.cursor, ENTRY_PAGE_SIZE, currentEntryFilters());
    if (token !== generation) return;
    slices.value = [...slices.value.slice(0, -1), toSlice(last.cursor, result)];
    stats.value = result.stats;
    toast("success", "已重新读取", last.cursor === undefined ? "已重读首个游标范围。" : "已重读当前游标范围。");
  } catch (error_) {
    if (token !== generation) return;
    error.value = describe(error_);
    toast("error", "重新读取失败", error.value);
  } finally {
    if (token === generation) retrying.value = false;
  }
}

function open(path: string): void {
  void router.push(path).catch(() => undefined);
}

function selectSession(session: SessionSummary): void {
  if (session.id === selectedId.value) return;
  open(`/ishiki/sessions/${encodeURIComponent(session.id)}`);
}

function openProfile(): void {
  const profileId = selectedSummary.value?.profileId;
  if (profileId === undefined) return;
  open(`/ishiki/profiles/${encodeURIComponent(profileId)}`);
}

function openRuntime(): void {
  const runtimeId = selectedSummary.value?.runtimeId;
  if (runtimeId === undefined) return;
  open(`/ishiki/runtimes?id=${encodeURIComponent(runtimeId)}`);
}

watch(
  selectedId,
  () => {
    void loadFirst();
  },
  { immediate: true },
);
</script>

<template>
  <PageShell>
    <PageHeader title="会话日志" desc="浏览运行时的持久化会话，按游标分段读取，损坏行不会阻塞其余条目。" eyebrow="执行">
      <template #actions>
        <button type="button" class="btn btn-soft btn-sm" :disabled="listBusy" @click="refreshList">
          <span v-if="listBusy" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="14" />
          刷新列表
        </button>
      </template>
    </PageHeader>

    <div class="split">
      <section class="panel">
        <div class="list-search">
          <div class="stack-sm">
            <div class="search-box">
              <Icon name="search" :size="15" />
              <input v-model="listKeyword" class="input" type="search" placeholder="搜索会话 id、profile 或文件" aria-label="搜索会话" />
            </div>
            <div class="row">
              <select v-model="listProfile" class="select" aria-label="按 profile 筛选">
                <option value="all">全部 profile</option>
                <option v-for="profile in store.profiles" :key="profile.id" :value="profile.id">{{ profile.id }}</option>
              </select>
              <button v-if="hasListFilters" type="button" class="btn btn-ghost btn-sm" @click="resetListFilters">清除</button>
            </div>
            <div class="row">
              <input v-model="listFrom" class="input" type="date" aria-label="活动起始日期" />
              <span class="faint small">至</span>
              <input v-model="listTo" class="input" type="date" aria-label="活动结束日期" />
            </div>
          </div>
        </div>

        <div v-if="listBusy && sessions.length === 0" class="loading-list">
          <div v-for="index in 4" :key="index" class="skeleton skeleton-card"></div>
        </div>

        <EmptyState
          v-else-if="filteredSessions.length === 0"
          :title="sessions.length === 0 ? '暂无会话' : '没有匹配的会话'"
          :desc="sessions.length === 0 ? '运行时产生消息后会在这里出现。' : '调整关键词、profile 或时间范围。'"
          icon="sessions"
        >
          <button v-if="hasListFilters" type="button" class="btn btn-ghost btn-sm" @click="resetListFilters">清除筛选</button>
        </EmptyState>

        <div v-else class="list">
          <button
            v-for="session in filteredSessions"
            :key="session.id"
            type="button"
            class="list-item"
            :aria-current="selectedId === session.id ? 'true' : undefined"
            @click="selectSession(session)"
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
                <span>{{ formatNumber(session.turns) }} 轮</span>
                <span v-if="session.corrupt > 0" class="badge badge-danger">{{ session.corrupt }} 行损坏</span>
              </span>
            </span>
            <span class="list-item-side">
              <StatusBadge :state="session.state" />
              <time :title="formatDateTime(session.lastActivity)">{{ relativeTime(session.lastActivity) }}</time>
            </span>
          </button>
        </div>

        <div class="panel-foot">
          <span class="small muted">显示 {{ filteredSessions.length }} / {{ sessions.length }} 个会话</span>
          <span v-if="store.profiles.length === 0" class="small faint">尚未加载 profile 快照</span>
        </div>
      </section>

      <div class="detail-sticky stack">
        <section class="panel">
          <header class="panel-head">
            <div class="flex-1">
              <div class="panel-title mono">{{ selectedId.length > 0 ? selectedId : "未选择会话" }}</div>
              <div class="panel-sub">
                <template v-if="selectedSummary !== undefined">
                  {{ selectedSummary.profileId }} · {{ selectedSummary.domainLabel }} · {{ formatNumber(selectedSummary.messages) }} 条消息
                </template>
                <template v-else>从左侧选择会话，或在地址栏打开 /ishiki/sessions/&lt;id&gt;。</template>
              </div>
            </div>
            <div class="panel-actions">
              <StatusBadge v-if="selectedSummary !== undefined" :state="selectedSummary.state" />
              <CopyButton v-if="selectedId.length > 0" :value="selectedId" label="会话 id" />
              <button v-if="selectedId.length > 0" type="button" class="btn btn-soft btn-sm" :disabled="loading || retrying" @click="loadFirst(true)">
                <span v-if="loading" class="spinner" aria-hidden="true"></span>
                <Icon v-else name="refresh" :size="13" />
                刷新
              </button>
            </div>
          </header>

          <div v-if="selectedId.length === 0" class="panel-body">
            <EmptyState title="选择一个会话" desc="会话条目按游标分批读取，切换会话会从首个游标重新开始。" icon="sessions" />
          </div>

          <template v-else>
            <div class="panel-body stack-sm">
              <div class="session-meta-strip">
                <span
                  >条目 <strong>{{ formatNumber(entryCount) }}</strong></span
                >
                <span
                  >消息 <strong>{{ formatNumber(messageCount) }}</strong></span
                >
                <span
                  >轮次 <strong>{{ formatNumber(turnCount) }}</strong></span
                >
                <span
                  >tokens <strong>{{ formatCompact(tokenCount) }}</strong></span
                >
                <span :class="{ 'text-danger': corruptTotal > 0 }"
                  >损坏行 <strong>{{ formatNumber(corruptTotal) }}</strong></span
                >
                <span
                  >最后活动 <strong>{{ relativeTime(lastActivity) }}</strong></span
                >
                <span
                  >已加载 <strong>{{ formatNumber(entries.length) }}</strong></span
                >
              </div>

              <div v-if="selectedSummary !== undefined" class="row row-wrap">
                <button type="button" class="btn btn-sm btn-ghost" @click="openProfile">
                  <Icon name="profile" :size="13" />
                  打开 Profile
                </button>
                <button type="button" class="btn btn-sm btn-ghost" @click="openRuntime">
                  <Icon name="runtimes" :size="13" />
                  打开运行时
                </button>
                <span class="flex-1 file-path mono small faint">{{ selectedSummary.file }}</span>
                <CopyButton :value="selectedSummary.file" label="日志文件路径" />
              </div>

              <div v-else class="notice notice-info">
                <Icon name="info" :size="14" />
                <span>该会话不在当前列表快照中，条目仍会按 id 直接读取。</span>
              </div>

              <form class="entry-filters" @submit.prevent="applyFilters">
                <label class="field field-role">
                  <span class="field-label">角色</span>
                  <select v-model="roleFilter" class="select" @change="applyFilters">
                    <option value="all">全部</option>
                    <option v-for="role in ROLE_OPTIONS" :key="role" :value="role">{{ role }}</option>
                  </select>
                </label>
                <label class="field field-keyword">
                  <span class="field-label">关键词</span>
                  <input v-model="keywordDraft" class="input" type="search" placeholder="匹配条目内容的 JSON 文本" />
                </label>
                <label class="field field-date">
                  <span class="field-label">起始时间</span>
                  <input v-model="fromDate" class="input" type="date" @change="applyFilters" />
                </label>
                <label class="field field-date">
                  <span class="field-label">结束时间</span>
                  <input v-model="toDate" class="input" type="date" @change="applyFilters" />
                </label>
                <div class="entry-filter-actions">
                  <button type="submit" class="btn btn-primary btn-sm" :disabled="loading">应用筛选</button>
                  <button type="button" class="btn btn-ghost btn-sm" :disabled="!hasEntryFilters" @click="clearEntryFilters">清除筛选</button>
                </div>
              </form>

              <div v-if="corruptLines.length > 0" class="notice notice-warning">
                <Icon name="alert" :size="14" />
                <div class="flex-1">
                  <strong>已加载范围内有 {{ corruptLines.length }} 行无法解析</strong>
                  <ul class="corrupt-lines">
                    <li v-for="line in corruptLines" :key="line.line">第 {{ line.line }} 行 · {{ line.error }}</li>
                  </ul>
                  <button type="button" class="btn btn-sm btn-ghost" :disabled="retrying" @click="retryLast">
                    <span v-if="retrying" class="spinner" aria-hidden="true"></span>
                    <Icon v-else name="refresh" :size="13" />
                    重试读取
                  </button>
                </div>
              </div>
              <div v-else-if="corruptTotal > 0" class="notice notice-info">
                <Icon name="info" :size="14" />
                <span>整个日志文件有 {{ corruptTotal }} 行损坏，当前加载范围内没有遇到。</span>
              </div>

              <div v-if="error.length > 0" class="error-panel">
                <Icon name="alert" :size="15" />
                <div class="flex-1">
                  <strong>读取会话条目失败</strong>
                  <p class="small" style="margin-top: 4px">{{ error }}</p>
                </div>
                <button type="button" class="btn btn-sm btn-ghost" :disabled="retrying || loading" @click="retryLast">
                  {{ slices.length === 0 ? "重试" : "重试当前范围" }}
                </button>
              </div>

              <div v-if="loading" class="loading-list" aria-busy="true">
                <div v-for="index in 4" :key="index" class="skeleton skeleton-card"></div>
              </div>

              <EmptyState
                v-else-if="entries.length === 0 && error.length === 0"
                :title="hasEntryFilters ? '没有匹配的条目' : '会话还没有条目'"
                :desc="hasEntryFilters ? '当前筛选条件下没有匹配，清除筛选后可看到全部条目。' : '运行时会话在产生消息后写入日志。'"
                icon="inbox"
              >
                <button v-if="hasEntryFilters" type="button" class="btn btn-ghost btn-sm" @click="clearEntryFilters">清除筛选</button>
              </EmptyState>

              <template v-else-if="entries.length > 0">
                <div class="time-spine">
                  <SessionEntry v-for="entry in entries" :key="entry.id" :entry="entry" />
                </div>
                <div class="load-more">
                  <button v-if="nextCursor !== undefined" type="button" class="btn btn-soft btn-sm" :disabled="loadingMore" @click="loadMore">
                    <span v-if="loadingMore" class="spinner" aria-hidden="true"></span>
                    <Icon v-else name="chevronDown" :size="13" />
                    {{ loadingMore ? "加载中…" : "加载更多" }}
                  </button>
                  <span v-else class="small faint">已到末尾，共加载 {{ entries.length }} 条</span>
                </div>
              </template>
            </div>
          </template>
        </section>
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.list-search .row {
  flex-wrap: wrap;
}

.list-search .row > .select,
.list-search .row > .input {
  flex: 1 1 110px;
  min-width: 0;
}

.entry-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 12px;
}

.entry-filters .field {
  flex: 1 1 132px;
  min-width: 0;
}

.entry-filters .field-keyword {
  flex: 2 1 220px;
}

.entry-filter-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.file-path {
  min-width: 0;
  overflow-wrap: anywhere;
}

.corrupt-lines {
  margin: 6px 0 8px;
  padding-left: 18px;
  max-height: 150px;
  overflow: auto;
}

.corrupt-lines li {
  overflow-wrap: anywhere;
}

.error-panel p {
  overflow-wrap: anywhere;
}

.text-danger {
  color: var(--danger-ink);
}
</style>
