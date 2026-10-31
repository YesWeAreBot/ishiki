<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import {
  buildModelDecl,
  draftsFromDecl,
  hasErrors,
  remoteToDraft,
  typeOfDraft,
  validateModelDraft,
  type FieldErrors,
  type ModelType,
} from "../lib/modelFields";
import { findDeclaredModel, toModelDecl } from "../lib/models";
import { formatRawIssues, inspectModelEntry, parseRaw, serializeRaw } from "../lib/rawConfig";
import { loadRemoteModels } from "../lib/remote";
import { schemaDefaults } from "../lib/schema";
import type {
  GroupView,
  ModelDecl,
  ModelDeclView,
  ModelOption,
  ModelsSchemas,
  ProviderInput,
  ProviderView,
  RemoteModelInfo,
  RemoteModelsQuery,
} from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import ModelFieldsForm from "./ModelFieldsForm.vue";
import RawEditor from "./RawEditor.vue";
import RemoteModelPicker from "./RemoteModelPicker.vue";
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
/** 每种模型类型各自暂存：切换类型不残留字段，切回时恢复用户之前填写的值。 */
const typeArchives = ref<Partial<Record<ModelType, Record<string, unknown>>>>({});
const formError = ref("");
const fieldErrors = ref<FieldErrors>({});
const confirmDiscard = ref(false);
const baseline = ref("");
const mode = ref<"form" | "raw">("form");
const rawText = ref("");

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
const modelIdPreview = computed(() =>
  typeof modelDraft.value.id === "string" && modelDraft.value.id.trim().length > 0 ? modelDraft.value.id.trim() : "model",
);
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

const validationContext = computed(() => ({
  modelTaken: (id: string) =>
    props.options.some((option) => option.kind === "model" && option.reference === `${activeProviderId.value}:${id}`) &&
    (target.value === undefined || id !== target.value.model.id),
  lockedId: referencingGroups.value.length > 0,
  originalId: originalModelId.value,
}));

const remoteQuery = computed<RemoteModelsQuery | undefined>(() => {
  if (!isNewProvider.value && selectedProvider.value !== undefined) return { providerId: providerSelect.value };
  const api = text(providerDraft.value.api);
  if (api === undefined) return undefined;
  const apiKey = typeof providerDraft.value.apiKey === "string" ? providerDraft.value.apiKey.trim() : "";
  if (apiKey.length === 0) return undefined;
  return { draft: { api, baseUrl: text(providerDraft.value.baseUrl), apiKey, headers: recordOfStrings(providerDraft.value.headers) } };
});

const declaredModels = computed<RemoteModelInfo[]>(() => (selectedProvider.value?.models ?? []).map((model) => ({ id: model.id, name: model.name })));

/** RAW 模式下随输入实时校验；有错误时禁止切回表单或保存，并保留原文。 */
const rawReport = computed<{
  issues: string[];
  line: number | undefined;
  entry: { provider: Record<string, unknown>; model: Record<string, unknown> } | undefined;
}>(() => {
  if (mode.value !== "raw") return { issues: [], line: undefined, entry: undefined };
  const parsed = parseRaw(rawText.value);
  if (!parsed.ok) return { issues: formatRawIssues(parsed.issues), line: parsed.issues[0]?.line, entry: undefined };
  const result = inspectModelEntry(parsed.value, validationContext.value);
  return { issues: formatRawIssues(result.issues), line: undefined, entry: result.entry };
});

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      confirmDiscard.value = false;
      baseline.value = "";
      mode.value = "form";
      rawText.value = "";
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

/** 提供商选择或草稿凭据变化时自动加载对应的在线名单。 */
watch(remoteQuery, (query, previous) => {
  if (query === undefined || props.open !== true) return;
  if (previous !== undefined && previous.providerId === query.providerId && previous.draft?.apiKey === query.draft?.apiKey) return;
  void loadRemoteModels(query);
});

