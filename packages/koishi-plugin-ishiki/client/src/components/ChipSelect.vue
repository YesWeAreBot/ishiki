<script setup lang="ts">
import { computed } from "vue";

/** 枚举多选：chip 即当前生效值，顺序固定为选项声明顺序。 */
const props = withDefaults(
  defineProps<{ modelValue: string[]; options: ReadonlyArray<{ value: string; label: string }>; disabled?: boolean; ariaLabel?: string }>(),
  {
    ariaLabel: "选择条目",
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const order = computed(() => new Map(props.options.map((option) => [option.value, props.options.indexOf(option)])));

const selected = computed(() => props.options.filter((option) => props.modelValue.includes(option.value)).map((option) => option.value));

function toggle(value: string): void {
  if (props.disabled === true) return;
  const next = props.modelValue.includes(value) ? props.modelValue.filter((item) => item !== value) : [...props.modelValue, value];
  // 按选项声明顺序稳定输出，避免提交数据随点选顺序漂移。
  next.sort((left, right) => (order.value.get(left) ?? 0) - (order.value.get(right) ?? 0));
  emit("update:modelValue", next);
}
</script>

<template>
  <div class="chip-set" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="chip-toggle"
      :aria-pressed="selected.includes(option.value)"
      :disabled="disabled"
      @click="toggle(option.value)"
    >
      {{ option.label }}
    </button>
    <p v-if="options.length === 0" class="field-hint">没有可选项。</p>
  </div>
</template>
