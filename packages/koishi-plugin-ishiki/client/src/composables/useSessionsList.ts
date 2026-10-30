import { computed, ref, watch } from "vue";

import { ApiError, call } from "../api";
import { store, toast } from "../store";
import type { SessionFilters, SessionSummary } from "../types";

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function useSessionsList() {
  const refreshedSessions = ref<SessionSummary[] | undefined>(undefined);
  const sessions = computed(() => refreshedSessions.value ?? store.sessions);
  const busy = ref(false);

  watch(
    () => store.sessions,
    () => {
      refreshedSessions.value = undefined;
    },
  );

  async function refresh(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      const filters: SessionFilters = {};
      const list = await call<SessionSummary[]>("ishiki/sessions/list", filters);
      refreshedSessions.value = list;
      toast("success", "会话列表已刷新", `服务端扫描到 ${list.length} 个会话。`);
    } catch (error_) {
      toast("error", "刷新会话列表失败", describe(error_));
    } finally {
      busy.value = false;
    }
  }

  return {
    sessions,
    busy,
    refresh,
  };
}
