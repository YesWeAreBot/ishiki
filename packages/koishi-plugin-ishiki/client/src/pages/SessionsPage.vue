<script setup lang="ts">
import { computed, ref, watch } from "vue";

import CopyButton from "../components/CopyButton.vue";
import EmptyState from "../components/EmptyState.vue";
import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import SessionEntry from "../components/SessionEntry.vue";
import StatusBadge from "../components/StatusBadge.vue";
import type { LogEntry, SessionDetail, SessionSummary } from "../data/types";
import { formatCompact, relativeTime } from "../lib/format";
import { loadSession, navigate, refreshSessions, sessionById, store } from "../store";

const listQuery = ref("");
const profileFilter = ref("all");
const selectedId = ref("");
const detail = ref<SessionDetail | undefined>(undefined);
const detailLoading = ref(false);
const detailError = ref("");
const roleFilter = ref("all");
const messageQuery = ref("");
const exceptionalOnly = ref(false);
const visibleCount = ref(20);
let loadToken = 0;

const filteredSessions = computed(() => {
  const term = listQuery.value.trim().toLowerCase();
  return store.sessions.filter((session) => {
    if (profileFilter.value !== "all" && session.profileId !== profileFilter.value) return false;
    if (term.length === 0) return true;
    return (
      session.id.toLowerCase().includes(term) ||
      session.profileId.toLowerCase().includes(term) ||
      session.domainLabel.toLowerCase().includes(term) ||
      session.file.toLowerCase().includes(term)
    );
  });
});

const selectedSummary = computed(() => sessionById(selectedId.value));

function readQuery(): string {
  return new URLSearchParams(store.query).get("id") ?? "";
}

function syncSelection(): void {
  const fromQuery = readQuery();
  if (fromQuery.length > 0 && sessionById(fromQuery) !== undefined) {
    selectedId.value = fromQuery;
    return;
  }
  if (selectedId.value.length > 0 && sessionById(selectedId.value) !== undefined) return;
  selectedId.value = store.sessions[0]?.id ?? "";
}

watch(() => store.query, syncSelection, { immediate: true });
watch(
  () => store.sessions.map((session) => session.id).join("|"),
  () => {
    if (sessionById(selectedId.value) === undefined) selectedId.value = store.sessions[0]?.id ?? "";
  },
);

watch(
  selectedId,
  async (id) => {
    detail.value = undefined;
    detailError.value = "";
    visibleCount.value = 20;
    roleFilter.value = "all";
    messageQuery.value = "";
    exceptionalOnly.value = false;
    if (id.length === 0) return;
    const token = ++loadToken;
    detailLoading.value = true;
    try {
      const result = await loadSession(id);
      if (token !== loadToken) return;
      detail.value = result;
    } catch (error) {
      if (token !== loadToken) return;
      detailError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === loadToken) detailLoading.value = false;
    }
  },
  { immediate: true },
);

function select(session: SessionSummary): void {
  selectedId.value = session.id;
  navigate("/sessions", `id=${encodeURIComponent(session.id)}`);
}

async function retry(): Promise<void> {
  const id = selectedId.value;
  if (id.length === 0) return;
  detailLoading.value = true;
  detailError.value = "";
  const token = ++loadToken;
  try {
    detail.value = await loadSession(id);
  } catch (error) {
    if (token === loadToken) detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === loadToken) detailLoading.value = false;
  }
}

function entryRole(entry: LogEntry): string {
  if (entry.type === "event") return "event";
  if (entry.type === "state") return "state";
  if (entry.type === "message") {
    const role = String(entry.data.role ?? "");
    return role === "custom" ? "custom" : role;
  }
  return "custom";
}

function isExceptional(entry: LogEntry): boolean {
  if (entry.type === "event" && (entry.data.type === "turn.failed" || entry.data.type === "turn.aborted")) return true;
  if (entry.type === "message" && entry.data.role === "tool") {
    return (
      (entry.data.content as Array<Record<string, any>> | undefined)?.some(
        (part) => part.output?.type === "error-text" || part.output?.type === "error-json",
      ) ?? false
    );
  }
  return false;
}

const filteredEntries = computed(() => {
  if (detail.value === undefined) return [];
  const term = messageQuery.value.trim().toLowerCase();
  return detail.value.entries.filter((entry) => {
    if (roleFilter.value !== "all" && entryRole(entry) !== roleFilter.value) return false;
    if (exceptionalOnly.value && !isExceptional(entry)) return false;
    if (term.length === 0) return true;
    return (
      JSON.stringify(entry.data).toLowerCase().includes(term) || entry.id.toLowerCase().includes(term) || (entry.turnId ?? "").toLowerCase().includes(term)
    );
  });
});

const visibleEntries = computed(() => filteredEntries.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < filteredEntries.value.length);