function hydrate(): void {
  formError.value = "";
  fieldErrors.value = {};
  confirmDiscard.value = false;
  baseline.value = "";
  typeArchives.value = {};
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
    const type = typeOfDraft({ type: found.model.type });
    modelDraft.value = draftsFromDecl(found.model as unknown as ModelDecl)[type] ?? { id: found.model.id, type };
  } else {
    const preset = props.modelValue?.providerId;
    const provider = preset === undefined ? undefined : props.providers.find((entry) => entry.id === preset);
    providerSelect.value = provider?.id ?? NEW_PROVIDER;
    newProviderId.value = "";
    providerDraft.value = provider === undefined ? initialRecord(providerForm.value) : providerDraftOf(provider);
    modelDraft.value = { type: "language" };
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
    model: mode.value === "raw" ? rawText.value : buildModelDecl(modelDraft.value),
    mode: mode.value,
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

function patchModel(key: string, value: unknown): void {
  const next = { ...modelDraft.value, [key]: value };
  if (key === "type") {
    const previous = typeOfDraft(modelDraft.value);
    const upcoming = typeOfDraft(next);
    if (previous !== upcoming) {
      const archives = { ...typeArchives.value };
      archives[previous] = { ...modelDraft.value };
      typeArchives.value = archives;
      // 基础字段跟随切换，其余字段从该类型的暂存恢复。
      modelDraft.value = { ...archives[upcoming], id: next.id, name: next.name, type: upcoming };
      return;
    }
  }
  modelDraft.value = next;
}

function pickRemoteModel(model: RemoteModelInfo): void {
  const previous = typeOfDraft(modelDraft.value);
  const archives = { ...typeArchives.value };
  archives[previous] = { ...modelDraft.value };
  typeArchives.value = archives;
  modelDraft.value = remoteToDraft(model);
  fieldErrors.value = {};
}

/* RAW 模式：与表单共用同一份配置状态，切换与保存前统一校验。 */

function providerForRaw(): Record<string, unknown> {
  const draft = providerDraft.value;
  const provider: Record<string, unknown> = { api: typeof draft.api === "string" ? draft.api : "" };
  if (typeof draft.baseUrl === "string" && draft.baseUrl.trim().length > 0) provider.baseUrl = draft.baseUrl.trim();
  if (typeof draft.apiKey === "string" && draft.apiKey.length > 0) provider.apiKey = draft.apiKey;
  const headers = recordOfStrings(draft.headers);
  if (Object.keys(headers).length > 0) provider.headers = headers;
  const settings = asRecord(draft.settings);
  if (Object.keys(settings).length > 0) provider.settings = settings;
  return provider;
}

function enterRaw(): void {
  rawText.value = serializeRaw({ provider: providerForRaw(), model: buildModelDecl(modelDraft.value) });
  mode.value = "raw";
}

/** 把通过校验的 RAW 内容回填到表单状态；调用方先检查 rawReport.issues 为空。 */
function applyRaw(): boolean {
  const entry = rawReport.value.entry;
  if (entry === undefined) return false;
  const { provider, model } = entry;
  const nextProvider = initialRecord(providerForm.value);
  nextProvider.api = typeof provider.api === "string" ? provider.api : nextProvider.api;
  nextProvider.baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : undefined;
  nextProvider.apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
  nextProvider.headers = recordOfStrings(provider.headers);
  nextProvider.settings = asRecord(provider.settings);
  providerDraft.value = nextProvider;
  modelDraft.value = { ...model };
  return true;
}

function switchMode(next: "form" | "raw"): void {
  if (next === mode.value) return;
  if (next === "raw") {
    enterRaw();
    return;
  }
  if (rawReport.value.issues.length > 0) return;
  if (!applyRaw()) return;
  mode.value = "form";
}

function submit(): void {
  if (props.busy === true) return;
  formError.value = "";
  if (mode.value === "raw") {
    if (rawReport.value.issues.length > 0 || !applyRaw()) return;
  }
  const errors = validateModelDraft(modelDraft.value, validationContext.value);
  fieldErrors.value = errors;
  if (hasErrors(errors)) return;

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
  const model = buildModelDecl(modelDraft.value);
  const provider = buildProvider(collectModels(model));
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
  emit("save", { providerId, provider, isNewProvider: isNewProvider.value, model, originalModelId: originalModelId.value });
}

function collectModels(model: ModelDecl): ModelDecl[] {
  const provider = selectedProvider.value;
  const kept = provider === undefined ? [] : provider.models.filter((entry) => entry.id !== originalModelId.value).map(toModelDecl);
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
  return asRecord(schemaDefaults(schema));
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
    desc="模型声明写入供应商配置；保存后重建模型网关目录，人格配置的模型选择器自动同步。"
    width="min(860px, 100%)"
    @close="requestClose"
  >
    <div v-if="displayError.length > 0" class="error-panel" role="alert">
      <Icon name="alert" :size="16" />
      <div>
        <strong>无法保存</strong>
        <div>{{ displayError }}</div>
      </div>
    </div>

    <div class="row editor-mode-switch" role="group" aria-label="编辑模式">
      <div class="segmented">
        <button type="button" :aria-pressed="mode === 'form'" @click="switchMode('form')">表单</button>
        <button type="button" :aria-pressed="mode === 'raw'" @click="switchMode('raw')">原始配置</button>
      </div>
      <span v-if="mode === 'raw' && rawReport.issues.length > 0" class="field-error">原始配置有问题，修正后才能切回表单或保存。</span>
    </div>

    <template v-if="mode === 'form'">
      <section class="form-section">
        <div class="form-section-head">
          <div>
            <div class="form-section-title">基础信息</div>
            <div class="form-section-desc">模型归属与引用地址；这些字段属于供应商，修改会作用于该供应商下的全部模型。</div>
          </div>
        </div>

        <div class="form-grid">
          <FormField label="归属供应商" required :hint="editing ? '编辑已有模型时不能切换供应商。' : '可以复用现有供应商，或新建一个。'">
            <select v-model="providerSelect" class="select" :disabled="editing">
              <option :value="NEW_PROVIDER">新建供应商</option>
              <option v-for="entry in providers" :key="entry.id" :value="entry.id">{{ entry.id }} · {{ entry.api }}</option>
            </select>
          </FormField>

          <FormField v-if="isNewProvider" label="供应商标识" required hint="例如 deepseek、relay、local；保存后不可改名。">
            <input v-model="newProviderId" class="input input-mono" placeholder="relay" autocomplete="off" />
          </FormField>
          <FormField v-else label="模型引用" hint="人格配置里填写 provider:model。">
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
          <span>该模型被 {{ referencingGroups.join("、") }} 引用，模型标识已锁定；其余字段可以调整。</span>
        </div>
      </section>

      <section class="form-section">
        <div class="form-section-head">
          <div>
            <div class="form-section-title">从在线名单导入</div>
            <div class="form-section-desc">按当前供应商的端点与密钥拉取提供商模型名单，选择后自动填入声明字段。</div>
          </div>
        </div>
        <RemoteModelPicker :query="remoteQuery" :declared="declaredModels" :disabled="busy === true" @pick="pickRemoteModel" />
      </section>

      <section class="form-section">
        <div class="form-section-head">
          <div>
            <div class="form-section-title">模型声明</div>
            <div class="form-section-desc">引用地址为 {{ referencePreview }}；字段随模型类型变化，不适用的字段不会提交。</div>
          </div>
        </div>
        <ModelFieldsForm :draft="modelDraft" :errors="fieldErrors" :disabled="busy === true" @patch="patchModel" />
      </section>
    </template>

    <template v-else>
      <p class="field-hint" style="margin-bottom: 8px">
        直接编辑 YAML。供应商的 apiKey 留空表示沿用已保存密钥；模型声明只保留当前类型适用的字段，切换类型请回到表单模式。
      </p>
      <RawEditor :model-value="rawText" :error-line="rawReport.line" :aria-label="`原始模型配置 ${referencePreview}`" @update:model-value="rawText = $event" />
      <div v-if="rawReport.issues.length > 0" class="error-panel" role="alert" style="margin-top: 10px">
        <Icon name="alert" :size="15" />
        <div class="flex-1">
          <strong>原始配置校验未通过</strong>
          <ul class="raw-issue-list">
            <li v-for="issue in rawReport.issues" :key="issue">{{ issue }}</li>
          </ul>
        </div>
      </div>
    </template>

    <template #footer>
      <span class="dirty-note" style="margin-right: auto">
        <template v-if="dirty"><span class="badge badge-warning">未保存</span> {{ referencePreview }}</template>
        <template v-else>{{ editing ? `编辑 ${originalReference}` : "新模型" }}</template>
      </span>
      <button type="button" class="btn" :disabled="busy === true" @click="requestClose">取消</button>
      <button type="button" class="btn btn-primary" :disabled="busy === true || (mode === 'raw' && rawReport.issues.length > 0)" @click="submit">
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

<style scoped>
.editor-mode-switch {
  margin-bottom: 14px;
}

.raw-issue-list {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 180px;
  overflow: auto;
}

.raw-issue-list li {
  overflow-wrap: anywhere;
}
</style>
