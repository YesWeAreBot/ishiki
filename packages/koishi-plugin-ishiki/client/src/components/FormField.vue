<script setup lang="ts">
withDefaults(defineProps<{ label?: string; required?: boolean; hint?: string; error?: string; warning?: string }>(), {});
</script>

<template>
  <label class="field">
    <span v-if="label !== undefined" class="field-label">
      {{ label }}
      <span v-if="required" class="required" aria-hidden="true">*</span>
    </span>
    <slot />
    <span v-if="hint !== undefined" class="field-hint">{{ hint }}</span>
    <span v-if="error !== undefined" class="field-error">{{ error }}</span>
    <span v-else-if="warning !== undefined" class="field-warning">{{ warning }}</span>
  </label>
</template>