watch([roleFilter, messageQuery, exceptionalOnly], () => {
  visibleCount.value = 20;
});

function openProfile(id: string): void {
  navigate("/profiles", `id=${encodeURIComponent(id)}`);
}

function openRuntime(id: string): void {
  navigate("/runtimes", `id=${encodeURIComponent(id)}`);
}
</script>

<template>
  <PageHeader
    title="会话浏览"
    desc="每个 runtime 对应一份 events.jsonl。这里读取已持久化的消息、轮次事件与状态快照；长会话按页加载，消息可折叠。"
    eyebrow="运行 / 会话日志"
  >
    <template #actions>
      <button type="button" class="btn" :disabled="store.sessionListLoading" @click="refreshSessions()">
        <span v-if="store.sessionListLoading" class="spinner" aria-hidden="true"></span>
        <Icon v-else name="refresh" :size="15" />
        {{ store.sessionListLoading ? "刷新中…" : "刷新列表" }}
      </button>
    </template>
  </PageHeader>

  <div class="split split-wide">
    <div class="panel detail-sticky">
      <div class="panel-head" style="padding-bottom: 12px">
        <div class="panel-title">会话</div>
        <div class="panel-actions">
          <span class="badge badge-outline">{{ store.sessions.length }}</span>
        </div>
      </div>
      <div class="list-search">
        <div class="search-box">
          <Icon name="search" :size="15" />
          <input v-model="listQuery" class="input" aria-label="搜索会话" placeholder="搜索实例、Profile 或文件" />
        </div>
        <select v-model="profileFilter" class="select" aria-label="按 Profile 筛选" style="margin-top: 8px">
          <option value="all">全部 Profile</option>
          <option v-for="profile in store.profiles" :key="profile.id" :value="profile.id">{{ profile.id }}</option>
        </select>
      </div>

      <div v-if="store.sessionListLoading" class="loading-list">
        <div v-for="index in 4" :key="index" class="stack-sm" style="padding: 4px 0">
          <div class="skeleton skeleton-line" style="width: 56%"></div>
          <div class="skeleton skeleton-line" style="width: 84%"></div>
          <div class="skeleton skeleton-line" style="width: 38%"></div>
        </div>
      </div>
      <div v-else-if="filteredSessions.length === 0" class="empty">
        <div class="empty-mark"><Icon name="inbox" :size="20" /></div>
        <div class="empty-title">没有匹配的会话</div>
        <p class="empty-desc">清除搜索或切换 Profile。停止 Profile 不会删除已有会话日志。</p>
        <button
          type="button"
          class="btn btn-soft"
          @click="
            listQuery = '';
            profileFilter = 'all';
          "
        >
          清除筛选
        </button>
      </div>
      <div v-else class="list">
        <button
          v-for="session in filteredSessions"
          :key="session.id"
          type="button"
          class="list-item"
          :aria-current="selectedId === session.id ? 'true' : undefined"
          @click="select(session)"
        >
          <div class="list-item-main">
            <div class="list-item-title">
              <span class="mono">{{ session.domainLabel }}</span>
              <StatusBadge :state="session.state" />
            </div>
            <div v-if="session.state === 'error'" class="list-item-meta">
              <span>日志读取失败</span>
            </div>
            <div v-else class="list-item-meta">
              <span>{{ session.profileId }}</span>
              <span>{{ session.entries }} 条</span>
              <span>{{ session.turns }} 轮</span>
            </div>
            <div class="list-item-meta" style="margin-top: 4px">
              <span class="mono" style="font-size: 10px">{{ session.id }}</span>
            </div>
            <div v-if="session.error" class="small" style="color: var(--danger-ink); margin-top: 4px">{{ session.error }}</div>
          </div>
          <div class="list-item-side">
            <time>{{ relativeTime(session.lastActivity) }}</time>
            <Icon name="chevron" :size="14" />
          </div>
        </button>
      </div>
    </div>

    <div v-if="selectedSummary === undefined" class="panel">
      <EmptyState title="选择一个会话" desc="左侧列表来自 runtime 的 events.jsonl。选择后可浏览消息、轮次事件与状态快照。" icon="sessions" />
    </div>

    <div v-else class="stack">
      <div class="panel">
        <div class="panel-head">
          <div class="flex-1">
            <div class="row row-wrap">
              <span class="panel-title mono" style="font-size: 13px">{{ selectedSummary.id }}</span>
              <StatusBadge :state="selectedSummary.state" />
              <span class="badge badge-outline">{{ selectedSummary.mode }}</span>
            </div>
            <div class="panel-sub" style="margin-top: 4px">
              <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openProfile(selectedSummary.profileId)">
                Profile {{ selectedSummary.profileId }}
              </button>
              <span class="faint"> · </span>
              <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openRuntime(selectedSummary.runtimeId)">
                Runtime {{ selectedSummary.runtimeId }}
              </button>
            </div>
          </div>
          <div class="panel-actions">
            <CopyButton :value="selectedSummary.id" label="会话 ID" />
          </div>
        </div>
        <div class="panel-body" style="padding-top: 14px">
          <div class="session-meta-strip" style="border: 0; padding: 0; background: transparent">
            <span v-if="selectedSummary.state === 'error'">记录 <strong>—</strong></span>
            <span v-else
              >记录 <strong>{{ selectedSummary.entries }}</strong></span
            >
            <span
              >消息 <strong>{{ selectedSummary.state === "error" ? "—" : selectedSummary.messages }}</strong></span
            >
            <span
              >轮次 <strong>{{ selectedSummary.state === "error" ? "—" : selectedSummary.turns }}</strong></span
            >
            <span
              >tokens <strong>{{ selectedSummary.state === "error" ? "—" : formatCompact(selectedSummary.tokens) }}</strong></span
            >
            <span
              >最后活动 <strong>{{ relativeTime(selectedSummary.lastActivity) }}</strong></span
            >
          </div>
          <div class="copy-line" style="margin-top: 9px">
            <Icon name="file" :size="13" />
            <code class="muted">{{ selectedSummary.file }}</code>
            <CopyButton :value="selectedSummary.file" label="文件路径" />
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head" style="padding-bottom: 0" v-if="detail !== undefined">
          <div class="tabs" role="tablist" aria-label="会话条目筛选" style="border-bottom: 0">
            <button
              v-for="option in [
                { value: 'all', label: '全部' },
                { value: 'user', label: '频道消息' },
                { value: 'assistant', label: '助手' },
                { value: 'tool', label: '工具' },
                { value: 'custom', label: '自定义' },
                { value: 'event', label: '事件' },
                { value: 'state', label: '状态' },
              ]"
              :key="option.value"
              type="button"
              class="tab"
              :aria-selected="roleFilter === option.value"
              @click="roleFilter = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div v-if="detail !== undefined" class="panel-body" style="padding-top: 12px; padding-bottom: 12px">
          <div class="row row-wrap">
            <div class="search-box flex-1" style="min-width: 220px">
              <Icon name="search" :size="15" />
              <input v-model="messageQuery" class="input" aria-label="搜索会话内容" placeholder="搜索消息内容、条目 ID 或 turn ID" />
            </div>
            <label class="check">
              <input v-model="exceptionalOnly" type="checkbox" />
              仅看失败 / 中断
            </label>
            <span class="spacer"></span>
            <span class="field-hint">筛选结果 {{ filteredEntries.length }} / {{ detail?.entries.length ?? selectedSummary.entries }} 条</span>
          </div>
        </div>

        <div v-if="detailLoading" class="panel-body">
          <div class="time-spine">
            <div v-for="index in 5" :key="index" class="log-entry">
              <div class="skeleton" style="width: 24px; height: 24px; border-radius: 50%; margin-top: 9px"></div>
              <div class="skeleton skeleton-card" style="height: 92px"></div>
            </div>
          </div>
        </div>

        <div v-else-if="detailError.length > 0" class="panel-body">
          <div class="error-panel" role="alert">
            <Icon name="alert" :size="16" />
            <div class="flex-1">
              <strong>会话日志读取失败</strong>
              <div>{{ detailError }}</div>
              <div class="small" style="margin-top: 6px">
                文件路径：<span class="mono">{{ selectedSummary.file }}</span>
              </div>
              <button type="button" class="btn btn-sm" style="margin-top: 10px" @click="retry"><Icon name="refresh" :size="13" /> 重试读取</button>
            </div>
          </div>
        </div>

        <div v-else-if="filteredEntries.length === 0" class="empty">
          <div class="empty-mark"><Icon name="filter" :size="20" /></div>
          <div class="empty-title">没有匹配的条目</div>
          <p class="empty-desc">清除搜索、切换角色筛选或取消「仅看失败 / 中断」。</p>
          <button
            type="button"
            class="btn btn-soft"
            @click="
              messageQuery = '';
              roleFilter = 'all';
              exceptionalOnly = false;
            "
          >
            清除筛选
          </button>
        </div>

        <div v-else class="panel-body">
          <div class="time-spine">
            <SessionEntry v-for="entry in visibleEntries" :key="entry.id" :entry="entry" />
          </div>
          <div v-if="hasMore" class="load-more">
            <button type="button" class="btn btn-soft" @click="visibleCount += 20">
              加载更多 <span class="mono">（已显示 {{ visibleEntries.length }} / {{ filteredEntries.length }}）</span>
            </button>
          </div>
          <div v-else class="load-more">
            <span class="field-hint">已到末尾 · 共 {{ filteredEntries.length }} 条</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
