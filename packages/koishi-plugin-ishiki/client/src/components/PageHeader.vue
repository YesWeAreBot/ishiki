<script setup lang="ts">
withDefaults(defineProps<{ title: string; desc?: string; eyebrow?: string }>(), {});
</script>

<template>
  <header class="page-header">
    <div class="page-header-main">
      <div v-if="eyebrow !== undefined" class="eyebrow">{{ eyebrow }}</div>
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="desc !== undefined" class="page-desc">{{ desc }}</p>
    </div>
    <div v-if="$slots.actions" class="page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
