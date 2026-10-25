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
  icon: string;
  component: Component;
}

interface NavNode {
  id: string;
  label: string;
  page?: PageEntry;
  children?: NavNode[];
}

const pages: PageEntry[] = [
  { id: "models", path: "/ishiki/models", label: "模型目录", icon: "models", component: defineAsyncComponent(() => import("./pages/ModelsPage.vue")) },
  { id: "profiles", path: "/ishiki/profiles", label: "人格配置", icon: "profile", component: defineAsyncComponent(() => import("./pages/ProfilesPage.vue")) },
  { id: "runtimes", path: "/ishiki/runtimes", label: "运行实例", icon: "runtimes", component: defineAsyncComponent(() => import("./pages/RuntimesPage.vue")) },
  { id: "sessions", path: "/ishiki/sessions", label: "会话日志", icon: "sessions", component: defineAsyncComponent(() => import("./pages/SessionsPage.vue")) },
  { id: "usage", path: "/ishiki/usage", label: "用量统计", icon: "usage", component: defineAsyncComponent(() => import("./pages/UsagePage.vue")) },
  { id: "cache", path: "/ishiki/cache", label: "缓存状态", icon: "cache", component: defineAsyncComponent(() => import("./pages/CachePage.vue")) },
];

const groups = [
  { label: "运行", ids: ["models", "profiles", "runtimes", "sessions"] },
  { label: "观测", ids: ["usage", "cache"] },
] as const;

const navTree: NavNode[] = groups.map((group) => ({
  id: `group:${group.label}`,
  label: group.label,
  children: group.ids.flatMap((id) => {
    const page = pages.find((entry) => entry.id === id);
    return page === undefined ? [] : [{ id: page.id, label: page.label, page }];
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

function onNodeClick(node: NavNode): void {
  if (node.page !== undefined) go(node.page);
}
</script>

<template>
  <k-layout main="darker">
    <template #left>
      <el-scrollbar>
        <el-tree
          :data="navTree"
          node-key="id"
          :default-expand-all="true"
          :current-node-key="activeId"
          :highlight-current="true"
          :expand-on-click-node="true"
          @node-click="onNodeClick"
        >
          <template #default="{ data }">
            <span class="label" :class="{ active: data.page !== undefined && data.id === activeId }">{{ data.label }}</span>
          </template>
        </el-tree>
      </el-scrollbar>
    </template>

    <div class="ishiki-root console-root" :class="{ 'is-dark': isDark }">
      <component :is="current.component" :key="activeId" />
      <ToastHost />
    </div>
  </k-layout>
</template>
