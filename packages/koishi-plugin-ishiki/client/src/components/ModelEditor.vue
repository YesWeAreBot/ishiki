<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";

import BaseModal from "../components/BaseModal.vue";
import DrawerShell from "../components/DrawerShell.vue";
import FormField from "../components/FormField.vue";
import Icon from "../components/Icon.vue";
import ToggleSwitch from "../components/ToggleSwitch.vue";
import type { ApiName, Modality, ModelDecl, ModelType, ProviderConfig, ThinkLevel } from "../data/types";
import { MODALITIES, THINK_LEVELS } from "../data/types";
import { API_OPTIONS, MODEL_TYPE_OPTIONS, THINK_LEVEL_LABELS, apiLabel, findDeclaredModel } from "../lib/models";
import { referencesForModel, saveModel, setDirty, store, toast } from "../store";

const props = defineProps<{ open: boolean; reference?: string; presetProvider?: string }>();
const emit = defineEmits<{ close: [saved?: boolean] }>();

const providerChoice = ref("__new");
const providerId = ref("");
const api = ref<ApiName>("openai-completions");
const baseUrl = ref("");
const apiKey = ref("");
const showSecret = ref(false);
const headers = ref<Array<{ key: string; value: string }>>([]);
const settingsText = ref("{}");
const model = ref<ModelDecl>({ id: "", type: "language", name: "", input: ["text"], toolCall: true });
const saving = ref(false);
const serverError = ref("");
const confirmDiscard = ref(false);
const baseline = ref("");
const errors = reactive<Record<string, string>>({});

const isEditing = computed(() => props.reference !== undefined);
const references = computed(() => (props.reference === undefined ? [] : referencesForModel(props.reference)));
const locked = computed(() => references.value.length > 0);
const provider = computed(() => store.providers.find((entry) => entry.id === providerChoice.value));
const isNewProvider = computed(() => providerChoice.value === "__new");
const selectedApi = computed(() => API_OPTIONS.find((entry) => entry.value === api.value) ?? API_OPTIONS[0]);
const selectedType = computed(() => MODEL_TYPE_OPTIONS.find((entry) => entry.value === model.value.type) ?? MODEL_TYPE_OPTIONS[0]);
const providerModelCount = computed(() => provider.value?.models.length ?? 0);
const referencePreview = computed(() => `${providerId.value || providerChoice.value || "provider"}:${model.value.id || "model"}`);

function snapshot(): string {
  return JSON.stringify({
    providerChoice: providerChoice.value,
    providerId: providerId.value,
    api: api.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    headers: headers.value,
    settingsText: settingsText.value,
    model: model.value,
  });
}

const dirty = computed(() => props.open && baseline.value.length > 0 && snapshot() !== baseline.value);

watch(dirty, (value) => setDirty("model-editor", value));

function clearErrors(): void {
  for (const key of Object.keys(errors)) delete errors[key];
  serverError.value = "";
}

function applyProvider(entry: ProviderConfig): void {
  providerId.value = entry.id;
  api.value = entry.api;
  baseUrl.value = entry.baseUrl ?? "";
  apiKey.value = entry.apiKey;
  headers.value = Object.entries(entry.headers).map(([key, value]) => ({ key, value }));
  settingsText.value = JSON.stringify(entry.settings ?? {}, null, 2);
}

function hydrate(): void {
  clearErrors();
  baseline.value = "";
  showSecret.value = false;
  if (props.reference !== undefined) {
    const found = findDeclaredModel(store.providers, props.reference);
    if (found === undefined) {
      serverError.value = "模型已不存在。";
      return;
    }
    providerChoice.value = found.provider.id;
    applyProvider(found.provider);
    model.value = JSON.parse(JSON.stringify(found.model)) as ModelDecl;
  } else if (props.presetProvider !== undefined) {
    const entry = store.providers.find((providerEntry) => providerEntry.id === props.presetProvider);
    if (entry !== undefined) {
      providerChoice.value = entry.id;
      applyProvider(entry);
    }
    model.value = { id: "", type: "language", name: "", input: ["text"], toolCall: true };
  } else {
    providerChoice.value = "__new";
    providerId.value = "";
    api.value = "openai-completions";
    baseUrl.value = "";
    apiKey.value = "";
    headers.value = [];
    settingsText.value = "{}";
    model.value = { id: "", type: "language", name: "", input: ["text"], toolCall: true };
  }
  nextTick(() => {
    baseline.value = snapshot();
    setDirty("model-editor", false);
  });
}

