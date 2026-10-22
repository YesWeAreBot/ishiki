<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    desc?: string;
    closable?: boolean;
    closeOnBackdrop?: boolean;
    width?: string;
  }>(),
  { closable: true, closeOnBackdrop: true },
);

const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement>();
const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
let previousFocus: HTMLElement | null = null;

function focusable(): HTMLElement[] {
  if (dialog.value === undefined) return [];
  return [...dialog.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
    (element) => !element.hasAttribute("disabled") && element.offsetParent !== null,
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.closable) {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusable();
  if (elements.length === 0) return;
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.body.style.overflow = "hidden";
      await nextTick();
      const elements = focusable();
      (elements[0] ?? dialog.value)?.focus();
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
    <div v-if="open" class="modal-backdrop" @mousedown.self="closeOnBackdrop && closable && emit('close')">
      <div
        ref="dialog"
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :style="width === undefined ? undefined : { width }"
        @keydown="onKeydown"
      >
        <div class="modal-head">
          <div class="flex-1">
            <h2 :id="titleId" class="modal-title">{{ title }}</h2>
            <p v-if="desc !== undefined" class="modal-desc">{{ desc }}</p>
          </div>
          <button v-if="closable" type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="关闭" @click="emit('close')">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
