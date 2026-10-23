<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import { ApiError, call } from "../api";
import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import GroupEditor from "../components/GroupEditor.vue";
import Icon from "../components/Icon.vue";
import ModelEditor from "../components/ModelEditor.vue";
import PageHeader from "../components/PageHeader.vue";
import PageShell from "../components/PageShell.vue";
import ProviderEditor from "../components/ProviderEditor.vue";
import { formatCompact, formatNumber, relativeTime } from "../lib/format";
import {
  apiLabel,
  groupStrategyDescription,
  groupStrategyLabel,
  modelCapabilitySummary,
  MODEL_TYPE_OPTIONS,
  modelRows,
  modelTypeLabel,
  parseReference,
  THINK_LEVEL_LABELS,
} from "../lib/models";
import type { ThinkLevel } from "../lib/models";
import { referencesForGroup, referencesForModel, store, toast } from "../store";
import type { GroupView, ModelDecl, ModelDeclView, ModelsConfigInput, ModelsDocument, ProviderInput, ProviderView } from "../types";

type ModelRow = ReturnType<typeof modelRows>[number];

interface ModelSavePayload {
  providerId: string;
  provider: ProviderInput;
  isNewProvider: boolean;
  model: ModelDecl;
  originalModelId?: string;
}

interface GroupSavePayload {
  name: string;
  group: GroupView;
  isNewGroup: boolean;
}

interface ProviderSavePayload {
  providerId: string;
  provider: Omit<ProviderInput, "models">;
  isNew: boolean;
}

interface DeleteTarget {
  kind: "model" | "group";
  target: string;
}

const router = useRouter();

const tab = ref<"models" | "groups">("models");
const query = ref("");
const typeFilter = ref("all");

const models = computed(() => store.models);
const providers = computed(() => store.providers);
const groups = computed(() => store.groups);
const options = computed(() => store.options);
const schemas = computed(() => store.modelSchemas);

const allRows = computed<ModelRow[]>(() => modelRows(providers.value));
const filtering = computed(() => query.value.trim().length > 0 || typeFilter.value !== "all");
const filteredRows = computed<ModelRow[]>(() => {
  const term = query.value.trim().toLowerCase();
  return allRows.value.filter(({ provider, model, reference }) => {
    if (typeFilter.value !== "all" && (model.type ?? "language") !== typeFilter.value) return false;
    if (term.length === 0) return true;
    return (
      reference.toLowerCase().includes(term) ||
      provider.id.toLowerCase().includes(term) ||
      (model.name ?? "").toLowerCase().includes(term) ||
      model.id.toLowerCase().includes(term)
    );
  });
});
const providerGroups = computed<Array<{ provider: ProviderView; rows: ModelRow[] }>>(() =>
  providers.value
    .map((provider) => ({ provider, rows: filteredRows.value.filter((row) => row.provider.id === provider.id) }))
    .filter((entry) => !filtering.value || entry.rows.length > 0),
);
const filteredGroups = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (term.length === 0) return groups.value;
  return groups.value.filter((group) => group.name.toLowerCase().includes(term) || group.models.some((member) => member.toLowerCase().includes(term)));
});

const modelEditorOpen = ref(false);
const modelTarget = ref<{ reference?: string; providerId?: string }>({});
const groupEditorOpen = ref(false);
const groupTarget = ref<{ name?: string }>({});
const providerEditorOpen = ref(false);
const providerTarget = ref<ProviderView>();
const providerEditorError = ref("");
const saving = ref(false);
const modelEditorError = ref("");
const groupEditorError = ref("");

const deleteTarget = ref<DeleteTarget>();
const deleteError = ref("");
const deleting = ref(false);

