<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import BaseModal from "../components/BaseModal.vue";
import EmptyState from "../components/EmptyState.vue";
import GroupEditor from "../components/GroupEditor.vue";
import Icon from "../components/Icon.vue";
import ModelEditor from "../components/ModelEditor.vue";
import PageHeader from "../components/PageHeader.vue";
import type { ModelGroup, ModelType, ProviderConfig } from "../data/types";
import { MODEL_TYPES } from "../data/types";
import { formatCompact, formatNumber, maskSecret, relativeTime } from "../lib/format";
import { apiLabel, groupStrategyDescription, groupStrategyLabel, modelCapabilitySummary, modelRows, modelTypeLabel, parseReference } from "../lib/models";
import { deleteGroup, deleteModel, navigate, referencesForGroup, referencesForModel, store, toast } from "../store";

const tab = ref<"models" | "groups">("models");
const query = ref("");
const typeFilter = ref<"all" | ModelType>("all");
const editorOpen = ref(false);
const editingReference = ref<string | undefined>(undefined);
const presetProvider = ref<string | undefined>(undefined);
const groupEditorOpen = ref(false);
const editingGroup = ref<string | undefined>(undefined);
const loading = ref(false);
const loadedAt = ref(Date.now());
const deleteState = reactive({
  open: false,
  kind: "model" as "model" | "group",
  target: "",
  label: "",
  references: [] as string[],
  error: "",
  busy: false,
});

const allRows = computed(() => modelRows(store.providers));
const filteredRows = computed(() => {
  const term = query.value.trim().toLowerCase();
  return allRows.value.filter(({ provider, model, reference }) => {
    if (typeFilter.value !== "all" && model.type !== typeFilter.value) return false;
    if (term.length === 0) return true;
    return (
      reference.toLowerCase().includes(term) ||
      provider.id.toLowerCase().includes(term) ||
      (model.name ?? "").toLowerCase().includes(term) ||
      model.id.toLowerCase().includes(term)
    );
  });
});
const filteredProviders = computed(() => {
  const map = new Map<string, { provider: ProviderConfig; rows: typeof filteredRows.value }>();
  for (const row of filteredRows.value) {
    const entry = map.get(row.provider.id) ?? { provider: row.provider, rows: [] };
    entry.rows.push(row);
    map.set(row.provider.id, entry);
  }
  return [...map.values()];
});
const filteredGroups = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (term.length === 0) return store.groups;
  return store.groups.filter((group) => group.name.toLowerCase().includes(term) || group.models.some((member) => member.toLowerCase().includes(term)));
});
const lastSaved = computed(() => store.lastSyncAt);

async function reload(): Promise<void> {
  loading.value = true;
  const { promise, resolve } = Promise.withResolvers<void>();
  window.setTimeout(resolve, 620);
  await promise;
  loading.value = false;
  loadedAt.value = Date.now();
  toast("info", "配置已重新读取", "示例数据已恢复到当前内存版本；真实实现会重新解析 models.yaml。");
}

function openNewModel(providerId?: string): void {
  editingReference.value = undefined;
  presetProvider.value = providerId;
  editorOpen.value = true;
}

function openEditModel(reference: string): void {
  editingReference.value = reference;
  presetProvider.value = undefined;
  editorOpen.value = true;
}

function openNewGroup(): void {
  editingGroup.value = undefined;
  groupEditorOpen.value = true;
}

function openEditGroup(name: string): void {
  editingGroup.value = name;
  groupEditorOpen.value = true;
}

function onModelEditorClose(saved?: boolean): void {
  editorOpen.value = false;
  if (saved) loadedAt.value = Date.now();
}

function onGroupEditorClose(saved?: boolean): void {
  groupEditorOpen.value = false;
  if (saved) loadedAt.value = Date.now();
}

function askDeleteModel(reference: string): void {
  const references = referencesForModel(reference);
  deleteState.kind = "model";
  deleteState.target = reference;
  deleteState.label = reference;
  deleteState.references = references;
  deleteState.error = "";
  deleteState.open = true;
}

function askDeleteGroup(name: string): void {
  const references = referencesForGroup(name);
  deleteState.kind = "group";
  deleteState.target = name;
  deleteState.label = name;
  deleteState.references = references;
  deleteState.error = "";
  deleteState.open = true;
}

