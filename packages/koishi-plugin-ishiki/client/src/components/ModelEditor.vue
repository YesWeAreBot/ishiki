<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { findDeclaredModel, MODEL_TYPE_OPTIONS } from "../lib/models";
import { schemaDefaults } from "../lib/schema";
import type { GroupView, ModelDecl, ModelDeclView, ModelOption, ModelsSchemas, ProviderInput, ProviderView } from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import SchemaForm from "./SchemaForm.vue";

/** 服务端 SchemaNode 没有从 client/src/types.ts 重新导出，用同一份声明取别名。 */
type SchemaNode = ModelsSchemas["model"];

const NEW_PROVIDER = "__new";

const props = defineProps<{
  open: boolean;
  /** 编辑目标：带 reference 表示编辑已有模型，否则新建（providerId 可作为预选供应商）。 */
  modelValue?: { reference?: string; providerId?: string };
  providers: readonly ProviderView[];
  groups: readonly GroupView[];
  options: readonly ModelOption[];
  schema: SchemaNode;
  providerSchema: SchemaNode;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  save: [payload: { providerId: string; provider: ProviderInput; isNewProvider: boolean; model: ModelDecl; originalModelId?: string }];
  close: [];
}>();

const providerSelect = ref(NEW_PROVIDER);
const newProviderId = ref("");
const providerDraft = ref<Record<string, unknown>>({});
const modelDraft = ref<Record<string, unknown>>({});
const formError = ref("");
const confirmDiscard = ref(false);
const baseline = ref("");

const originalReference = computed(() => props.modelValue?.reference);
const editing = computed(() => originalReference.value !== undefined);
const target = computed(() => (originalReference.value === undefined ? undefined : findDeclaredModel(props.providers, originalReference.value)));
const originalModelId = computed(() => target.value?.model.id);
const isNewProvider = computed(() => providerSelect.value === NEW_PROVIDER);
const selectedProvider = computed(() => props.providers.find((entry) => entry.id === providerSelect.value));
const activeProviderId = computed(() => (isNewProvider.value ? newProviderId.value.trim() : providerSelect.value));
const providerModelCount = computed(() => selectedProvider.value?.models.length ?? 0);
const referencingGroups = computed(() => {
  const reference = originalReference.value;
  if (reference === undefined) return [];
  return props.groups.filter((group) => group.models.includes(reference)).map((group) => group.name);
});
const modelIdPreview = computed(() => text(modelDraft.value.id) ?? "model");
const referencePreview = computed(() => `${activeProviderId.value.length > 0 ? activeProviderId.value : "provider"}:${modelIdPreview.value}`);

/** provider 表单不渲染 models 字段：模型在独立的表单里编辑。 */
const providerForm = computed(() => {
  const base = withoutKeys(props.providerSchema, ["models"]);
  const secret = selectedProvider.value?.apiKey;
  if (isNewProvider.value || secret === undefined || !secret.configured) return base;
  return withSecretState(base, secret.reference);
});

const displayError = computed(() => formError.value || props.error || "");
const dirty = computed(() => props.open && baseline.value.length > 0 && snapshot() !== baseline.value);

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      confirmDiscard.value = false;
      baseline.value = "";
    }
  },
  { immediate: true },
);

watch(providerSelect, (choice) => {
  if (choice === NEW_PROVIDER) providerDraft.value = initialRecord(providerForm.value);
  else {
    const provider = props.providers.find((entry) => entry.id === choice);
    providerDraft.value = provider === undefined ? initialRecord(providerForm.value) : providerDraftOf(provider);
  }
});

