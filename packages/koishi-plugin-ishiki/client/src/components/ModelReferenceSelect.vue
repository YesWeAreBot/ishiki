<script setup lang="ts">
import { computed } from "vue";

import { THINK_LEVEL_LABELS, THINK_LEVELS, findDeclaredModel, modelOptions, parseReference } from "../lib/models";
import { store } from "../store";

defineOptions({ name: "ModelReferenceSelect" });

const props = withDefaults(defineProps<{ modelValue?: unknown; disabled?: boolean; required?: boolean }>(), {});

const emit = defineEmits<{ "update:modelValue": [value: string | undefined] }>();

const reference = computed(() => (typeof props.modelValue === "string" ? props.modelValue : ""));

const parsed = computed(() => {
  if (reference.value === "") return undefined;
  const value = parseReference(reference.value);
  if ("group" in value) return { kind: "group" as const, base: value.group, level: undefined };
  return { kind: "model" as const, base: `${value.provider}:${value.modelId}`, level: value.level };
});

const base = computed(() => parsed.value?.base ?? "");
const level = computed(() => parsed.value?.level ?? "");

const catalog = computed(() => modelOptions(store.providers, store.groups, { languageOnly: true }));
const groupChoices = computed(() => catalog.value.filter((row) => row.kind === "group"));
const modelChoices = computed(() => catalog.value.filter((row) => row.kind === "model"));

/** 目录里没有当前引用时保留原值，避免编辑其他字段时把配置改掉。 */
const missing = computed(() => parsed.value !== undefined && !catalog.value.some((row) => row.reference === parsed.value!.base));

const declaredLevels = computed(() => {
  if (parsed.value?.kind !== "model") return undefined;
  const efforts = findDeclaredModel(store.providers, base.value)?.model.thinking?.efforts;
  if (efforts === undefined || efforts.length === 0) return undefined;
  return THINK_LEVELS.filter((level) => efforts.includes(level));
});

const levels = computed<readonly string[]>(() => {
  if (declaredLevels.value === undefined) return THINK_LEVELS;
  const current = level.value;
  if (current !== "" && !declaredLevels.value.includes(current)) return [...declaredLevels.value, current];
  return declaredLevels.value;
});

function selectBase(next: string): void {
  if (next === "") {
    emit("update:modelValue", undefined);
    return;
  }
  const entry = catalog.value.find((row) => row.reference === next);
  if (entry?.kind === "group") {
    emit("update:modelValue", next);
    return;
  }
  emit("update:modelValue", withLevel(next, level.value));
}

function selectLevel(next: string): void {
  if (parsed.value?.kind !== "model") return;
  emit("update:modelValue", withLevel(base.value, next));
}

function withLevel(target: string, value: string): string {
  if (value === "") return target;
  const efforts = findDeclaredModel(store.providers, target)?.model.thinking?.efforts;
  if (efforts !== undefined && efforts.length > 0 && !efforts.includes(value)) return target;
  return `${target}:${value}`;
}
</script>

<template>
  <div class="model-reference">
    <select class="select" :value="base" :disabled="disabled" aria-label="模型或模型组" @change="selectBase(($event.target as HTMLSelectElement).value)">
      <option v-if="!required" value="">（未设置）</option>
      <option v-else-if="base === ''" value="" disabled>选择模型或模型组</option>
      <option v-if="missing && parsed !== undefined" :value="base">{{ base }}（目录中未找到）</option>
      <optgroup v-if="groupChoices.length > 0" label="模型组">
        <option v-for="row in groupChoices" :key="row.reference" :value="row.reference">{{ row.label }}</option>
      </optgroup>
      <optgroup v-if="modelChoices.length > 0" label="模型">
        <option v-for="row in modelChoices" :key="row.reference" :value="row.reference">{{ row.label }}（{{ row.provider }}）</option>
      </optgroup>
    </select>
    <select
      class="select model-reference-level"
      :value="level"
      :disabled="disabled || parsed?.kind !== 'model' || levels.length === 0"
      aria-label="思考等级"
      @change="selectLevel(($event.target as HTMLSelectElement).value)"
    >
      <option value="">默认思考等级</option>
      <option v-for="item in levels" :key="item" :value="item">{{ THINK_LEVEL_LABELS[item as keyof typeof THINK_LEVEL_LABELS] ?? item }}</option>
    </select>
  </div>
</template>

<style scoped>
.model-reference {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 156px;
  gap: 8px;
}

.model-reference-level:disabled {
  opacity: 0.6;
}

@media (max-width: 640px) {
  .model-reference {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