async function confirmDelete(): Promise<void> {
  deleteState.busy = true;
  const result = deleteState.kind === "model" ? await deleteModel(deleteState.target) : await deleteGroup(deleteState.target);
  deleteState.busy = false;
  if (!result.ok) {
    deleteState.references = result.references;
    deleteState.error = result.error ?? "删除失败。";
    toast("error", deleteState.kind === "model" ? "无法删除模型" : "无法删除模型组", deleteState.error);
    return;
  }
  deleteState.open = false;
  loadedAt.value = Date.now();
  toast("success", deleteState.kind === "model" ? "模型已删除" : "模型组已删除", "gateway 模型目录已重建，引用校验通过。");
}

function resolveReferences(): void {
  deleteState.open = false;
  if (deleteState.references.some((reference) => reference.startsWith("Profile"))) {
    navigate("/profiles");
    return;
  }
  tab.value = deleteState.kind === "model" ? "groups" : "models";
}

function providerKeyLabel(provider: ProviderConfig): string {
  return maskSecret(provider.apiKey);
}

function groupMembers(group: ModelGroup): Array<{ reference: string; level?: string; modelId: string }> {
  return group.models.map((reference) => {
    const parsed = parseReference(reference);
    return "group" in parsed ? { reference, modelId: reference } : { reference, level: parsed.level, modelId: `${parsed.provider}:${parsed.modelId}` };
  });
}

function typeBadgeClass(type: ModelType): string {
  if (type === "language") return "badge-success";
  if (type === "embedding") return "badge-info";
  if (type === "decision") return "badge-warning";
  return "badge-neutral";
}
</script>