watch(
  () => props.open,
  (open) => {
    if (open) hydrate();
    else {
      setDirty("model-editor", false);
      confirmDiscard.value = false;
    }
  },
);

watch(providerChoice, (choice) => {
  if (choice === "__new") {
    providerId.value = "";
    api.value = "openai-completions";
    baseUrl.value = "";
    apiKey.value = "";
    headers.value = [];
    settingsText.value = "{}";
    return;
  }
  const entry = store.providers.find((candidate) => candidate.id === choice);
  if (entry !== undefined) applyProvider(entry);
});

function updateBodyType(type: ModelType): void {
  const next: ModelDecl = { id: model.value.id, type, name: model.value.name };
  if (type === "language") {
    next.input = model.value.input?.length ? model.value.input : ["text"];
    next.toolCall = model.value.toolCall ?? true;
    next.reasoning = model.value.reasoning ?? false;
    if (model.value.contextWindow !== undefined) next.contextWindow = model.value.contextWindow;
    if (model.value.maxTokens !== undefined) next.maxTokens = model.value.maxTokens;
    if (model.value.thinking !== undefined) next.thinking = model.value.thinking;
  } else if (type === "embedding") {
    next.input = model.value.input?.length ? model.value.input : ["text"];
    next.dimensions = model.value.dimensions ?? 1024;
  }
  model.value = next;
}

function toggleModality(modality: Modality): void {
  const current = model.value.input ?? [];
  const next = current.includes(modality) ? current.filter((entry) => entry !== modality) : [...current, modality];
  model.value.input = next;
}

function toggleThinking(enabled: boolean): void {
  if (enabled) model.value.thinking = { mode: "effort", efforts: ["low", "medium", "high"] };
  else delete model.value.thinking;
}

function toggleEffort(level: ThinkLevel): void {
  const current = model.value.thinking?.efforts ?? [];
  const next = current.includes(level) ? current.filter((entry) => entry !== level) : [...current, level];
  model.value.thinking = { mode: "effort", efforts: next };
}

function addHeader(): void {
  headers.value.push({ key: "", value: "" });
}

function removeHeader(index: number): void {
  headers.value.splice(index, 1);
}

