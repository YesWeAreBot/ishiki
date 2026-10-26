<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";

import ToastHost from "./components/ToastHost.vue";
import { useIshikiTheme } from "./lib/theme";

defineOptions({ name: "IshikiApp" });

interface PageEntry {
  id: string;
  path: string;
  label: string;
  component: Component;
}

const pages: PageEntry[] = [
  { id: "models", path: "/ishiki/models", label: "模型目录", component: defineAsyncComponent(() => import("./pages/ModelsPage.vue")) },
  { id: "profiles", path: "/ishiki/profiles", label: "人格配置", component: defineAsyncComponent(() => import("./pages/ProfilesPage.vue")) },
  { id: "runtimes", path: "/ishiki/runtimes", label: "运行实例", component: defineAsyncComponent(() => import("./pages/RuntimesPage.vue")) },
  { id: "sessions", path: "/ishiki/sessions", label: "会话日志", component: defineAsyncComponent(() => import("./pages/SessionsPage.vue")) },
  { id: "usage", path: "/ishiki/usage", label: "用量统计", component: defineAsyncComponent(() => import("./pages/UsagePage.vue")) },
  { id: "cache", path: "/ishiki/cache", label: "缓存状态", component: defineAsyncComponent(() => import("./pages/CachePage.vue")) },
];

const groups = [
  { label: "运行", ids: ["models", "profiles", "runtimes", "sessions"] },
  { label: "观测", ids: ["usage", "cache"] },
] as const;

const navGroups = groups.map((group) => ({
  label: group.label,
  pages: group.ids.flatMap((id) => {
    const page = pages.find((entry) => entry.id === id);
    return page === undefined ? [] : [page];
  }),
}));

const route = useRoute();
const router = useRouter();
const { isDark } = useIshikiTheme();

const segments = computed<string[]>(() => {
  const raw = route.params.page;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return typeof raw === "string" ? [raw] : [];
});

const activeId = computed(() => {
  const first = segments.value[0];
  return pages.some((page) => page.id === first) ? first : "models";
});

const current = computed(() => pages.find((page) => page.id === activeId.value) ?? pages[0]);

function go(page: PageEntry): void {
  if (route.path === page.path) return;
  void router.push(page.path);
}
</script>

<template>
  <k-layout main="darker">
    <div class="ishiki-root console-root" :class="{ 'is-dark': isDark }">
      <div class="console-shell">
        <aside class="console-sidebar" aria-label="Ishiki 导航">
          <div class="console-sidebar-inner">
            <div class="sidebar-brand">
              <span class="sidebar-mark" aria-hidden="true"><i /><i /><i /></span>
              <div>
                <div class="sidebar-name">Ishiki</div>
                <div class="sidebar-sub">意识运行时</div>
              </div>
            </div>

            <nav class="sidebar-nav">
              <div v-for="group in navGroups" :key="group.label" class="sidebar-group">
                <div class="sidebar-group-label">{{ group.label }}</div>
                <button
                  v-for="page in group.pages"
                  :key="page.id"
                  type="button"
                  class="sidebar-item"
                  :class="{ active: page.id === activeId }"
                  :aria-current="page.id === activeId ? 'page' : undefined"
                  @click="go(page)"
                >
                  {{ page.label }}
                </button>
              </div>
            </nav>

            <div class="sidebar-foot">
              <div class="sidebar-status"><span class="sidebar-dot" />控制台在线</div>
              <div>Koishi Console</div>
            </div>
          </div>
        </aside>

        <main class="console-main">
          <component :is="current.component" :key="activeId" />
        </main>
      </div>
      <ToastHost />
    </div>
  </k-layout>
</template>
