<script setup lang="ts">
import { computed } from "vue";

import { schemaDefaults } from "../lib/schema";
import type { SchemaNode } from "../types";
import ModelReferenceSelect from "./ModelReferenceSelect.vue";
import ToggleSwitch from "./ToggleSwitch.vue";

defineOptions({ name: "SchemaForm" });

const props = withDefaults(
  defineProps<{
    schema: SchemaNode;
    modelValue: unknown;
    label?: string;
    hint?: string;
    required?: boolean;
    error?: string;
    disabled?: boolean;
  }>(),
  {},
);

const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const kind = computed(() => props.schema.type);
const meta = computed(() => props.schema.meta ?? {});
const required = computed(() => props.required === true || meta.value.required === true);
const hint = computed(() => props.hint ?? (typeof meta.value.description === "string" ? meta.value.description : undefined));

/** intersect 合并所有对象分支，any 分支不提供字段。 */
const fields = computed<Array<[string, SchemaNode]>>(() => {
  const node = props.schema;
  if (node.type === "object") return Object.entries(node.dict ?? {});
  if (node.type === "intersect") {
    const merged = new Map<string, SchemaNode>();
    for (const branch of node.list ?? []) {
      for (const [key, child] of Object.entries(branch.dict ?? {})) merged.set(key, child);
    }
    return [...merged.entries()];
  }
  return [];
});

const record = computed<Record<string, unknown>>(() => {
  const value = props.modelValue;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
});

const constants = computed(() => {
  if (kind.value === "const") return [{ value: props.schema.value, label: hint.value ?? String(props.schema.value) }];
  if (kind.value !== "union") return undefined;
  const list = props.schema.list ?? [];
  if (list.length === 0 || list.some((item) => item.type !== "const")) return undefined;
  return list.map((item) => ({
    value: item.value,
    label: typeof item.meta.description === "string" ? item.meta.description : String(item.value),
  }));
});

const textarea = computed(() => meta.value.role === "textarea" || kind.value === "any");
const secret = computed(() => meta.value.role === "secret");

const jsonText = computed(() => {
  if (kind.value !== "any") return "";
  return JSON.stringify(props.modelValue ?? {}, null, 2);
});

const items = computed<unknown[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []));
const textValue = computed(() => (typeof props.modelValue === "string" ? props.modelValue : ""));
const numberValue = computed(() => (typeof props.modelValue === "number" ? props.modelValue : ""));
const dictEntries = computed<Array<[string, unknown]>>(() =>
  props.modelValue !== null && typeof props.modelValue === "object" && !Array.isArray(props.modelValue)
    ? Object.entries(props.modelValue as Record<string, unknown>)
    : [],
);

/** 复杂控件独占整行，标量字段在宽屏下并排。 */
function isWide(node: SchemaNode): boolean {
  if (node.type === "object" || node.type === "intersect" || node.type === "array" || node.type === "dict" || node.type === "any") return true;
  if (node.type === "string" && (node.meta.role === "textarea" || node.meta.role === "model")) return true;
  if (node.type === "union") return (node.list ?? []).some((item) => item.type !== "const");
  return false;
}

function updateField(key: string, value: unknown): void {
  emit("update:modelValue", { ...record.value, [key]: value });
}

function removeField(key: string): void {
  const next = { ...record.value };
  delete next[key];
  emit("update:modelValue", next);
}

function setArrayItem(index: number, value: unknown): void {
  const next = [...items.value];
  next[index] = value;
  emit("update:modelValue", next);
}

function removeArrayItem(index: number): void {
  emit(
    "update:modelValue",
    items.value.filter((_, position) => position !== index),
  );
}

function addArrayItem(): void {
  emit("update:modelValue", [...items.value, schemaDefaults(props.schema.inner)]);
}

function setDictItem(key: string, value: unknown): void {
  emit("update:modelValue", { ...record.value, [key]: value });
}

function renameDictItem(previous: string, key: string): void {
  if (key === previous) return;
  const next = { ...record.value };
  const value = next[previous];
  delete next[previous];
  next[key] = value;
  emit("update:modelValue", next);
}

function removeDictItem(key: string): void {
  const next = { ...record.value };
  delete next[key];
  emit("update:modelValue", next);
}

function addDictEntry(): void {
  const next = { ...record.value };
  let index = 1;
  while (next[`key${index}`] !== undefined) index += 1;
  next[`key${index}`] = schemaDefaults(props.schema.inner);
  emit("update:modelValue", next);
}

function onNumber(event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  emit("update:modelValue", raw === "" ? undefined : Number(raw));
}