const deleteImpact = computed(() => {
  const target = deleteTarget.value;
  if (target === undefined) return undefined;
  const groupsReferencing = target.kind === "model" ? referencesForModel(target.target).groups : referencesForGroup(target.target).groups;
  return { label: target.target, groups: groupsReferencing, profiles: profilesUsing(target.target) };
});
const deleteBlocked = computed(() => {
  const impact = deleteImpact.value;
  return impact !== undefined && (impact.groups.length > 0 || impact.profiles.length > 0);
});
const deleteTitle = computed(() => {
  if (deleteBlocked.value) return "仍有引用，无法删除";
  return deleteTarget.value?.kind === "group" ? "删除模型组" : "删除模型";
});
const editingGroupLocked = computed(() => {
  const name = groupTarget.value.name;
  if (name === undefined) return false;
  if (referencesForGroup(name).groups.length > 0) return true;
  return store.profiles.some((profile) => {
    const parsed = parseReference(profile.model);
    return "group" in parsed && parsed.group === name;
  });
});

function openNewModel(providerId?: string): void {
  const preset = providerId ?? providers.value[0]?.id;
  modelTarget.value = preset === undefined ? {} : { providerId: preset };
  modelEditorError.value = "";
  modelEditorOpen.value = true;
}

function openEditModel(reference: string): void {
  modelTarget.value = { reference };
  modelEditorError.value = "";
  modelEditorOpen.value = true;
}

function closeModelEditor(): void {
  modelEditorOpen.value = false;
  modelEditorError.value = "";
}

function openNewProvider(): void {
  providerTarget.value = undefined;
  providerEditorError.value = "";
  providerEditorOpen.value = true;
}

function openEditProvider(provider: ProviderView): void {
  providerTarget.value = provider;
  providerEditorError.value = "";
  providerEditorOpen.value = true;
}

function closeProviderEditor(): void {
  providerEditorOpen.value = false;
  providerEditorError.value = "";
}

async function handleProviderSave(payload: ProviderSavePayload): Promise<void> {
  const config = currentConfig();
  if (config === undefined) {
    providerEditorError.value = "模型配置尚未加载完成，请稍后重试。";
    return;
  }
  const current = config.providers[payload.providerId];
  if (payload.isNew && current !== undefined) {
    providerEditorError.value = `供应商 ${payload.providerId} 已存在，可能由其他操作者刚创建；请刷新后重试。`;
    return;
  }
  if (!payload.isNew && current === undefined) {
    providerEditorError.value = `供应商 ${payload.providerId} 已不存在，请关闭编辑器后重试。`;
    return;
  }
  config.providers[payload.providerId] = { ...payload.provider, models: current?.models ?? [] };
  providerEditorError.value = "";
  const result = await persist(config, `供应商 ${payload.providerId} 已保存。`);
  if (!result.ok) {
    providerEditorError.value = result.message;
    return;
  }
  providerEditorOpen.value = false;
}

function openNewGroup(): void {
  groupTarget.value = {};
  groupEditorError.value = "";
  groupEditorOpen.value = true;
}

function openEditGroup(name: string): void {
  groupTarget.value = { name };
  groupEditorError.value = "";
  groupEditorOpen.value = true;
}

function closeGroupEditor(): void {
  groupEditorOpen.value = false;
  groupEditorError.value = "";
}

function openProfiles(): void {
  void router.push("/ishiki/profiles");
}

async function handleModelSave(payload: ModelSavePayload): Promise<void> {
  const config = currentConfig();
  if (config === undefined) {
    modelEditorError.value = "模型配置尚未加载完成，请稍后重试。";
    return;
  }
  if (!payload.isNewProvider && !Object.hasOwn(config.providers, payload.providerId)) {
    modelEditorError.value = `供应商 ${payload.providerId} 已不存在，请关闭编辑器后重试。`;
    return;
  }
  if (payload.isNewProvider && Object.hasOwn(config.providers, payload.providerId)) {
    modelEditorError.value = `供应商 ${payload.providerId} 已存在，可能由其他操作者刚创建；请改用现有供应商后重试。`;
    return;
  }
  if (!payload.isNewProvider) {
    // 只替换这一个模型声明，保留其他操作者可能刚写入的其余模型。
    const current = config.providers[payload.providerId];
    const existingModels = (current.models ?? []).filter((entry) => entry.id !== payload.originalModelId && entry.id !== payload.model.id);
    config.providers[payload.providerId] = { ...payload.provider, models: [...existingModels, payload.model] };
  } else {
    config.providers[payload.providerId] = payload.provider;
  }
  modelEditorError.value = "";
  const result = await persist(config, `${payload.providerId}:${payload.model.id} 已写入配置。`);
  if (!result.ok) {
    modelEditorError.value = result.message;
    return;
  }
  modelEditorOpen.value = false;
}