function hydrate(): void {
  formError.value = "";
  confirmDiscard.value = false;
  baseline.value = "";
  const reference = originalReference.value;
  if (reference !== undefined) {
    const found = findDeclaredModel(props.providers, reference);
    if (found === undefined) {
      providerSelect.value = NEW_PROVIDER;
      newProviderId.value = "";
      providerDraft.value = {};
      modelDraft.value = {};
      formError.value = "该模型已不在当前配置里，请关闭编辑器后重试。";
      return;
    }
    providerSelect.value = found.provider.id;
    newProviderId.value = "";
    providerDraft.value = providerDraftOf(found.provider);
    modelDraft.value = modelDraftOf(found.model);
  } else {
    const preset = props.modelValue?.providerId;
    const provider = preset === undefined ? undefined : props.providers.find((entry) => entry.id === preset);
    providerSelect.value = provider?.id ?? NEW_PROVIDER;
    newProviderId.value = "";
    providerDraft.value = provider === undefined ? initialRecord(providerForm.value) : providerDraftOf(provider);
    modelDraft.value = initialRecord(props.schema);
  }
  void nextTick(() => {
    baseline.value = snapshot();
  });
}

function snapshot(): string {
  return JSON.stringify({
    providerSelect: providerSelect.value,
    newProviderId: newProviderId.value,
    provider: providerDraft.value,
    model: modelDraft.value,
  });
}

function providerDraftOf(provider: ProviderView): Record<string, unknown> {
  const draft = initialRecord(providerForm.value);
  draft.api = provider.api;
  draft.baseUrl = provider.baseUrl;
  draft.apiKey = "";
  draft.headers = { ...provider.headers };
  draft.settings = cloneJson(provider.settings);
  return draft;
}

function modelDraftOf(model: ModelDeclView): Record<string, unknown> {
  const values = asRecord(cloneJson(model));
  delete values.reference;
  delete values.provider;
  return { ...initialRecord(props.schema), ...values };
}

function submit(): void {
  if (props.busy === true) return;
  formError.value = "";
  const result = buildModel();
  if ("error" in result) {
    formError.value = result.error;
    return;
  }
  const providerId = activeProviderId.value;
  if (isNewProvider.value) {
    if (providerId.length === 0) {
      formError.value = "新建供应商需要填写供应商 ID。";
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) {
      formError.value = "供应商 ID 只能包含字母、数字、点、下划线与连字符，并以字母或数字开头。";
      return;
    }
    if (props.providers.some((entry) => entry.id === providerId)) {
      formError.value = `供应商 ${providerId} 已存在，请改用现有供应商。`;
      return;
    }
  }
  const provider = buildProvider(collectModels(result.model));
  if (provider === undefined) {
    formError.value = "请选择供应商的 API 端点类型。";
    return;
  }
  if (isNewProvider.value && (provider.apiKey ?? "").trim().length === 0) {
    formError.value = "新建供应商必须填写 API 密钥，已有供应商留空表示保留原密钥。";
    return;
  }
  if (!isNewProvider.value) {
    const secret = selectedProvider.value?.apiKey;
    if (secret !== undefined && !secret.configured && (provider.apiKey ?? "").trim().length === 0) {
      formError.value = `供应商 ${providerId} 还没有配置密钥，请在这里填写后再保存。`;
      return;
    }
  }
  emit("save", { providerId, provider, isNewProvider: isNewProvider.value, model: result.model, originalModelId: originalModelId.value });
}

