<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import BaseModal from "./components/BaseModal.vue";
import Icon from "./components/Icon.vue";
import ToastHost from "./components/ToastHost.vue";
import AuditPage from "./pages/AuditPage.vue";
import CachePage from "./pages/CachePage.vue";
import CostPage from "./pages/CostPage.vue";
import ModelsPage from "./pages/ModelsPage.vue";
import ProfilesPage from "./pages/ProfilesPage.vue";
import RuntimesPage from "./pages/RuntimesPage.vue";
import SessionsPage from "./pages/SessionsPage.vue";
import UsagePage from "./pages/UsagePage.vue";
import { clearDirty, hasDirty, navigate, store } from "./store";

const pageMap = {
  "/models": { group: "运行", label: "模型配置", icon: "models", component: ModelsPage },
  "/profiles": { group: "运行", label: "Profile", icon: "profile", component: ProfilesPage },
  "/sessions": { group: "运行", label: "会话浏览", icon: "sessions", component: SessionsPage },
  "/runtimes": { group: "运行", label: "AgentRuntime", icon: "runtimes", component: RuntimesPage },
  "/usage": { group: "观测", label: "用量", icon: "usage", component: UsagePage },
  "/audit": { group: "观测", label: "审计记录", icon: "audit", component: AuditPage },
  "/cache": { group: "观测", label: "缓存", icon: "cache", component: CachePage },
  "/cost": { group: "观测", label: "成本", icon: "cost", component: CostPage },
} as const;

type RoutePath = keyof typeof pageMap;

const route = computed<RoutePath>(() => (store.route in pageMap ? (store.route as RoutePath) : "/models"));
const currentPage = computed(() => pageMap[route.value]);
const pendingPath = ref<string | null>(null);
const leaveOpen = computed({
  get: () => pendingPath.value !== null,
  set: (value: boolean) => {
    if (!value) pendingPath.value = null;
  },
});

const storedTheme = localStorage.getItem("ishiki-demo-theme");
const theme = ref<"light" | "dark">(
  storedTheme === "light" || storedTheme === "dark" ? storedTheme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
);

const counts = computed(() => ({
  "/models": store.providers.reduce((sum, provider) => sum + provider.models.length, 0),
  "/profiles": store.profiles.length,
  "/sessions": store.sessions.length,
  "/runtimes": store.runtimes.length,
}));

const navGroups = [
  { label: "运行", items: ["/models", "/profiles", "/sessions", "/runtimes"] as RoutePath[] },
  { label: "观测", items: ["/usage", "/audit", "/cache", "/cost"] as RoutePath[] },
];

function countFor(path: RoutePath): number | undefined {
  return path === "/models" || path === "/profiles" || path === "/sessions" || path === "/runtimes" ? counts.value[path] : undefined;
}

function go(path: RoutePath): void {
  if (hasDirty.value) {
    pendingPath.value = path;
    return;
  }
  navigate(path);
}

function discardAndLeave(): void {
  const path = pendingPath.value;
  clearDirty();
  pendingPath.value = null;
  if (path !== null) window.location.hash = path;
}

function syncRoute(): void {
  const raw = window.location.hash.replace(/^#/, "") || "/models";
  const separator = raw.indexOf("?");
  store.route = separator === -1 ? raw : raw.slice(0, separator);
  store.query = separator === -1 ? "" : raw.slice(separator + 1);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasDirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function applyTheme(next: "light" | "dark"): void {
  document.documentElement.dataset.theme = next;
  localStorage.setItem("ishiki-demo-theme", next);
}

watch(theme, applyTheme, { immediate: true });

watch(route, () => window.scrollTo({ top: 0, behavior: "auto" }));

onMounted(() => {
  syncRoute();
  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("beforeunload", beforeUnload);
  if (!window.location.hash) window.location.hash = "/models";
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", syncRoute);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Ishiki 控制台导航">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <Icon name="pulse" :size="18" />
        </div>
        <div>
          <div class="brand-name">ishiki</div>
          <div class="brand-sub">console · 界面示例</div>
        </div>
      </div>

      <nav class="nav">
        <div v-for="group in navGroups" :key="group.label" class="nav-group">
          <div class="nav-label">{{ group.label }}</div>
          <button v-for="path in group.items" :key="path" type="button" class="nav-item" :aria-current="route === path ? 'page' : undefined" @click="go(path)">
            <Icon :name="pageMap[path].icon" :size="17" />
            <span>{{ pageMap[path].label }}</span>
            <span v-if="countFor(path) !== undefined" class="nav-count">{{ countFor(path) }}</span>
          </button>
        </div>
      </nav>

      <div class="sidebar-foot">
        <div class="demo-stamp">
          <span class="status-dot" aria-hidden="true"></span>
          <div>
            <strong>示例数据</strong>
            所有编辑与操作只作用于内存，不写入 models.yaml，不改变真实 Profile 或 AgentRuntime。
          </div>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumbs">
          <span>{{ currentPage.group }}</span>
          <span class="crumb-sep">/</span>
          <span class="current">{{ currentPage.label }}</span>
        </div>
        <div class="topbar-actions">
          <span class="demo-chip" title="示例页面，不连接真实数据">
            <span class="dot" aria-hidden="true"></span>
            示例数据
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            :aria-label="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
            :title="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
            @click="theme = theme === 'light' ? 'dark' : 'light'"
          >
            <Icon :name="theme === 'light' ? 'moon' : 'sun'" :size="16" />
          </button>
        </div>
      </header>

      <main id="main-content" class="page" tabindex="-1">
        <component :is="currentPage.component" :key="route" />
      </main>
    </div>
  </div>

  <BaseModal v-model:open="leaveOpen" title="有未保存的更改" desc="离开当前页面会丢弃尚未保存的表单内容。" @close="pendingPath = null">
    <p>配置保存状态与运行状态相互独立。当前编辑还没有写入示例数据，离开后不会保留。</p>
    <template #footer>
      <button type="button" class="btn" @click="pendingPath = null">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discardAndLeave">放弃更改并离开</button>
    </template>
  </BaseModal>

  <ToastHost />
</template>