async function handleGroupSave(payload: GroupSavePayload): Promise<void> {
  const config = currentConfig();
  if (config === undefined) {
    groupEditorError.value = "模型配置尚未加载完成，请稍后重试。";
    return;
  }
  const previous = groupTarget.value.name;
  if (previous !== undefined && previous !== payload.name) delete config.groups[previous];
  config.groups[payload.name] = payload.group;
  groupEditorError.value = "";
  const result = await persist(config, `模型组 ${payload.name} 已保存。`);
  if (!result.ok) {
    groupEditorError.value = result.message;
    return;
  }
  groupEditorOpen.value = false;
}

function askDeleteModel(reference: string): void {
  deleteTarget.value = { kind: "model", target: reference };
  deleteError.value = "";
}

function askDeleteGroup(name: string): void {
  deleteTarget.value = { kind: "group", target: name };
  deleteError.value = "";
}

function closeDelete(): void {
  deleteTarget.value = undefined;
  deleteError.value = "";
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (target === undefined || deleteBlocked.value || deleting.value) return;
  const config = currentConfig();
  if (config === undefined) {
    deleteError.value = "模型配置尚未加载完成，请稍后重试。";
    return;
  }
  if (target.kind === "model") {
    const parsed = parseReference(target.target);
    if ("group" in parsed) {
      deleteError.value = "该引用没有供应商前缀，无法定位模型声明。";
      return;
    }
    if (!Object.hasOwn(config.providers, parsed.provider)) {
      deleteError.value = `供应商 ${parsed.provider} 已不存在。`;
      return;
    }
    const provider = config.providers[parsed.provider];
    provider.models = (provider.models ?? []).filter((model) => model.id !== parsed.modelId);
  } else {
    if (!Object.hasOwn(config.groups, target.target)) {
      deleteError.value = `模型组 ${target.target} 已不存在。`;
      return;
    }
    delete config.groups[target.target];
  }
  deleting.value = true;
  deleteError.value = "";
  const result = await persist(config, `${target.kind === "model" ? "模型" : "模型组"} ${target.target} 已删除。`);
  deleting.value = false;
  if (!result.ok) {
    deleteError.value = result.message;
    return;
  }
  deleteTarget.value = undefined;
}

function resolveReferences(): void {
  const target = deleteTarget.value;
  const impact = deleteImpact.value;
  deleteTarget.value = undefined;
  deleteError.value = "";
  if (target === undefined) return;
  if (impact !== undefined && impact.profiles.length > 0) {
    openProfiles();
    return;
  }
  tab.value = "groups";
  query.value = target.target;
}

async function persist(config: ModelsConfigInput, detail: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const document = models.value;
  if (document === undefined) return { ok: false, message: "模型配置尚未加载完成，请稍后重试。" };
  saving.value = true;
  try {
    await call<ModelsDocument>("ishiki/models/save", { config, revision: document.revision });
    toast("success", "模型配置已保存", detail);
    return { ok: true };
  } catch (error) {
    const message = describeFailure(error);
    toast("error", "模型配置保存失败", message);
    return { ok: false, message };
  } finally {
    saving.value = false;
  }
}

function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error);
  if (error.code === "conflict") return "配置已被其他操作者修改，请先确认最新内容再重试。";
  if (error.code === "offline") return "控制台连接已断开，请确认 Koishi 仍在运行后重试。";
  const field = detailField(error.details);
  return field === undefined ? error.message : `${error.message}（字段：${field}）`;
}

function detailField(details: unknown): string | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const field = (details as Record<string, unknown>).field;
  return typeof field === "string" ? field : undefined;
}

/** 从当前推送快照重建完整配置；apiKey 留空表示沿用服务端已有密钥。 */
function currentConfig(): ModelsConfigInput | undefined {
  const document = models.value;
  if (document === undefined) return undefined;
  return {
    providers: Object.fromEntries(document.providers.map((provider) => [provider.id, providerToInput(provider)])),
    groups: Object.fromEntries(document.groups.map((group) => [group.name, toGroupInput(group)])),
  };
}

