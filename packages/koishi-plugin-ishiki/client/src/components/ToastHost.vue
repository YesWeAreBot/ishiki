<script setup lang="ts">
import { dismissToast, store } from "../store";
import Icon from "./Icon.vue";

function iconFor(tone: string): string {
  if (tone === "success") return "checkCircle";
  if (tone === "error") return "xCircle";
  return "info";
}
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <div v-for="message in store.toasts" :key="message.id" class="toast" :class="'toast-' + message.tone">
      <Icon class="toast-icon" :name="iconFor(message.tone)" :size="17" />
      <div class="flex-1">
        <div class="toast-title">{{ message.title }}</div>
        <div v-if="message.detail !== undefined" class="toast-detail">{{ message.detail }}</div>
      </div>
      <button type="button" class="toast-close" aria-label="关闭提示" @click="dismissToast(message.id)">
        <Icon name="close" :size="14" />
      </button>
    </div>
  </div>
</template>
