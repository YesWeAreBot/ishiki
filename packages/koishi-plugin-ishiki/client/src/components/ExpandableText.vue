<script setup lang="ts">
import { computed, ref } from "vue";

import CopyButton from "./CopyButton.vue";

/**
 * 超长文本的统一展示：默认摘要 + 展开 + 复制。
 * mode="ends" 保留可读的开头与结尾，用于模型标识、路径等需要确认对象的值；
 * mode="clamp" 折叠多行文本，用于配置内容与错误详情。
 */
const props = withDefaults(
  defineProps<{
    value: string;
    mode?: "ends" | "clamp";
    head?: number;
    tail?: number;
    clampHeight?: number;
    mono?: boolean;
    copyable?: boolean;
    copyLabel?: string;
    inline?: boolean;
  }>(),
  { mode: "ends", head: 18, tail: 10, clampHeight: 96, copyable: true, inline: false },
);

const expanded = ref(false);

const collapsible = computed(() => {
  if (props.mode === "clamp") return props.value.split("\n").length > 1 || props.value.length > 160;
  return props.value.length > props.head + props.tail + 3;
});

const summary = computed(() => {
  if (!collapsible.value) return props.value;
  return `${props.value.slice(0, props.head)}…${props.value.slice(-props.tail)}`;
});
</script>

<template>
  <span class="expandable" :class="{ 'expandable-inline': inline, mono: mono }">
    <span v-if="mode === 'ends' && collapsible && !expanded" class="expandable-summary" :title="value">{{ summary }}</span>
    <template v-else>
      <span v-if="mode === 'ends'" class="expandable-full">{{ value }}</span>
      <span v-else class="expandable-block" :style="expanded ? undefined : { maxHeight: `${clampHeight}px` }">{{ value }}</span>
    </template>
    <button v-if="collapsible" type="button" class="expandable-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? "收起" : "展开" }}
    </button>
    <CopyButton v-if="copyable" :value="value" :label="copyLabel ?? '内容'" />
  </span>
</template>

<style scoped>
.expandable {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.expandable-inline {
  display: inline-flex;
}

.expandable-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expandable-full {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.expandable-block {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
}

.expandable-toggle {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-ink);
  font-size: 11.5px;
  font-weight: 600;
}

.expandable :deep(.btn) {
  flex: none;
}

.expandable-toggle:hover {
  text-decoration: underline;
}
</style>
