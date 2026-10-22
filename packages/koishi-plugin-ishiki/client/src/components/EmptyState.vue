<script setup lang="ts">
import Icon from "./Icon.vue";

withDefaults(defineProps<{ title: string; desc?: string; icon?: string }>(), { icon: "inbox" });
</script>

<template>
  <div class="empty">
    <div class="empty-mark"><Icon :name="icon" :size="20" /></div>
    <div class="empty-title">{{ title }}</div>
    <p v-if="desc !== undefined" class="empty-desc">{{ desc }}</p>
    <slot />
  </div>
</template>
