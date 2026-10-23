<script setup lang="ts">
import { computed, defineAsyncComponent, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";

import Icon from "./components/Icon.vue";
import ToastHost from "./components/ToastHost.vue";
import { useIshikiTheme } from "./lib/theme";

defineOptions({ name: "IshikiApp" });

interface PageEntry {
  id: string;
  path: string;
  label: string;
  icon: string;
  component: Component;
}

const pages: PageEntry[] = [
  { id: "models", path: "/ishiki/models", label: "模型目录", icon: "models", component: defineAsyncComponent(() => import("./pages/ModelsPage.vue")) },
  { id: "profiles", path: "/ishiki/profiles", label: "人格配置", icon: "profile", component: defineAsyncComponent(() => import("./pages/ProfilesPage.vue")) },
  { id: "runtimes", path: "/ishiki/runtimes", label: "运行实例", icon: "runtimes", component: defineAsyncComponent(() => import("./pages/RuntimesPage.vue")) },
  { id: "sessions", path: "/ishiki/sessions", label: "会话日志", icon: "sessions", component: defineAsyncComponent(() => import("./pages/SessionsPage.vue")) },
  { id: "usage", path: "/ishiki/usage", label: "用量统计", icon: "usage", component: defineAsyncComponent(() => import("./pages/UsagePage.vue")) },
  { id: "audit", path: "/ishiki/audit", label: "审计记录", icon: "audit", component: defineAsyncComponent(() => import("./pages/AuditPage.vue")) },
  { id: "cache", path: "/ishiki/cache", label: "缓存状态", icon: "cache", component: defineAsyncComponent(() => import("./pages/CachePage.vue")) },
];

const groups = [
  { label: "运行", ids: ["models", "profiles", "runtimes", "sessions"] },
  { label: "观测", ids: ["usage", "audit", "cache"] },
] as const;

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
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">
              <Icon name="models" :size="17" />
            </div>
            <div class="brand-text">
              <div class="brand-name">Ishiki</div>
              <div class="brand-sub">管理控制台</div>
            </div>
          </div>

          <nav class="nav" aria-label="Ishiki 页面">
            <div v-for="group in groups" :key="group.label" class="nav-group">
              <div class="nav-label">{{ group.label }}</div>
              <a
                v-for="id in group.ids"
                :key="id"
                :href="pages.find((page) => page.id === id)?.path"
                class="nav-item"
                :class="{ active: activeId === id }"
                :aria-current="activeId === id ? 'page' : undefined"
                @click.prevent="go(pages.find((page) => page.id === id)!)"
              >
                <Icon :name="pages.find((page) => page.id === id)!.icon" :size="16" />
                <span>{{ pages.find((page) => page.id === id)!.label }}</span>
              </a>
            </div>
          </nav>

          <div class="sidebar-foot">
            <div class="sidebar-note">
              <span class="dot" aria-hidden="true"></span>
              <span>实时数据服务</span>
            </div>
            <div class="sidebar-hint">保存会写入磁盘，运行状态随控制台推送刷新。</div>
          </div>
        </aside>

        <div class="main">
          <component :is="current.component" :key="activeId" />
        </div>
      </div>
      <ToastHost />
    </div>
  </k-layout>
</template>
