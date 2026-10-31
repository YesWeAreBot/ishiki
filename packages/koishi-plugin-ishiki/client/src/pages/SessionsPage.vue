<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import Icon from "../components/Icon.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import SessionListPanel from "../components/SessionListPanel.vue";
import SessionWorkspace from "../components/SessionWorkspace.vue";
import { useSessionsList } from "../composables/useSessionsList";
import { store } from "../store";
import type { SessionSummary } from "../types";

const route = useRoute();
const router = useRouter();
const { sessions, busy: listBusy, refresh: refreshList } = useSessionsList();

const selectedId = computed(() => {
  const raw = route.params.page;
  const segments = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return segments[0] === "sessions" && typeof segments[1] === "string" ? segments[1] : "";
});

const selectedSummary = computed(() => sessions.value.find((session) => session.id === selectedId.value));
const profileIds = computed(() => store.profiles.map((profile) => profile.id));

function selectSession(session: SessionSummary): void {
  if (session.id === selectedId.value) return;
  void router.push(`/ishiki/sessions/${encodeURIComponent(session.id)}`);
}
</script>

<template>
  <PageShell class="sessions-page">
    <PageHeader title="会话日志" desc="按时间浏览会话中的消息记录。会话列表与消息窗口分别滚动，选择一项即可查看完整上下文。" eyebrow="运行 / 会话日志">
      <template #actions>
        <button type="button" class="btn btn-soft btn-sm" :disabled="listBusy" @click="refreshList">
          <span v-if="listBusy" class="spinner" aria-hidden="true"></span>
          <Icon v-else name="refresh" :size="14" />
          刷新列表
        </button>
      </template>
    </PageHeader>

    <div class="sessions-layout">
      <SessionListPanel :sessions="sessions" :selected-id="selectedId" :busy="listBusy" :profile-ids="profileIds" @select="selectSession" />
      <SessionWorkspace :selected-id="selectedId" :summary="selectedSummary" />
    </div>
  </PageShell>
</template>

<style scoped>
.sessions-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--header-height, 3rem) - var(--footer-height, 1.75rem));
  height: calc(100dvh - var(--header-height, 3rem) - var(--footer-height, 1.75rem));
  min-height: 0;
  padding-bottom: 16px;
  overflow: hidden;
}

.sessions-page .page-header {
  flex: none;
  margin-bottom: 14px;
  padding-bottom: 14px;
}

.sessions-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(250px, 292px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
}

@media (max-width: 1080px) {
  .sessions-layout {
    grid-template-columns: 250px minmax(0, 1fr);
    gap: 10px;
  }
}

@media (max-width: 900px) {
  .sessions-page {
    --console-mobile-nav-height: 51px;
    height: calc(100vh - var(--header-height, 3rem) - var(--footer-height, 1.75rem) - var(--console-mobile-nav-height));
    height: calc(100dvh - var(--header-height, 3rem) - var(--footer-height, 1.75rem) - var(--console-mobile-nav-height));
    padding-bottom: 12px;
  }

  .sessions-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(120px, 24vh) minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .sessions-page {
    padding-bottom: 10px;
  }

  .sessions-page .page-header {
    margin-bottom: 10px;
  }

  .sessions-layout {
    grid-template-rows: minmax(150px, 26vh) minmax(0, 1fr);
  }
}
</style>