function onJson(event: Event): void {
  const raw = (event.target as HTMLTextAreaElement).value;
  try {
    emit("update:modelValue", raw.trim() === "" ? undefined : JSON.parse(raw));
  } catch {
    // 保存前的校验会拒绝非法 JSON；输入过程中不打断用户。
  }
}
</script>

<template>
  <div v-if="kind === 'object' || kind === 'intersect'" class="schema-object">
    <div
      v-for="[key, child] in fields.filter(([, node]) => node.type !== 'const')"
      :key="key"
      class="schema-field"
      :class="{ 'is-wide': isWide(child), 'is-inline': child.type === 'boolean' }"
    >
      <span class="field-label">
        {{ typeof child.meta.description === "string" ? child.meta.description : key }}
        <span v-if="child.meta.required === true" class="required" aria-hidden="true">*</span>
      </span>
      <SchemaForm :schema="child" :model-value="record[key]" :disabled="disabled" @update:model-value="updateField(key, $event)" />
    </div>
    <p v-if="fields.length === 0" class="field-hint">没有可配置的字段。</p>
  </div>

  <select
    v-else-if="constants !== undefined"
    class="select"
    :value="modelValue"
    :disabled="disabled"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value === '' ? undefined : ($event.target as HTMLSelectElement).value)"
  >
    <option v-if="!required" value="">（未设置）</option>
    <option v-for="option in constants" :key="String(option.value)" :value="option.value">{{ option.label }}</option>
  </select>

  <textarea v-else-if="kind === 'any'" class="textarea mono" rows="5" :value="jsonText" :disabled="disabled" spellcheck="false" @change="onJson"></textarea>

  <textarea
    v-else-if="kind === 'string' && textarea"
    class="textarea"
    rows="4"
    :value="textValue"
    :disabled="disabled"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>

  <ModelReferenceSelect
    v-else-if="kind === 'string' && meta.role === 'model'"
    :model-value="textValue"
    :disabled="disabled"
    :required="required"
    @update:model-value="emit('update:modelValue', $event)"
  />

  <input
    v-else-if="kind === 'string'"
    class="input"
    :class="{ mono: secret }"
    :type="secret ? 'password' : 'text'"
    :value="textValue"
    :disabled="disabled"
    :placeholder="secret && meta.configured === true ? '已配置，留空保持原值' : undefined"
    autocomplete="off"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />

  <input
    v-else-if="kind === 'number'"
    class="input"
    type="number"
    :value="numberValue"
    :min="typeof meta.min === 'number' ? meta.min : undefined"
    :max="typeof meta.max === 'number' ? meta.max : undefined"
    :disabled="disabled"
    @input="onNumber"
  />

  <ToggleSwitch
    v-else-if="kind === 'boolean'"
    :checked="modelValue === true"
    :label="modelValue === true ? '开启' : '关闭'"
    :disabled="disabled"
    @update:checked="emit('update:modelValue', $event)"
  />

  <div v-else-if="kind === 'array'" class="schema-list">
    <div v-for="(item, index) in items" :key="index" class="schema-row">
      <SchemaForm
        :schema="schema.inner ?? { type: 'any', meta: {} }"
        :model-value="item"
        :disabled="disabled"
        @update:model-value="setArrayItem(index, $event)"
      />
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="removeArrayItem(index)">移除</button>
    </div>
    <button type="button" class="btn btn-soft btn-sm" :disabled="disabled" @click="addArrayItem">添加</button>
    <p v-if="items.length === 0" class="field-hint">暂无条目。</p>
  </div>

  <div v-else-if="kind === 'dict'" class="schema-list">
    <div v-for="[key, value] in dictEntries" :key="key" class="schema-dict-row">
      <input
        class="input schema-dict-key"
        :value="key"
        :disabled="disabled"
        placeholder="键名"
        @change="renameDictItem(key, ($event.target as HTMLInputElement).value)"
      />
      <div class="schema-dict-value">
        <SchemaForm
          :schema="schema.inner ?? { type: 'any', meta: {} }"
          :model-value="value"
          :disabled="disabled"
          @update:model-value="setDictItem(key, $event)"
        />
      </div>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="removeDictItem(key)">移除</button>
    </div>
    <button type="button" class="btn btn-soft btn-sm" :disabled="disabled" @click="addDictEntry">添加</button>
    <p v-if="dictEntries.length === 0" class="field-hint">暂无条目。</p>
  </div>

  <p v-else-if="kind === 'const'" class="field-hint">{{ meta.description ?? schema.value }}</p>
  <p v-else class="field-hint">该字段类型暂不支持编辑。</p>
</template>
