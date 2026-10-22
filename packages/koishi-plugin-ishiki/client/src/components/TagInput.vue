<script setup lang="ts">
import { ref } from "vue";

import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ modelValue: string[]; placeholder?: string; ariaLabel?: string }>(), {
  placeholder: "输入后按 Enter",
  ariaLabel: "添加条目",
});
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const draft = ref("");

function commit(): void {
  const value = draft.value.trim();
  if (value.length === 0) return;
  if (!props.modelValue.includes(value)) emit("update:modelValue", [...props.modelValue, value]);
  draft.value = "";
}

function remove(value: string): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((entry) => entry !== value),
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === "," || event.key === "，") {
    event.preventDefault();
    commit();
  } else if (event.key === "Backspace" && draft.value.length === 0 && props.modelValue.length > 0) {
    remove(props.modelValue[props.modelValue.length - 1]);
  }
}

function onBlur(): void {
  if (draft.value.trim().length > 0) commit();
}
</script>

<template>
  <div class="tag-input">
    <span v-for="item in modelValue" :key="item" class="tag">
      {{ item }}
      <button type="button" :aria-label="`移除 ${item}`" @click="remove(item)">
        <Icon name="close" :size="11" />
      </button>
    </span>
    <input v-model="draft" :placeholder="modelValue.length === 0 ? placeholder : ''" :aria-label="ariaLabel" @keydown="onKeydown" @blur="onBlur" />
  </div>
</template>
