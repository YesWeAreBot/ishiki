<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ open: boolean; title: string; desc?: string; width?: string }>(), {});
const emit = defineEmits<{ close: [] }>();
const drawer = ref<HTMLElement>();
const titleId = `drawer-title-${Math.random().toString(36).slice(2, 9)}`;
let previousFocus: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  emit("close");
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.body.style.overflow = "hidden";
      await nextTick();
      drawer.value?.focus();
    } else {
      document.body.style.overflow = "";
      previousFocus?.focus();
      previousFocus = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-backdrop" @mousedown.self="emit('close')">
      <section
        ref="drawer"
        class="drawer"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :style="width === undefined ? undefined : { width }"
        @keydown="onKeydown"
      >
        <header class="drawer-head">
          <div class="flex-1">
            <h2 :id="titleId" class="drawer-title">{{ title }}</h2>
            <p v-if="desc !== undefined" class="drawer-sub">{{ desc }}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="关闭" @click="emit('close')">
            <Icon name="close" :size="16" />
          </button>
        </header>
        <div class="drawer-body">
          <slot />
        </div>
        <footer class="drawer-foot">
          <slot name="footer" />
        </footer>
      </section>
    </div>
  </Teleport>
</template>