function buildModel(): { model: ModelDecl } | { error: string } {
  const draft = modelDraft.value;
  const reference = originalReference.value;
  const id = (text(draft.id) ?? "").trim();
  const errors: string[] = [];
  if (id.length === 0) errors.push("模型 ID 必填。");
  if (id.includes(":")) errors.push("模型 ID 不能包含冒号。");
  if (reference !== undefined && originalModelId.value !== undefined && id !== originalModelId.value && referencingGroups.value.length > 0) {
    errors.push(`该模型被 ${referencingGroups.value.join("、")} 引用，模型 ID 不能修改。`);
  }
  const type = text(draft.type) ?? "language";
  if (!MODEL_TYPE_OPTIONS.some((option) => option.value === type)) errors.push(`模型类型 ${type} 不在支持范围内。`);
  const duplicate =
    activeProviderId.value.length > 0 &&
    props.options.some((option) => option.kind === "model" && option.reference === `${activeProviderId.value}:${id}` && option.reference !== reference);
  if (duplicate) errors.push(`引用 ${activeProviderId.value}:${id} 已存在。`);

  const model: ModelDecl = { id, type };
  const name = text(draft.name);
  if (name !== undefined) model.name = name;
  if (typeof draft.toolCall === "boolean") model.toolCall = draft.toolCall;
  if (typeof draft.reasoning === "boolean") model.reasoning = draft.reasoning;
  const modalities = stringList(draft.input);
  if (modalities !== undefined && modalities.length > 0) model.input = modalities;
  const thinking = asRecord(draft.thinking);
  const mode = text(thinking.mode);
  const efforts = stringList(thinking.efforts) ?? [];
  if (mode === undefined && efforts.length > 0) errors.push("填写思考档位之前需要先填写思考取向。");
  if (mode !== undefined) {
    if (efforts.length === 0) errors.push("思考取向至少需要一个档位。");
    model.thinking = { mode, efforts };
  }
  for (const [key, label] of [
    ["contextWindow", "上下文窗口"],
    ["maxTokens", "输出上限"],
    ["dimensions", "向量维度"],
  ] as const) {
    const value = draft[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`${label}需要大于 0 的整数。`);
      continue;
    }
    model[key] = value;
  }
  if (errors.length > 0) return { error: errors.join(" ") };
  return { model };
}

function collectModels(model: ModelDecl): ModelDecl[] {
  const provider = selectedProvider.value;
  const kept = provider === undefined ? [] : provider.models.filter((entry) => entry.id !== originalModelId.value).map(toDecl);
  return [...kept, model];
}

function buildProvider(models: ModelDecl[]): ProviderInput | undefined {
  const draft = providerDraft.value;
  const api = text(draft.api);
  if (api === undefined) return undefined;
  return {
    api,
    baseUrl: text(draft.baseUrl),
    apiKey: typeof draft.apiKey === "string" ? draft.apiKey : "",
    headers: recordOfStrings(draft.headers),
    settings: asRecord(draft.settings),
    models,
  };
}

function toDecl(view: ModelDeclView): ModelDecl {
  const decl: ModelDecl = { id: view.id, type: view.type };
  if (view.name !== undefined) decl.name = view.name;
  if (view.toolCall !== undefined) decl.toolCall = view.toolCall;
  if (view.reasoning !== undefined) decl.reasoning = view.reasoning;
  if (view.input !== undefined) decl.input = [...view.input];
  if (view.thinking !== undefined) decl.thinking = { mode: view.thinking.mode, efforts: [...view.thinking.efforts] };
  if (view.contextWindow !== undefined) decl.contextWindow = view.contextWindow;
  if (view.maxTokens !== undefined) decl.maxTokens = view.maxTokens;
  if (view.dimensions !== undefined) decl.dimensions = view.dimensions;
  return decl;
}

function requestClose(): void {
  if (props.busy === true) return;
  if (dirty.value) {
    confirmDiscard.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  confirmDiscard.value = false;
  baseline.value = "";
  emit("close");
}

function initialRecord(schema: SchemaNode): Record<string, unknown> {
  return asRecord(initialValue(schema));
}

function initialValue(node: SchemaNode): unknown {
  return schemaDefaults(node);
}

/** 复制 schema 并去掉指定字段：被去掉的字段由组件自己渲染。 */
function withoutKeys(node: SchemaNode, keys: readonly string[]): SchemaNode {
  const clone = cloneSchema(node);
  if (clone.dict !== undefined) for (const key of keys) delete clone.dict[key];
  return clone;
}

function withSecretState(node: SchemaNode, reference: string | undefined): SchemaNode {
  const field = node.dict?.apiKey;
  if (field === undefined) return node;
  field.meta = {
    ...field.meta,
    configured: true,
    description:
      reference === undefined
        ? "该供应商已保存密钥；留空表示保留原密钥，填写新值会覆盖。支持 ${环境变量} 引用。"
        : `密钥来自 ${reference}；留空表示保留原密钥，填写新值会覆盖。支持 \${环境变量} 引用。`,
  };
  return node;
}

function cloneSchema(node: SchemaNode): SchemaNode {
  return {
    type: node.type,
    meta: { ...node.meta },
    dict: node.dict === undefined ? undefined : Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, cloneSchema(child)])),
    list: node.list?.map((branch) => cloneSchema(branch)),
    inner: node.inner === undefined ? undefined : cloneSchema(node.inner),
    value: node.value,
  };
}