function providerToInput(provider: ProviderView): ProviderInput {
  return {
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: "",
    headers: { ...provider.headers },
    settings: asRecord(cloneJson(provider.settings)),
    models: provider.models.map(toDecl),
  };
}

function toDecl(model: ModelDeclView): ModelDecl {
  const decl: ModelDecl = { id: model.id, type: model.type };
  if (model.name !== undefined) decl.name = model.name;
  if (model.toolCall !== undefined) decl.toolCall = model.toolCall;
  if (model.reasoning !== undefined) decl.reasoning = model.reasoning;
  if (model.input !== undefined) decl.input = [...model.input];
  if (model.thinking !== undefined) decl.thinking = { mode: model.thinking.mode, efforts: [...model.thinking.efforts] };
  if (model.contextWindow !== undefined) decl.contextWindow = model.contextWindow;
  if (model.maxTokens !== undefined) decl.maxTokens = model.maxTokens;
  if (model.dimensions !== undefined) decl.dimensions = model.dimensions;
  return decl;
}

function toGroupInput(group: GroupView): GroupView {
  const input: GroupView = { name: group.name, models: [...group.models] };
  if (group.strategy !== undefined) input.strategy = group.strategy;
  if (group.circuitBreaker !== undefined) input.circuitBreaker = { ...group.circuitBreaker };
  return input;
}

function profilesUsing(reference: string): string[] {
  const target = parseReference(reference);
  const groupName = "group" in target ? target.group : undefined;
  const providerId = "group" in target ? undefined : target.provider;
  const modelId = "group" in target ? undefined : target.modelId;
  return store.profiles
    .filter((profile) => {
      const parsed = parseReference(profile.model);
      if (groupName !== undefined) return "group" in parsed && parsed.group === groupName;
      if ("group" in parsed) return false;
      return parsed.provider === providerId && parsed.modelId === modelId;
    })
    .map((profile) => profile.id);
}

function providerKeyLabel(provider: ProviderView): string {
  if (!provider.apiKey.configured) return "密钥未配置";
  return provider.apiKey.reference === undefined ? "密钥已配置" : `密钥来自 ${provider.apiKey.reference}`;
}

function groupMembers(group: GroupView): Array<{ reference: string; label: string; level?: ThinkLevel }> {
  return group.models.map((reference) => {
    const parsed = parseReference(reference);
    if ("group" in parsed) return { reference, label: reference };
    return { reference, label: `${parsed.provider}:${parsed.modelId}`, level: parsed.level };
  });
}

function levelLabel(level: ThinkLevel | undefined): string | undefined {
  return level === undefined ? undefined : THINK_LEVEL_LABELS[level];
}

function typeBadgeClass(type: string | undefined): string {
  if (type === "language" || type === undefined) return "badge-success";
  if (type === "embedding") return "badge-info";
  if (type === "decision") return "badge-warning";
  return "badge-neutral";
}

function clearFilters(): void {
  query.value = "";
  typeFilter.value = "all";
}

/** 配置内容都是 JSON 数据；用 JSON 往返复制可以避开响应式代理无法结构化克隆的问题。 */
function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
</script>

