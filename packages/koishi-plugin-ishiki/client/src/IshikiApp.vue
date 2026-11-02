<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";

import Icon from "./components/Icon.vue";
import ToastHost from "./components/ToastHost.vue";
import { useIshikiTheme } from "./lib/theme";
import { store } from "./store";

defineOptions({ name: "IshikiApp" });

interface PageEntry {
  id: string;
  path: string;
  label: string;
  icon: string;
  component: Component;
}

const pages: PageEntry[] = [
  {
    id: "models",
    path: "/ishiki/models",
    label: "模型目录",
    icon: "models",
    component: defineAsyncComponent(() => import("./pages/ModelsPage.vue")),
  },
  {
    id: "profiles",
    path: "/ishiki/profiles",
    label: "人格配置",
    icon: "profile",
    component: defineAsyncComponent(() => import("./pages/ProfilesPage.vue")),
  },
  {
    id: "runtimes",
    path: "/ishiki/runtimes",
    label: "运行实例",
    icon: "runtimes",
    component: defineAsyncComponent(() => import("./pages/RuntimesPage.vue")),
  },
  {
    id: "jev",
    path: "/ishiki/jev",
    label: "唤醒判定",
    icon: "pulse",
    component: defineAsyncComponent(() => import("./pages/JevPage.vue")),
  },
  {
    id: "sessions",
    path: "/ishiki/sessions",
    label: "会话日志",
    icon: "sessions",
    component: defineAsyncComponent(() => import("./pages/SessionsPage.vue")),
  },
  {
    id: "usage",
    path: "/ishiki/usage",
    label: "用量统计",
    icon: "usage",
    component: defineAsyncComponent(() => import("./pages/UsagePage.vue")),
  },
];

const order = ["models", "profiles", "runtimes", "sessions", "jev", "usage"] as const;

const profileSnapshotReady = computed(() => store.engines !== undefined);
const jevEnabled = computed(() => profileSnapshotReady.value && store.profiles.some((profile) => profile.state === "active" && profile.wakeupEngine === "jev"));
const navPages = computed(() =>
  order.flatMap((id) => {
    if (id === "jev" && !jevEnabled.value) return [];
    const page = pages.find((entry) => entry.id === id);
    return page === undefined ? [] : [page];
  }),
);

const route = useRoute();
const router = useRouter();
const mainContent = ref<HTMLElement>();
const { isDark } = useIshikiTheme();

const segments = computed<string[]>(() => {
  const raw = route.params.page;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return typeof raw === "string" ? [raw] : [];
});

const activeId = computed(() => {
  const first = segments.value[0];
  if (first === "jev" && !jevEnabled.value) return "models";
  return pages.some((page) => page.id === first) ? first : "models";
});

watch([profileSnapshotReady, jevEnabled, segments], () => {
  if (profileSnapshotReady.value && !jevEnabled.value && segments.value[0] === "jev") void router.push("/ishiki/models");
});

watch(activeId, async () => {
  await nextTick();
  mainContent.value?.focus({ preventScroll: true });
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
      <a class="skip-link" href="#ishiki-main">跳到主要内容</a>
      <div class="console-shell">
        <header class="topbar">
          <nav class="topbar-nav" aria-label="Ishiki 页面">
            <button
              v-for="page in navPages"
              :key="page.id"
              type="button"
              class="topbar-item"
              :class="{ active: page.id === activeId }"
              :aria-current="page.id === activeId ? 'page' : undefined"
              @click="go(page)"
            >
              <Icon class="topbar-item-icon" :name="page.icon" :size="16" />
              <span>{{ page.label }}</span>
            </button>
          </nav>
        </header>

        <main id="ishiki-main" ref="mainContent" class="console-main" tabindex="-1">
          <component :is="current.component" :key="activeId" />
        </main>
      </div>
      <ToastHost />
    </div>
  </k-layout>
</template>
