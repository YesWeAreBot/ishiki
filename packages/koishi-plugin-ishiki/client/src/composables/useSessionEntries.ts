import { useContext } from "@koishijs/client";
import { computed, ref, watch, type Ref } from "vue";

import { ApiError, call } from "../api";
import { dayEnd, dayStart } from "../lib/dateFilter";
import { toast } from "../store";
import type { CorruptLine, LogEntry, SessionEntries, SessionEntryFilters } from "../types";

const ENTRY_PAGE_SIZE = 100;

interface SessionsAppendedEvent {
  sessionId: string;
  profileId: string;
  runtimeId: string;
  timestamp: number;
}

interface ReadFailure {
  scope: "initial" | "older" | "latest";
  message: string;
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function mergeCorrupt(...groups: CorruptLine[][]): CorruptLine[] {
  const merged = new Map<number, CorruptLine>();
  for (const group of groups) {
    for (const line of group) merged.set(line.line, line);
  }
  return [...merged.values()].sort((left, right) => left.line - right.line);
}

function mergeEntries(base: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const seen = new Set(base.map((entry) => entry.id));
  return [...base, ...incoming.filter((entry) => !seen.has(entry.id))];
}

export function useSessionEntries(selectedId: Ref<string>) {
  const ctx = useContext();
  const entries = ref<LogEntry[]>([]);
  const corruptLines = ref<CorruptLine[]>([]);
  const stats = ref<SessionEntries["stats"] | undefined>(undefined);
  const olderCursor = ref<string | undefined>(undefined);
  const liveCursor = ref<string | undefined>(undefined);
  const loading = ref(false);
  const loadingOlder = ref(false);
  const refreshingLatest = ref(false);
  const failure = ref<ReadFailure | undefined>(undefined);
  const feedVersion = ref(0);

  const roleFilter = ref("all");
  const keywordDraft = ref("");
  const keyword = ref("");
  const fromDate = ref("");
  const toDate = ref("");

  const hasOlder = computed(() => olderCursor.value !== undefined);
  const hasEntryFilters = computed(() => roleFilter.value !== "all" || keyword.value.length > 0 || fromDate.value.length > 0 || toDate.value.length > 0);
  const liveStatus = computed(() => {
    if (loading.value) return "正在加载最新消息";
    if (refreshingLatest.value) return "正在同步新消息";
    if (loadingOlder.value) return "正在加载更早记录";
    return "";
  });

  let generation = 0;
  let pendingLiveRefresh = false;

  function currentFilters(): SessionEntryFilters {
    const filters: SessionEntryFilters = {};
    if (roleFilter.value !== "all") filters.role = roleFilter.value;
    if (keyword.value.length > 0) filters.keyword = keyword.value;
    const from = dayStart(fromDate.value);
    if (from !== undefined) filters.from = from;
    const to = dayEnd(toDate.value);
    if (to !== undefined) filters.to = to;
    return filters;
  }

  async function loadLatest(notify = false): Promise<void> {
    const id = selectedId.value;
    const token = ++generation;
    pendingLiveRefresh = false;
    loading.value = id.length > 0;
    loadingOlder.value = false;
    refreshingLatest.value = false;
    failure.value = undefined;
    entries.value = [];
    corruptLines.value = [];
    stats.value = undefined;
    olderCursor.value = undefined;
    liveCursor.value = undefined;
    feedVersion.value += 1;
    if (id.length === 0) {
      loading.value = false;
      return;
    }

    try {
      const result = await call<SessionEntries>("ishiki/sessions/entries", id, undefined, ENTRY_PAGE_SIZE, currentFilters(), "backward");
      if (token !== generation) return;
      entries.value = result.entries;
      corruptLines.value = result.corrupt;
      stats.value = result.stats;
      olderCursor.value = result.previousCursor;
      liveCursor.value = result.tailCursor;
      if (notify) toast("success", "会话已刷新", `已从最新位置载入 ${result.entries.length} 条记录。`);
    } catch (error_) {
      if (token !== generation) return;
      failure.value = { scope: "initial", message: describe(error_) };
      if (notify) toast("error", "刷新会话失败", failure.value.message);
    } finally {
      if (token === generation) {
        loading.value = false;
        if (pendingLiveRefresh) {
          pendingLiveRefresh = false;
          void refreshNewest();
        }
      }
    }
  }

  async function loadOlder(): Promise<void> {
    const id = selectedId.value;
    const cursor = olderCursor.value;
    if (id.length === 0 || cursor === undefined || loading.value || loadingOlder.value) return;
    const token = generation;
    loadingOlder.value = true;
    try {
      const result = await call<SessionEntries>("ishiki/sessions/entries", id, cursor, ENTRY_PAGE_SIZE, currentFilters(), "backward");
      if (token !== generation) return;
      entries.value = mergeEntries(result.entries, entries.value);
      corruptLines.value = mergeCorrupt(result.corrupt, corruptLines.value);
      stats.value = result.stats;
      olderCursor.value = result.previousCursor === cursor ? undefined : result.previousCursor;
      if (failure.value?.scope === "older") failure.value = undefined;
    } catch (error_) {
      if (token !== generation) return;
      failure.value = { scope: "older", message: describe(error_) };
    } finally {
      if (token === generation) {
        loadingOlder.value = false;
        if (pendingLiveRefresh) {
          pendingLiveRefresh = false;
          void refreshNewest();
        }
      }
    }
  }

  async function refreshNewest(): Promise<void> {
    const id = selectedId.value;
    const cursor = liveCursor.value;
    if (id.length === 0) return;
    if (loading.value || refreshingLatest.value || loadingOlder.value) {
      pendingLiveRefresh = true;
      return;
    }
    if (cursor === undefined) {
      await loadLatest();
      return;
    }

    const token = generation;
    refreshingLatest.value = true;
    let hasMore = false;
    try {
      const result = await call<SessionEntries>("ishiki/sessions/entries", id, cursor, ENTRY_PAGE_SIZE, currentFilters(), "forward");
      if (token !== generation) return;
      entries.value = mergeEntries(entries.value, result.entries);
      corruptLines.value = mergeCorrupt(corruptLines.value, result.corrupt);
      stats.value = result.stats;
      liveCursor.value = result.nextCursor ?? result.tailCursor;
      hasMore = result.nextCursor !== undefined;
      if (failure.value?.scope === "latest") failure.value = undefined;
    } catch (error_) {
      if (token !== generation) return;
      failure.value = { scope: "latest", message: describe(error_) };
    } finally {
      if (token === generation) {
        refreshingLatest.value = false;
        if (pendingLiveRefresh || hasMore) {
          pendingLiveRefresh = false;
          void refreshNewest();
        }
      }
    }
  }

  async function retryFailure(): Promise<void> {
    const scope = failure.value?.scope;
    if (scope === "older") await loadOlder();
    else if (scope === "latest") await refreshNewest();
    else await loadLatest();
  }

  function applyFilters(): void {
    keyword.value = keywordDraft.value.trim();
    void loadLatest();
  }

  function clearFilters(): void {
    roleFilter.value = "all";
    keyword.value = "";
    keywordDraft.value = "";
    fromDate.value = "";
    toDate.value = "";
    void loadLatest();
  }

  /* Console 的自定义广播不在 Cordis 静态事件表中，运行时仍然通过 ctx 分发。 */
  const listenSessionsAppended = ctx.on.bind(ctx) as unknown as (event: "sessions.appended", listener: (payload: SessionsAppendedEvent) => void) => void;

  listenSessionsAppended("sessions.appended", (payload) => {
    if (payload.sessionId !== selectedId.value) return;
    pendingLiveRefresh = true;
    void refreshNewest();
  });

  watch(selectedId, () => void loadLatest(), { immediate: true });

  return {
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
  };
}