<template>
  <PageShell>
    <PageHeader
      title="模型配置"
      desc="编辑 models.yaml 的 providers 与 groups。所有表单由服务端 Schema 生成；保存会重建 gateway 目录，并校验 Profile 与模型组引用。"
      eyebrow="运行 / 模型目录"
    >
      <template #actions>
        <button v-if="tab === 'models'" type="button" class="btn" @click="openNewProvider"><Icon name="plus" :size="15" /> 新增供应商</button>
        <button v-if="tab === 'models'" type="button" class="btn btn-primary" @click="openNewModel()"><Icon name="plus" :size="15" /> 新增模型</button>
        <button v-else type="button" class="btn btn-primary" @click="openNewGroup"><Icon name="plus" :size="15" /> 新建模型组</button>
      </template>
    </PageHeader>

    <div class="session-meta-strip" style="margin-bottom: 18px">
      <span class="row" style="gap: 6px">
        <span v-if="models === undefined" class="spinner" aria-hidden="true"></span>
        <span v-else class="status-dot" aria-hidden="true" style="margin: 0"></span>
        <strong>{{ models === undefined ? "等待配置推送" : "配置已加载" }}</strong>
        <span class="muted">{{ models === undefined ? "数据服务尚未返回 models.yaml" : relativeTime(models.readAt) }}</span>
      </span>
      <span
        >供应商 <strong>{{ providers.length }}</strong></span
      >
      <span
        >模型 <strong>{{ allRows.length }}</strong></span
      >
      <span
        >模型组 <strong>{{ groups.length }}</strong></span
      >
      <span v-if="models !== undefined" class="sync-note">
        <Icon name="check" :size="13" /> 保存后由数据服务自动同步
        <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="openProfiles">去 Profile 验证</button>
      </span>
    </div>

    <div v-if="models === undefined" class="panel">
      <div class="panel-body">
        <EmptyState title="模型配置尚未加载" desc="控制台数据服务还没有推送 models.yaml 的解析结果；收到推送后本页会自动显示内容。" icon="clock" />
      </div>
    </div>

    <div v-else class="panel">
      <div class="panel-head" style="padding-bottom: 0; border-bottom: 0; align-items: flex-end">
        <div class="tabs" role="tablist" aria-label="模型配置视图" style="border-bottom: 0">
          <button type="button" role="tab" class="tab" :aria-selected="tab === 'models'" :tabindex="tab === 'models' ? 0 : -1" @click="tab = 'models'">
            模型 <span class="tab-count">{{ allRows.length }}</span>
          </button>
          <button type="button" role="tab" class="tab" :aria-selected="tab === 'groups'" :tabindex="tab === 'groups' ? 0 : -1" @click="tab = 'groups'">
            模型组 <span class="tab-count">{{ groups.length }}</span>
          </button>
        </div>
        <div class="panel-actions" style="padding-bottom: 8px">
          <div class="search-box" style="width: 240px">
            <Icon name="search" :size="15" />
            <input v-model="query" class="input" :aria-label="tab === 'models' ? '搜索模型' : '搜索模型组'" placeholder="搜索引用、名称或供应商" />
          </div>
          <select v-if="tab === 'models'" v-model="typeFilter" class="select" aria-label="按模型类型筛选" style="width: 126px">
            <option value="all">全部类型</option>
            <option v-for="option in MODEL_TYPE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
      </div>

      <div class="panel-body">
        <template v-if="tab === 'models'">
          <EmptyState
            v-if="filteredRows.length === 0 && filtering"
            title="没有匹配的模型"
            desc="清除搜索词或切换模型类型；也可以直接新增一个模型。"
            icon="search"
          >
            <button type="button" class="btn btn-soft" @click="clearFilters">清除筛选</button>
          </EmptyState>
          <EmptyState
            v-else-if="allRows.length === 0"
            title="还没有声明模型"
            desc="models.yaml 的 providers 下没有任何模型；先添加一个模型，再让 Profile 引用它。"
            icon="models"
          >
            <button type="button" class="btn btn-soft" @click="openNewModel()"><Icon name="plus" :size="14" /> 新增模型</button>
          </EmptyState>

          <div v-else class="stack">
            <section v-for="entry in providerGroups" :key="entry.provider.id" class="provider-block">
              <header class="provider-head">
                <div class="provider-mark">{{ entry.provider.id.slice(0, 2).toUpperCase() }}</div>
                <div class="flex-1">
                  <div class="provider-title">
                    {{ entry.provider.id }}
                    <span class="badge badge-outline mono">{{ apiLabel(entry.provider.api) }}</span>
                  </div>
                  <div class="provider-meta">
                    <span>{{ entry.provider.baseUrl ?? "默认端点" }}</span>
                    <span>{{ providerKeyLabel(entry.provider) }}</span>
                    <span>{{ entry.provider.models.length }} 个模型</span>
                    <span v-if="Object.keys(entry.provider.headers).length > 0">{{ Object.keys(entry.provider.headers).length }} 个 header</span>
                  </div>
                </div>
                <div class="provider-actions">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-sm"
                    :aria-label="`编辑供应商 ${entry.provider.id}`"
                    @click="openEditProvider(entry.provider)"
                  >
                    <Icon name="edit" :size="14" />
                  </button>
                  <button type="button" class="btn btn-sm" @click="openNewModel(entry.provider.id)"><Icon name="plus" :size="13" /> 添加模型</button>
                </div>
              </header>

              <div v-if="entry.rows.length === 0" class="field-hint">这个供应商还没有声明模型。</div>
              <div v-else class="card-grid">
                <article v-for="row in entry.rows" :key="row.reference" class="model-card">
                  <div class="model-card-top">
                    <div class="flex-1">
                      <div class="model-name">{{ row.model.name ?? row.model.id }}</div>
                      <div class="model-ref">{{ row.reference }}</div>
                    </div>
                    <div class="model-card-actions">
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`编辑 ${row.reference}`" @click="openEditModel(row.reference)">
                        <Icon name="edit" :size="14" />
                      </button>
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`删除 ${row.reference}`" @click="askDeleteModel(row.reference)">
                        <Icon name="trash" :size="14" />
                      </button>
                    </div>
                  </div>

                  <div class="model-tags">
                    <span class="badge" :class="typeBadgeClass(row.model.type)">{{ modelTypeLabel(row.model.type) }}</span>
                    <span v-for="capability in modelCapabilitySummary(row.model)" :key="capability" class="badge badge-outline">{{ capability }}</span>
                    <span v-if="row.model.input !== undefined" class="badge badge-outline">{{ row.model.input.join(" / ") }}</span>
                  </div>

                  <div class="model-foot">
                    <span v-if="row.model.contextWindow !== undefined"
                      >上下文 <strong>{{ formatCompact(row.model.contextWindow) }}</strong></span
                    >
                    <span v-if="row.model.maxTokens !== undefined"
                      >输出 <strong>{{ formatCompact(row.model.maxTokens) }}</strong></span
                    >
                    <span v-if="row.model.dimensions !== undefined"
                      >维度 <strong>{{ formatNumber(row.model.dimensions) }}</strong></span
                    >
                    <span v-if="row.model.contextWindow === undefined && row.model.maxTokens === undefined && row.model.dimensions === undefined" class="faint"
                      >没有额外声明</span
                    >
                  </div>
                </article>
              </div>
            </section>
          </div>
        </template>

        <template v-else>
          <EmptyState
            v-if="filteredGroups.length === 0 && query.trim().length > 0"
            title="没有匹配的模型组"
            desc="模型组把多个语言模型编成候选列表；Profile 的 model 可以直接引用组名。"
            icon="search"
          >
            <button type="button" class="btn btn-soft" @click="query = ''">清除搜索</button>
          </EmptyState>
          <EmptyState
            v-else-if="groups.length === 0"
            title="还没有模型组"
            desc="模型组按故障转移或轮询把请求分给多个语言模型；被 Profile 引用后即可直接使用组名。"
            icon="profile"
          >
            <button type="button" class="btn btn-soft" @click="openNewGroup"><Icon name="plus" :size="14" /> 新建模型组</button>
          </EmptyState>

          <div v-else class="card-grid" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))">
            <article v-for="group in filteredGroups" :key="group.name" class="group-card">
              <div class="row">
                <div class="flex-1">
                  <div class="row" style="gap: 7px">
                    <span class="model-name mono" style="font-size: 14px">{{ group.name }}</span>
                    <span class="badge badge-info">{{ groupStrategyLabel(group.strategy) }}</span>
                  </div>
                  <div class="field-hint" style="margin-top: 3px">{{ groupStrategyDescription(group.strategy) }}</div>
                </div>
                <div class="model-card-actions" style="opacity: 1">
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`编辑模型组 ${group.name}`" @click="openEditGroup(group.name)">
                    <Icon name="edit" :size="14" />
                  </button>
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`删除模型组 ${group.name}`" @click="askDeleteGroup(group.name)">
                    <Icon name="trash" :size="14" />
                  </button>
                </div>
              </div>

              <div class="group-members">
                <div v-for="(member, index) in groupMembers(group)" :key="member.reference" class="member-row">
                  <span class="member-index">{{ index + 1 }}</span>
                  <span class="flex-1">{{ member.label }}</span>
                  <span v-if="member.level !== undefined" class="badge badge-outline">{{ levelLabel(member.level) }}</span>
                </div>
                <div v-if="group.models.length === 0" class="field-hint">还没有候选成员。</div>
              </div>

              <div class="row muted small" style="padding-top: 2px">
                <Icon name="pulse" :size="13" />
                <span v-if="group.circuitBreaker?.failureThreshold !== undefined || group.circuitBreaker?.cooldownSeconds !== undefined">
                  熔断 {{ group.circuitBreaker?.failureThreshold ?? 3 }} 次 / {{ group.circuitBreaker?.cooldownSeconds ?? 60 }} 秒
                </span>
                <span v-else>熔断使用默认值（3 次 / 60 秒）</span>
                <span class="spacer"></span>
                <span class="mono">{{ group.models.length }} 候选</span>
              </div>
            </article>
          </div>
        </template>
      </div>
    </div>

    <ModelEditor
      v-if="schemas !== undefined"
      :open="modelEditorOpen"
      :model-value="modelTarget"
      :providers="providers"
      :groups="groups"
      :options="options"
      :schema="schemas.model"
      :provider-schema="schemas.provider"
      :busy="saving"
      :error="modelEditorError"
      @save="handleModelSave"
      @close="closeModelEditor"
    />
    <ProviderEditor
      v-if="schemas !== undefined"
      :open="providerEditorOpen"
      :provider="providerTarget"
      :schema="schemas.provider"
      :busy="saving"
      :error="providerEditorError"
      @save="handleProviderSave"
      @close="closeProviderEditor"
    />
    <GroupEditor
      v-if="schemas !== undefined"
      :open="groupEditorOpen"
      :model-value="groupTarget"
      :providers="providers"
      :groups="groups"
      :options="options"
      :schema="schemas.group"
      :locked-name="editingGroupLocked"
      :busy="saving"
      :error="groupEditorError"
      @save="handleGroupSave"
      @close="closeGroupEditor"
    />

    <BaseModal
      :open="deleteTarget !== undefined"
      :title="deleteTitle"
      :desc="deleteBlocked ? '先调整引用，再删除这项配置。' : '删除后会重建 gateway 模型目录。'"
      @close="closeDelete"
    >
      <div v-if="deleteImpact !== undefined">
        <template v-if="deleteBlocked">
          <p>「{{ deleteImpact.label }}」仍被以下配置引用：</p>
          <div class="impact-list">
            <span v-for="name in deleteImpact.groups" :key="`group:${name}`"
              ><strong>模型组 {{ name }}</strong> 的候选列表包含该引用。</span
            >
            <span v-for="id in deleteImpact.profiles" :key="`profile:${id}`"
              ><strong>Profile {{ id }}</strong> 的 model 指向该引用。</span
            >
          </div>
        </template>
        <template v-else>
          <p>
            确认删除 <span class="mono">{{ deleteImpact.label }}</span
            >？
          </p>
          <div class="impact-list">
            <span v-if="deleteTarget?.kind === 'model'">从对应供应商的 models 列表中移除该声明。</span>
            <span v-else>删除整条组配置；组内模型声明保持不变。</span>
            <span>保存后会重新构建 gateway 目录，并校验全部 Profile 与模型组引用。</span>
          </div>
        </template>
        <div v-if="deleteError.length > 0" class="field-error" style="margin-top: 8px">{{ deleteError }}</div>
      </div>
      <template #footer>
        <template v-if="deleteBlocked">
          <button type="button" class="btn" @click="closeDelete">关闭</button>
          <button type="button" class="btn btn-soft" @click="resolveReferences">去处理引用</button>
        </template>
        <template v-else>
          <button type="button" class="btn" :disabled="deleting" @click="closeDelete">取消</button>
          <button type="button" class="btn btn-danger" :disabled="deleting || saving" @click="confirmDelete">
            <span v-if="deleting" class="spinner" aria-hidden="true"></span>
            {{ deleting ? "删除中…" : "删除" }}
          </button>
        </template>
      </template>
    </BaseModal>
  </PageShell>
</template>