<template>
  <PageHeader
    title="模型配置"
    desc="编辑示例 models.yaml 中的 providers 与 groups。字段跟随 API 端点类型和模型类型变化；保存后其他页面的模型选择器会立即同步。"
    eyebrow="运行 / 模型目录"
  >
    <template #actions>
      <button type="button" class="btn btn-ghost" :disabled="loading" @click="reload">
        <span v-if="loading" class="spinner" aria-hidden="true"></span>
        <Icon v-else name="refresh" :size="15" />
        {{ loading ? "读取中…" : "重新读取" }}
      </button>
      <button v-if="tab === 'models'" type="button" class="btn btn-primary" @click="openNewModel()"><Icon name="plus" :size="15" /> 新增模型</button>
      <button v-else type="button" class="btn btn-primary" @click="openNewGroup"><Icon name="plus" :size="15" /> 新建模型组</button>
    </template>
  </PageHeader>

  <div class="session-meta-strip" style="margin-bottom: 18px">
    <span class="row" style="gap: 6px">
      <span v-if="loading" class="spinner" aria-hidden="true"></span>
      <span v-else class="status-dot" aria-hidden="true" style="margin: 0"></span>
      <strong>{{ loading ? "正在读取配置" : "配置已加载" }}</strong>
      <span class="muted">{{ loading ? "解析 providers 与 groups…" : relativeTime(loadedAt) }}</span>
    </span>
    <span
      >供应商 <strong>{{ store.providers.length }}</strong></span
    >
    <span
      >模型 <strong>{{ allRows.length }}</strong></span
    >
    <span
      >模型组 <strong>{{ store.groups.length }}</strong></span
    >
    <span v-if="lastSaved !== undefined" class="sync-note">
      <Icon name="check" :size="13" /> 保存于 {{ relativeTime(lastSaved) }}，选择器已同步
      <button type="button" class="link" style="border: 0; background: none; padding: 0" @click="navigate('/profiles')">去 Profile 验证</button>
    </span>
  </div>

  <div class="panel">
    <div class="panel-head" style="padding-bottom: 0; border-bottom: 0; align-items: flex-end">
      <div class="tabs" role="tablist" aria-label="模型配置视图" style="border-bottom: 0">
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'models'" :tabindex="tab === 'models' ? 0 : -1" @click="tab = 'models'">
          模型 <span class="tab-count">{{ allRows.length }}</span>
        </button>
        <button type="button" role="tab" class="tab" :aria-selected="tab === 'groups'" :tabindex="tab === 'groups' ? 0 : -1" @click="tab = 'groups'">
          模型组 <span class="tab-count">{{ store.groups.length }}</span>
        </button>
      </div>
      <div class="panel-actions" style="padding-bottom: 8px">
        <div class="search-box" style="width: 240px">
          <Icon name="search" :size="15" />
          <input v-model="query" class="input" :aria-label="tab === 'models' ? '搜索模型' : '搜索模型组'" placeholder="搜索引用、名称或供应商" />
        </div>
        <select v-if="tab === 'models'" v-model="typeFilter" class="select" aria-label="按模型类型筛选" style="width: 126px">
          <option value="all">全部类型</option>
          <option v-for="type in MODEL_TYPES" :key="type" :value="type">{{ modelTypeLabel(type) }}</option>
        </select>
      </div>
    </div>

    <div class="panel-body">
      <template v-if="tab === 'models'">
        <div v-if="filteredProviders.length === 0" class="empty">
          <div class="empty-mark"><Icon name="search" :size="20" /></div>
          <div class="empty-title">没有匹配的模型</div>
          <p class="empty-desc">清除搜索词或切换模型类型；也可以直接新增一个模型。</p>
          <button
            type="button"
            class="btn btn-soft"
            @click="
              query = '';
              typeFilter = 'all';
            "
          >
            清除筛选
          </button>
        </div>

        <div v-else class="stack">
          <section v-for="entry in filteredProviders" :key="entry.provider.id" class="provider-block">
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
                  <span>{{ entry.rows.length }} 个模型</span>
                  <span v-if="Object.keys(entry.provider.headers).length > 0">{{ Object.keys(entry.provider.headers).length }} 个 header</span>
                </div>
              </div>
              <div class="provider-actions">
                <button type="button" class="btn btn-sm" @click="openNewModel(entry.provider.id)"><Icon name="plus" :size="13" /> 添加模型</button>
              </div>
            </header>

            <div class="card-grid">
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
        <div v-if="filteredGroups.length === 0" class="empty">
          <div class="empty-mark"><Icon name="search" :size="20" /></div>
          <div class="empty-title">没有匹配的模型组</div>
          <p class="empty-desc">模型组把多个语言模型编成候选列表；Profile 的 model 可以直接引用组名。</p>
          <button type="button" class="btn btn-soft" @click="query = ''">清除搜索</button>
        </div>

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
                <span class="flex-1">{{ member.modelId }}</span>
                <span v-if="member.level !== undefined" class="badge badge-outline">{{ member.level }}</span>
              </div>
            </div>

            <div class="row muted small" style="padding-top: 2px">
              <Icon name="pulse" :size="13" />
              <span>熔断 {{ group.circuitBreaker.failureThreshold }} 次 / {{ group.circuitBreaker.cooldownSeconds }} 秒</span>
              <span class="spacer"></span>
              <span class="mono">{{ group.models.length }} 候选</span>
            </div>
          </article>
        </div>
      </template>
    </div>
  </div>

  <ModelEditor :open="editorOpen" :reference="editingReference" :preset-provider="presetProvider" @close="onModelEditorClose" />
  <GroupEditor :open="groupEditorOpen" :name="editingGroup" @close="onGroupEditorClose" />

  <BaseModal
    :open="deleteState.open"
    :title="deleteState.references.length > 0 ? '仍有引用，无法删除' : deleteState.kind === 'model' ? '删除模型' : '删除模型组'"
    :desc="deleteState.references.length > 0 ? '先调整引用，再删除这项配置。' : '删除后会重建 gateway 模型目录。'"
    @close="deleteState.open = false"
  >
    <div v-if="deleteState.references.length > 0">
      <p>「{{ deleteState.label }}」仍被以下配置引用：</p>
      <div class="impact-list">
        <span v-for="reference in deleteState.references" :key="reference"
          ><strong>{{ reference }}</strong></span
        >
      </div>
      <div v-if="deleteState.error" class="field-error" style="margin-top: 8px">{{ deleteState.error }}</div>
    </div>
    <div v-else>
      <p>
        确认删除 <span class="mono">{{ deleteState.label }}</span
        >？
      </p>
      <div class="impact-list">
        <span v-if="deleteState.kind === 'model'">从对应 provider 的 models 列表中移除该声明。</span>
        <span v-else>删除整条组配置；组内模型声明保持不变。</span>
        <span>保存后会重新构建 gateway 目录，并校验全部 Profile 与模型组引用。</span>
        <span>示例操作只修改内存数据，不会触碰真实 models.yaml。</span>
      </div>
    </div>
    <template #footer>
      <template v-if="deleteState.references.length > 0">
        <button type="button" class="btn" @click="deleteState.open = false">关闭</button>
        <button type="button" class="btn btn-soft" @click="resolveReferences">去处理引用</button>
      </template>
      <template v-else>
        <button type="button" class="btn" @click="deleteState.open = false">取消</button>
        <button type="button" class="btn btn-danger" :disabled="deleteState.busy" @click="confirmDelete">
          <span v-if="deleteState.busy" class="spinner" aria-hidden="true"></span>
          {{ deleteState.busy ? "删除中…" : "删除" }}
        </button>
      </template>
    </template>
  </BaseModal>
</template>
