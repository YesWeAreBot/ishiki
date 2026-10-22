<script setup lang="ts">
withDefaults(defineProps<{ checked: boolean; label: string; disabled?: boolean; hint?: string }>(), {});
const emit = defineEmits<{ "update:checked": [value: boolean] }>();
</script>

<template>
  <label class="switch">
    <input type="checkbox" :checked="checked" :disabled="disabled" @change="emit('update:checked', ($event.target as HTMLInputElement).checked)" />
    <span class="switch-track" aria-hidden="true"></span>
    <span
      >{{ label }}<span v-if="hint !== undefined" class="field-hint"> · {{ hint }}</span></span
    >
  </label>
</template>