function parseSettings(): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(settingsText.value || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.settings = "settings 必须是 JSON 对象。";
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    errors.settings = `settings JSON 无法解析：${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  }
}

function validate(): boolean {
  clearErrors();
  if (providerChoice.value === "__new") {
    if (providerId.value.trim().length === 0) errors.providerId = "新建供应商需要 ID。";
    else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(providerId.value.trim())) errors.providerId = "只能使用字母、数字、点、下划线与连字符。";
  }
  if (apiKey.value.trim().length === 0) errors.apiKey = "API key 必填；支持 ${ENV_VAR} 插值。";
  if (baseUrl.value.trim().length > 0 && !/^https?:\/\//.test(baseUrl.value.trim()) && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(baseUrl.value.trim())) {
    errors.baseUrl = "baseUrl 需要 http(s) URL，或一个完整的环境变量引用。";
  }
  const seen = new Set<string>();
  for (const [index, header] of headers.value.entries()) {
    if (header.key.trim().length === 0) {
      errors[`header.${index}`] = "Header 名称不能为空。";
      continue;
    }
    if (seen.has(header.key.trim().toLowerCase())) errors[`header.${index}`] = "Header 名称重复。";
    seen.add(header.key.trim().toLowerCase());
  }
  if (model.value.id.trim().length === 0) errors.modelId = "模型 ID 必填。";
  else if (model.value.id.includes(":")) errors.modelId = "模型 ID 不能包含冒号。";
  if (model.value.type === "language") {
    for (const key of ["contextWindow", "maxTokens"] as const) {
      const value = model.value[key];
      if (value !== undefined && value !== null && (value as unknown) !== "" && (!Number.isInteger(value) || value <= 0)) errors[key] = "需要大于 0 的整数。";
    }
    if (model.value.thinking !== undefined && model.value.thinking.efforts.length === 0) errors.thinking = "至少选择一个思考档位。";
    if (model.value.input === undefined || model.value.input.length === 0) errors.input = "至少声明一种输入模态。";
  }
  if (model.value.type === "embedding") {
    const dimensions = model.value.dimensions;
    if (dimensions !== undefined && dimensions !== null && (dimensions as unknown) !== "" && (!Number.isInteger(dimensions) || dimensions <= 0)) {
      errors.dimensions = "维度需要大于 0 的整数。";
    }
    if (model.value.input === undefined || model.value.input.length === 0) errors.input = "至少声明一种输入模态。";
  }
  parseSettings();
  return Object.keys(errors).length === 0;
}

async function submit(): Promise<void> {
  serverError.value = "";
  if (!validate()) {
    serverError.value = "还有字段需要修正。";
    await nextTick();
    document.querySelector<HTMLElement>(".drawer [aria-invalid='true']")?.focus();
    return;
  }
  const settings = parseSettings();
  if (settings === undefined) return;
  const modelDraft = JSON.parse(JSON.stringify(model.value)) as ModelDecl;
  for (const key of ["contextWindow", "maxTokens", "dimensions"] as const) {
    if ((modelDraft[key] as unknown) === "" || modelDraft[key] === null) delete modelDraft[key];
  }
  saving.value = true;
  const result = await saveModel({
    originalReference: props.reference,
    providerId: providerChoice.value === "__new" ? providerId.value.trim() : providerChoice.value,
    providerIsNew: providerChoice.value === "__new",
    api: api.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    headers: Object.fromEntries(headers.value.filter((header) => header.key.trim().length > 0).map((header) => [header.key.trim(), header.value])),
    settings,
    model: modelDraft,
  });
  saving.value = false;
  if (!result.ok) {
    serverError.value = result.error ?? "保存失败。";
    if (serverError.value.includes("apiKey") || serverError.value.includes("environment variable")) errors.apiKey = serverError.value;
    else if (serverError.value.includes("已经声明") || serverError.value.includes("模型 ID")) errors.modelId = serverError.value;
    else if (serverError.value.includes("供应商")) errors.providerId = serverError.value;
    toast("error", "模型保存失败", serverError.value);
    return;
  }
  baseline.value = snapshot();
  setDirty("model-editor", false);
  toast("success", "模型已保存", "Profile 与模型组中的模型选择器已同步，无需刷新页面。");
  emit("close", true);
}

function requestClose(): void {
  if (dirty.value) confirmDiscard.value = true;
  else emit("close", false);
}

function discard(): void {
  confirmDiscard.value = false;
  setDirty("model-editor", false);
  emit("close", false);
}

onBeforeUnmount(() => setDirty("model-editor", false));
</script>

<template>
  <DrawerShell
    :open="open"
    :title="isEditing ? '编辑模型' : '新增模型'"
    :desc="isEditing ? '修改声明会重建 gateway 模型目录；被引用的模型不能改 ID 或类型。' : '模型声明写入示例 providers；保存后所有模型选择器会同步更新。'"
    width="min(780px, 100vw)"
    @close="requestClose"
  >
    <div v-if="serverError" class="error-panel" role="alert">
      <Icon name="alert" :size="16" />
      <div>
        <strong>无法保存</strong>
        <div>{{ serverError }}</div>
      </div>
    </div>

    <section class="form-section" :class="{ 'form-section': serverError }">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">供应商与端点</div>
          <div class="form-section-desc">这些字段属于 provider，会影响该供应商下的全部模型。</div>
        </div>
      </div>

      <div class="form-grid">
        <FormField label="归属供应商" required :hint="isEditing ? '编辑模型时不能切换到其他供应商。' : '可复用现有供应商，或新建一个。'">
          <select v-model="providerChoice" class="select" :disabled="isEditing">
            <option value="__new">新建供应商</option>
            <option v-for="entry in store.providers" :key="entry.id" :value="entry.id">{{ entry.id }} · {{ apiLabel(entry.api) }}</option>
          </select>
        </FormField>

        <FormField v-if="isNewProvider" label="供应商 ID" required :error="errors.providerId" hint="例如 deepseek、relay、local。">
          <input v-model="providerId" class="input input-mono" :aria-invalid="errors.providerId !== undefined" placeholder="relay" />
        </FormField>
        <FormField v-else label="模型引用" hint="引用格式 provider:model[:thinkLevel]">
          <input :value="referencePreview" class="input input-mono" readonly />
        </FormField>

        <FormField label="API 端点类型" required :hint="selectedApi.hint">
          <select v-model="api" class="select">
            <option v-for="entry in API_OPTIONS" :key="entry.value" :value="entry.value">
              {{ entry.label }}
            </option>
          </select>
        </FormField>

        <FormField label="Base URL" :error="errors.baseUrl" hint="留空时使用该方言的默认端点；支持 http(s) 地址。">
          <input v-model="baseUrl" class="input input-mono" :aria-invalid="errors.baseUrl !== undefined" placeholder="https://api.example.com/v1" />
        </FormField>

        <FormField label="API Key" required :error="errors.apiKey" hint="支持 ${ENV_VAR}；未设置的环境变量会让 gateway 重建失败。">
          <div class="row">
            <input
              v-model="apiKey"
              class="input input-mono flex-1"
              :type="showSecret ? 'text' : 'password'"
              :aria-invalid="errors.apiKey !== undefined"
              placeholder="${DEEPSEEK_KEY}"
            />
            <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="showSecret ? '隐藏密钥' : '显示密钥'" @click="showSecret = !showSecret">
              <Icon :name="showSecret ? 'eye' : 'lock'" :size="15" />
            </button>
          </div>
        </FormField>

        <FormField label="settings" class="span-2" :error="errors.settings" :hint="selectedApi.settingsHint">
          <textarea v-model="settingsText" class="textarea input-mono" :aria-invalid="errors.settings !== undefined" spellcheck="false" rows="3"></textarea>
        </FormField>

        <div class="span-2">
          <div class="row" style="margin-bottom: 7px">
            <span class="field-label">附加 Headers</span>
            <button type="button" class="btn btn-ghost btn-sm" @click="addHeader"><Icon name="plus" :size="13" /> 添加</button>
          </div>
          <div v-if="headers.length === 0" class="field-hint">没有附加请求头。值同样支持 ${ENV_VAR} 插值。</div>
          <div v-else class="kv-list">
            <div v-for="(header, index) in headers" :key="index">
              <div class="kv-row">
                <input v-model="header.key" class="input" :aria-label="`Header ${index + 1} 名称`" placeholder="Header 名称" />
                <input v-model="header.value" class="input" :aria-label="`Header ${index + 1} 值`" placeholder="值，支持 ${ENV_VAR}" />
                <button type="button" class="btn btn-ghost btn-icon btn-sm" :aria-label="`移除 Header ${index + 1}`" @click="removeHeader(index)">
                  <Icon name="trash" :size="14" />
                </button>
              </div>
              <div v-if="errors[`header.${index}`]" class="field-error">{{ errors[`header.${index}`] }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isEditing && providerModelCount > 1" class="notice" style="margin-top: 12px">
        <Icon name="info" :size="15" />
        <span>该供应商还有 {{ providerModelCount - 1 }} 个模型。修改端点、密钥或 headers 会同时影响它们。</span>
      </div>
    </section>

    <section class="form-section">
      <div class="form-section-head">
        <div>
          <div class="form-section-title">模型声明</div>
          <div class="form-section-desc">{{ selectedType.description }}</div>
        </div>
      </div>

      <div v-if="locked" class="notice notice-warning" style="margin-bottom: 13px">
        <Icon name="warningCircle" :size="15" />
        <span> 该模型被 {{ references.join("、") }} 引用，因此模型 ID 与类型不可更改。需要改名时先调整引用。 </span>
      </div>

      <div class="form-grid">
        <FormField label="模型 ID" required :error="errors.modelId" hint="对应接口的 model 参数；可以包含 provider 特有的斜杠或点。">
          <input v-model="model.id" class="input input-mono" :aria-invalid="errors.modelId !== undefined" :disabled="locked" placeholder="deepseek-chat" />
        </FormField>

        <FormField label="模型类型" required :hint="locked ? '被引用时锁定。' : '类型决定下方展示的声明字段。'">
          <select :value="model.type" class="select" :disabled="locked" @change="updateBodyType(($event.target as HTMLSelectElement).value as ModelType)">
            <option v-for="entry in MODEL_TYPE_OPTIONS" :key="entry.value" :value="entry.value">{{ entry.label }}</option>
          </select>
        </FormField>

        <FormField label="显示名称" hint="留空时界面显示模型 ID。">
          <input v-model="model.name" class="input" placeholder="DeepSeek Chat" />
        </FormField>

        <FormField v-if="model.type === 'embedding'" label="向量维度" :error="errors.dimensions" hint="仅 embedding 模型使用。">
          <input v-model.number="model.dimensions" type="number" min="1" class="input" :aria-invalid="errors.dimensions !== undefined" placeholder="1024" />
        </FormField>
      </div>

      <div v-if="model.type === 'language' || model.type === 'embedding'" style="margin-top: 14px">
        <div class="field-label">输入模态 <span class="required" aria-hidden="true">*</span></div>
        <div class="field-hint" style="margin-bottom: 6px">imageInput 开启的 Profile 要求候选模型声明 image。</div>
        <div class="chip-set">
          <button
            v-for="modality in MODALITIES"
            :key="modality"
            type="button"
            class="chip-toggle"
            :aria-pressed="model.input?.includes(modality) ?? false"
            @click="toggleModality(modality)"
          >
            {{ modality }}
          </button>
        </div>
        <div v-if="errors.input" class="field-error">{{ errors.input }}</div>
      </div>

      <div v-if="model.type === 'language'" class="form-grid" style="margin-top: 14px">
        <div class="field span-2">
          <span class="field-label">能力声明</span>
          <div class="row row-wrap">
            <ToggleSwitch :checked="model.toolCall ?? false" label="工具调用 toolCall" @update:checked="model.toolCall = $event" />
            <ToggleSwitch :checked="model.reasoning ?? false" label="推理输出 reasoning" @update:checked="model.reasoning = $event" />
            <ToggleSwitch :checked="model.thinking !== undefined" label="思考档位 thinking" @update:checked="toggleThinking" />
          </div>
        </div>

        <FormField label="上下文窗口" :error="errors.contextWindow" hint="token 数；用于展示，不限制实际请求。">
          <input
            v-model.number="model.contextWindow"
            type="number"
            min="1"
            class="input"
            :aria-invalid="errors.contextWindow !== undefined"
            placeholder="128000"
          />
        </FormField>
        <FormField label="最大输出" :error="errors.maxTokens" hint="token 数。">
          <input v-model.number="model.maxTokens" type="number" min="1" class="input" :aria-invalid="errors.maxTokens !== undefined" placeholder="8192" />
        </FormField>

        <div v-if="model.thinking !== undefined" class="field span-2">
          <span class="field-label">可用的思考档位</span>
          <div class="field-hint" style="margin-bottom: 6px">Profile 引用末尾的 :level 必须落在这里声明的档位中，否则 gateway 构建失败。</div>
          <div class="chip-set">
            <button
              v-for="level in THINK_LEVELS"
              :key="level"
              type="button"
              class="chip-toggle"
              :aria-pressed="model.thinking.efforts.includes(level)"
              @click="toggleEffort(level)"
            >
              {{ THINK_LEVEL_LABELS[level] }}
            </button>
          </div>
          <div v-if="errors.thinking" class="field-error">{{ errors.thinking }}</div>
        </div>

        <div v-if="api === 'typesafe-ai'" class="notice notice-warning span-2">
          <Icon name="warningCircle" :size="15" />
          <span>TypeSafe System One 是判定模型端点。语言模型通常不放在这里；Ishiki 对话会按语言模型能力校验。</span>
        </div>
      </div>

      <div v-if="model.type !== 'language' && model.type !== 'embedding'" class="notice" style="margin-top: 14px">
        <Icon name="info" :size="15" />
        <span>当前 gateway 的 {{ selectedType.label }} 声明只有 id 与显示名。Ishiki 的对话链路只使用语言模型。</span>
      </div>
    </section>

    <template #footer>
      <span class="dirty-note">
        <template v-if="dirty"><span class="badge badge-warning">未保存</span> 修改只存在当前表单。</template>
        <template v-else
          >引用预览：<span class="mono">{{ referencePreview }}</span></template
        >
      </span>
      <button type="button" class="btn" @click="requestClose">取消</button>
      <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
        <span v-if="saving" class="spinner" aria-hidden="true"></span>
        {{ saving ? "保存中…" : "保存模型" }}
      </button>
    </template>
  </DrawerShell>

  <BaseModal :open="confirmDiscard" title="放弃未保存的修改？" desc="表单内容会丢失，已保存的模型配置不受影响。" @close="confirmDiscard = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmDiscard = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discard">放弃修改</button>
    </template>
  </BaseModal>
</template>
