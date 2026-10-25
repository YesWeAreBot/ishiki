<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { schemaDefaults } from "../lib/schema";
import type { ModelsSchemas, ProviderInput, ProviderView } from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import SchemaForm from "./SchemaForm.vue";

type SchemaNode = ModelsSchemas["provider"];

const props = defineProps<{
  open: boolean;
  /** 传入表示编辑已有供应商，缺省表示新建。 */
  provider?: ProviderView;
  schema: SchemaNode;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [payload: { providerId: string; provider: Omit<ProviderInput, "models">; isNew: boolean }];
  close: [];
}>();

const providerId = ref("");
const draft = ref<Record<string, unknown>>({});
const formError = ref("");
const baseline = ref("");

const editing = computed(() => props.provider !== undefined);
const fields = computed<SchemaNode>(() => {
  const schema = props.schema;
  if (schema.dict === undefined) return schema;
  const { models: _models, ...dict } = schema.dict;
  return { ...schema, dict };
});
const title = computed(() => (editing.value ? `编辑供应商 ${props.provider?.id ?? ""}` : "新增供应商"));
const displayError = computed(() => formError.value || props.error || "");
const dirty = computed(() => props.open && baseline.value.length > 0 && snapshot() !== baseline.value);

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      baseline.value = "";
      formError.value = "";
    }
  },
  { immediate: true },
);

function hydrate(): void {
  formError.value = "";
  baseline.value = "";
  providerId.value = props.provider?.id ?? "";
  const defaults = schemaDefaults(fields.value);
  const values: Record<string, unknown> =
    defaults !== null && typeof defaults === "object" && !Array.isArray(defaults) ? { ...(defaults as Record<string, unknown>) } : {};
  if (props.provider !== undefined) {
    values.api = props.provider.api;
    values.baseUrl = props.provider.baseUrl;
    values.apiKey = "";
    values.headers = { ...props.provider.headers };
    values.settings = cloneJson(props.provider.settings);
  }
  draft.value = values;
  void nextTick(() => {
    baseline.value = snapshot();
  });
}

function snapshot(): string {
  return JSON.stringify({ providerId: providerId.value, draft: draft.value });
}

function submit(): void {
  if (props.busy === true) return;
  const id = providerId.value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    formError.value = "供应商 ID 只能包含字母、数字、点、下划线与连字符，并以字母或数字开头。";
    return;
  }
  const api = typeof draft.value.api === "string" ? draft.value.api : "";
  if (api.length === 0) {
    formError.value = "请选择供应商的接口类型。";
    return;
  }
  const apiKey = typeof draft.value.apiKey === "string" ? draft.value.apiKey.trim() : "";
  if (!editing.value && apiKey.length === 0 && props.provider === undefined) {
    formError.value = "新建供应商必须填写 API 密钥。";
    return;
  }
  formError.value = "";
  emit("save", {
    providerId: id,
    provider: {
      api,
      baseUrl: typeof draft.value.baseUrl === "string" && draft.value.baseUrl.trim().length > 0 ? draft.value.baseUrl.trim() : undefined,
      apiKey,
      headers: stringRecord(draft.value.headers),
      settings: record(draft.value.settings),
    },
    isNew: !editing.value,
  });
}

function cloneJson(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>) : {};
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="title"
    :desc="editing ? '保存后立即重建 gateway 目录；模型列表保持不变。' : '供应商是模型的来源；先创建供应商，再为它添加模型。'"
    width="640px"
    @close="emit('close')"
  >
    <form class="stack" @submit.prevent="submit">
      <FormField label="供应商 ID" hint="用于组成 model 引用，例如 provider:model。创建后不能再修改。" :required="!editing">
        <input v-model="providerId" class="input mono" :disabled="editing" autocomplete="off" :placeholder="editing ? '' : '例如 openai'" />
      </FormField>
      <SchemaForm v-model="draft" :schema="fields" :disabled="busy" />
      <div v-if="displayError.length > 0" class="form-error">{{ displayError }}</div>
      <div v-if="dirty" class="field-hint">有未保存的修改。</div>
    </form>

    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">取消</button>
      <button type="button" class="btn btn-primary" :disabled="busy" @click="submit">{{ busy ? "保存中…" : "保存供应商" }}</button>
    </template>
  </BaseModal>
</template>