/** 配置内容都是 JSON 数据；用 JSON 往返复制可以避开响应式代理无法结构化克隆的问题。 */
function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> {
  const source = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) if (typeof entry === "string") result[key] = entry;
  return result;
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="editing ? '编辑模型' : '新增模型'"
    desc="模型声明写入供应商配置；保存后网关目录重建，Profile 的 model 选择器自动同步。"
    width="min(760px, 100%)"
    @close="requestClose"
  >
    <div v-if="displayError.length > 0" class="error-panel" role="alert">
      <Icon name="alert" :size="16" />
      <div>
        <strong>无法保存</strong>
        <div>{{ displayError }}</div>
      </div>
    </div>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">供应商与端点</div>
          <div class="form-section-desc">这些字段属于 provider，修改会作用于该供应商下的全部模型。</div>
        </div>
      </div>

      <div class="form-grid">
        <FormField label="归属供应商" required :hint="editing ? '编辑已有模型时不能切换供应商。' : '可以复用现有供应商，或新建一个。'">
          <select v-model="providerSelect" class="select" :disabled="editing">
            <option :value="NEW_PROVIDER">新建供应商</option>
            <option v-for="entry in providers" :key="entry.id" :value="entry.id">{{ entry.id }} · {{ entry.api }}</option>
          </select>
        </FormField>

        <FormField v-if="isNewProvider" label="供应商 ID" required hint="例如 deepseek、relay、local；保存后不可改名。">
          <input v-model="newProviderId" class="input input-mono" placeholder="relay" autocomplete="off" />
        </FormField>
        <FormField v-else label="模型引用" hint="Profile 里填写 provider:model。">
          <input :value="referencePreview" class="input input-mono" readonly />
        </FormField>
      </div>

      <div v-if="!isNewProvider && providerModelCount > 1" class="notice" style="margin-top: 12px">
        <Icon name="info" :size="15" />
        <span>供应商 {{ providerSelect }} 下还有 {{ providerModelCount - 1 }} 个模型；这里保存的端点与密钥会同时作用于它们。</span>
      </div>

      <div style="margin-top: 12px">
        <SchemaForm :schema="providerForm" :model-value="providerDraft" :disabled="busy === true" @update:model-value="providerDraft = asRecord($event)" />
      </div>

      <div v-if="editing && referencingGroups.length > 0" class="notice notice-warning" style="margin-top: 12px">
        <Icon name="warningCircle" :size="15" />
        <span>该模型被 {{ referencingGroups.join("、") }} 引用，模型 ID 已锁定；其余字段可以调整。</span>
      </div>
    </section>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">模型声明</div>
          <div class="form-section-desc">引用地址为 {{ referencePreview }}。</div>
        </div>
      </div>
      <SchemaForm :schema="schema" :model-value="modelDraft" :disabled="busy === true" @update:model-value="modelDraft = asRecord($event)" />
    </section>

    <template #footer>
      <span class="dirty-note" style="margin-right: auto">
        <template v-if="dirty"><span class="badge badge-warning">未保存</span> {{ referencePreview }}</template>
        <template v-else>{{ editing ? `编辑 ${originalReference}` : "新模型" }}</template>
      </span>
      <button type="button" class="btn" :disabled="busy === true" @click="requestClose">取消</button>
      <button type="button" class="btn btn-primary" :disabled="busy === true" @click="submit">
        <span v-if="busy === true" class="spinner" aria-hidden="true"></span>
        {{ busy === true ? "保存中…" : "保存模型" }}
      </button>
    </template>
  </BaseModal>

  <BaseModal :open="confirmDiscard" title="放弃未保存的修改？" desc="表单内容会丢失，已保存的模型配置不受影响。" @close="confirmDiscard = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmDiscard = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discard">放弃修改</button>
    </template>
  </BaseModal>
</template>
