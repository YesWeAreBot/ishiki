<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { ApiError, call } from "../api";
import { buildModelDecl, hasErrors, remoteToDraft, validateModelDraft, type FieldErrors } from "../lib/modelFields";
import { modelOptions, toModelDecl } from "../lib/models";
import {
  blankProfileDraft,
  buildProfileConfig,
  draftFromProfile,
  engineChoices,
  hasProfileErrors,
  parsePatterns,
  validateProfileDraft,
  type ProfileChannelDraft,
  type ProfileDraft,
} from "../lib/profileDraft";
import { store, toast } from "../store";
import type { GroupView, ModelDecl, ModelOption, ModelsDocument, ProfileView, ProviderInput, ProviderView, RemoteModelInfo, RemoteModelsQuery } from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import ModelFieldsForm from "./ModelFieldsForm.vue";
import RemoteModelPicker from "./RemoteModelPicker.vue";

/**
 * 配置向导：分步完成基础信息、模型、频道认领、人格与引擎，最后统一创建。
 * 编辑已有 Profile 时回填其配置，完成后走保存接口；中途取消不会产生半成品。
 */
const props = defineProps<{
  open: boolean;
  /** 提供时为重新配置已有 Profile：标识锁定，回填已保存配置。 */
  profile?: ProfileView;
}>();

const emit = defineEmits<{ close: []; created: [view: ProfileView] }>();

const router = useRouter();

interface StepDef {
  key: "basic" | "model" | "channels" | "persona" | "confirm";
  label: string;
  desc: string;
}

const ALL_STEPS: StepDef[] = [
  { key: "basic", label: "基础信息", desc: "标识与运行模式" },
  { key: "model", label: "模型", desc: "选择已有声明或新建供应商与模型" },
  { key: "channels", label: "频道认领", desc: "声明实例认领哪些频道" },
  { key: "persona", label: "人格与引擎", desc: "人格文本与三类引擎" },
  { key: "confirm", label: "确认", desc: "核对后写入配置" },
];

const NEW_PROVIDER = "__new";

const draft = ref<ProfileDraft>(blankProfileDraft());
const stepIndex = ref(0);
const touched = ref(false);
const confirmCancel = ref(false);
const submitting = ref(false);
const wizardError = ref("");

const modelSource = ref<"existing" | "new">("existing");
const providerChoice = ref<string>(NEW_PROVIDER);
const newProviderId = ref("");
const providerDraft = reactive<{ api: string; baseUrl: string; apiKey: string }>({ api: "openai-completions", baseUrl: "", apiKey: "" });
const newModelDraft = ref<Record<string, unknown>>({ type: "language" });

const idLocked = computed(() => props.profile !== undefined);
const steps = computed(() => (draft.value.mode === "cross" ? ALL_STEPS.filter((step) => step.key !== "channels") : ALL_STEPS));
const step = computed(() => steps.value[Math.min(stepIndex.value, steps.value.length - 1)]);
const lastStep = computed(() => stepIndex.value >= steps.value.length - 1);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    wizardError.value = "";
    touched.value = false;
    confirmCancel.value = false;
    submitting.value = false;
    stepIndex.value = 0;
    if (props.profile !== undefined) {
      draft.value = draftFromProfile(props.profile);
      modelSource.value = "existing";
    } else {
      draft.value = blankProfileDraft();
      modelSource.value = store.options.some((option) => option.kind === "model") ? "existing" : "new";
    }
    providerChoice.value = NEW_PROVIDER;
    newProviderId.value = "";
    providerDraft.api = "openai-completions";
    providerDraft.baseUrl = "";
    providerDraft.apiKey = "";
    newModelDraft.value = { type: "language" };
  },
  { immediate: true },
);

const languageOptions = computed<ModelOption[]>(() => modelOptions(store.providers, store.groups, { languageOnly: true }));
const groupOptions = computed(() => languageOptions.value.filter((option) => option.kind === "group"));
const singleModelOptions = computed(() => languageOptions.value.filter((option) => option.kind === "model"));

const selectedProvider = computed<ProviderView | undefined>(() => store.providers.find((entry) => entry.id === providerChoice.value));
const activeProviderId = computed(() => (providerChoice.value === NEW_PROVIDER ? newProviderId.value.trim() : providerChoice.value));

const BUILTIN_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "typesafe-ai"] as const;

const apiOptions = computed<Array<{ value: string; label: string }>>(() => {
  const node = store.modelSchemas?.provider.dict?.api;
  if (node?.type === "union" && node.list !== undefined && node.list.length > 0 && node.list.every((branch) => branch.type === "const")) {
    return node.list.map((branch) => ({ value: String(branch.value), label: String(branch.value) }));
  }
  return BUILTIN_APIS.map((api) => ({ value: api, label: api }));
});

const engineDirectories = computed(() => ({
  context: engineChoices(store.engines?.context),
  wakeup: engineChoices(store.engines?.wakeup),
  toolcall: engineChoices(store.engines?.toolcall),
}));

const wizardModelTaken = computed(() => (id: string) => {
  const providerId = activeProviderId.value;
  if (providerId.length === 0) return false;
  return store.providers.find((entry) => entry.id === providerId)?.models.some((model) => model.id === id) ?? false;
});

const modelValidationContext = computed(() => ({ modelTaken: (id: string) => wizardModelTaken.value(id), lockedId: false, originalId: undefined }));

const remoteQuery = computed<RemoteModelsQuery | undefined>(() => {
  if (providerChoice.value !== NEW_PROVIDER && selectedProvider.value !== undefined) return { providerId: providerChoice.value };
  if (providerDraft.api.length === 0 || providerDraft.apiKey.trim().length === 0) return undefined;
  return {
    draft: {
      api: providerDraft.api,
      baseUrl: providerDraft.baseUrl.trim().length > 0 ? providerDraft.baseUrl.trim() : undefined,
      apiKey: providerDraft.apiKey.trim(),
    },
  };
});

const declaredModels = computed<RemoteModelInfo[]>(() => (selectedProvider.value?.models ?? []).map((model) => ({ id: model.id, name: model.name })));

const profileErrors = computed(() =>
  validateProfileDraft(draft.value, {
    idTaken: (id) => store.profiles.some((entry) => entry.id === id && entry.id !== props.profile?.id),
    modelDeclared: (reference) => store.options.some((option) => option.reference === reference),
  }),
);

/** 新建供应商 + 模型分支的字段校验；错误就地展示在对应字段附近。 */
const providerErrors = computed(() => {
  const errors: Record<string, string> = {};
  if (modelSource.value !== "new") return errors;
  if (providerChoice.value === NEW_PROVIDER) {
    if (newProviderId.value.trim().length === 0) errors.providerId = "新建供应商需要填写供应商 ID。";
    else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(newProviderId.value.trim()))
      errors.providerId = "供应商 ID 只能包含字母、数字、点、下划线与连字符，并以字母或数字开头。";
    else if (store.providers.some((entry) => entry.id === newProviderId.value.trim())) errors.providerId = `供应商 ${newProviderId.value.trim()} 已存在。`;
    if (providerDraft.apiKey.trim().length === 0) errors.apiKey = "新建供应商必须填写 API 密钥，支持 ${环境变量} 引用。";
  }
  return errors;
});

const newModelErrors = computed<FieldErrors>(() => (modelSource.value === "new" ? validateModelDraft(newModelDraft.value, modelValidationContext.value) : {}));

/** 当前步骤离开前的校验结果；错误显示在对应字段附近。 */
const stepIssue = computed<string>(() => {
  const key = step.value.key;
  if (key === "basic") return profileErrors.value.id ?? "";
  if (key === "model") {
    if (modelSource.value === "existing") return draft.value.model.length === 0 ? "需要选择一个模型或模型组。" : (profileErrors.value.model ?? "");
    const providerList = Object.values(providerErrors.value);
    if (providerList.length > 0) return providerList[0];
    if (hasErrors(newModelErrors.value)) return Object.values(newModelErrors.value).find((message) => message !== undefined) ?? "";
    return "";
  }
  if (key === "channels") return profileErrors.value.channels ?? "";
  return "";
});

const stepIssueDetail = computed(() => {
  if (step.value.key !== "model" || modelSource.value !== "new") return undefined;
  return newModelErrors.value;
});

function touch(): void {
  touched.value = true;
}

function patchDraft(part: Partial<ProfileDraft>): void {
  draft.value = { ...draft.value, ...part };
  if (part.mode !== undefined) stepIndex.value = Math.min(stepIndex.value, steps.value.length - 1);
  touch();
}

function patchModelDraft(key: string, value: unknown): void {
  newModelDraft.value = { ...newModelDraft.value, [key]: value };
  touch();
}

function pickRemoteModel(model: RemoteModelInfo): void {
  newModelDraft.value = { ...remoteToDraft(model) };
  touch();
}

function patchChannel(index: number, part: Partial<ProfileChannelDraft>): void {
  const channels = draft.value.channels.map((row, position) => (position === index ? { ...row, ...part } : row));
  patchDraft({ channels });
}

function addChannel(): void {
  patchDraft({ channels: [...draft.value.channels, { account: "", patterns: "" }] });
}

function removeChannel(index: number): void {
  patchDraft({ channels: draft.value.channels.filter((_, position) => position !== index) });
}

function goNext(): void {
  if (stepIssue.value.length > 0) return;
  if (lastStep.value) return;
  stepIndex.value += 1;
}

function goBack(): void {
  if (stepIndex.value === 0) return;
  stepIndex.value -= 1;
}

function requestClose(): void {
  if (submitting.value) return;
  if (touched.value) {
    confirmCancel.value = true;
    return;
  }
  emit("close");
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "conflict") return "配置已被其他操作者修改，请关闭向导后重试。";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 当前模型目录快照重建完整配置，向导只在副本上追加，不会产生半成品。 */
function modelsConfigOf(document: ModelsDocument, provider: ProviderInput, providerId: string, model: ModelDecl) {
  const config = {
    providers: Object.fromEntries(
      document.providers.map((entry) => [
        entry.id,
        {
          api: entry.api,
          baseUrl: entry.baseUrl,
          apiKey: "",
          headers: { ...entry.headers },
          settings: JSON.parse(JSON.stringify(entry.settings)) as Record<string, unknown>,
          models: entry.models.map(toModelDecl),
        } satisfies ProviderInput,
      ]),
    ),
    groups: Object.fromEntries(document.groups.map((group): [string, GroupView] => [group.name, { ...group, models: [...group.models] }])),
  };
  const existing = config.providers[providerId];
  if (existing === undefined) {
    config.providers[providerId] = {
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey ?? "",
      headers: provider.headers ?? {},
      settings: provider.settings ?? {},
      models: [model],
    };
  } else existing.models = [...existing.models.filter((decl) => decl.id !== model.id), model];
  return config;
}

async function finish(): Promise<void> {
  if (submitting.value || stepIssue.value.length > 0) return;
  const issues = validateProfileDraft(draft.value, {
    idTaken: (id) => store.profiles.some((entry) => entry.id === id && entry.id !== props.profile?.id),
    modelDeclared: (reference) => store.options.some((option) => option.reference === reference) || willCreateReference.value === reference,
  });
  if (hasProfileErrors(issues)) {
    wizardError.value = Object.values(issues).find((message) => message !== undefined) ?? "";
    return;
  }
  submitting.value = true;
  wizardError.value = "";
  try {
    if (modelSource.value === "new") {
      const document = store.models;
      if (document === undefined) throw new ApiError("offline", "模型配置尚未加载完成，请稍后重试。");
      const providerId = activeProviderId.value;
      const provider: ProviderInput =
        providerChoice.value === NEW_PROVIDER
          ? {
              api: providerDraft.api,
              baseUrl: providerDraft.baseUrl.trim().length > 0 ? providerDraft.baseUrl.trim() : undefined,
              apiKey: providerDraft.apiKey.trim(),
              headers: {},
              settings: {},
              models: [],
            }
          : {
              api: selectedProvider.value?.api ?? "",
              baseUrl: selectedProvider.value?.baseUrl,
              apiKey: "",
              headers: { ...selectedProvider.value?.headers },
              settings: {},
              models: [],
            };
      const config = modelsConfigOf(document, provider, providerId, buildModelDecl(newModelDraft.value));
      await call<ModelsDocument>("ishiki/models/save", { config, revision: document.revision });
      toast("success", "模型配置已保存", `${providerId}:${buildModelDecl(newModelDraft.value).id} 已写入。`);
      patchDraft({ model: `${providerId}:${buildModelDecl(newModelDraft.value).id}` });
    }

    const config = buildProfileConfig(draft.value);
    const persona = draft.value.persona.trim().length > 0 ? draft.value.persona : undefined;
    const view =
      props.profile === undefined
        ? await call<ProfileView>("ishiki/profiles/create", draft.value.id.trim(), { config, persona })
        : await call<ProfileView>("ishiki/profiles/save", draft.value.id.trim(), { config, persona }, props.profile.revision);
    toast("success", props.profile === undefined ? "Profile 已创建" : "Profile 已保存", `${view.id} 完成，应用后才会生效。`);
    submitting.value = false;
    emit("created", view);
  } catch (error) {
    wizardError.value = describeError(error);
    toast("error", props.profile === undefined ? "创建失败" : "保存失败", wizardError.value);
    submitting.value = false;
  }
}

const willCreateReference = computed(() => {
  if (modelSource.value !== "new") return "";
  const providerId = activeProviderId.value;
  const id = typeof newModelDraft.value.id === "string" ? newModelDraft.value.id.trim() : "";
  if (providerId.length === 0 || id.length === 0) return "";
  return `${providerId}:${id}`;
});

function confirmSummary(): Array<{ label: string; value: string }> {
  const channels = draft.value.mode === "channel" ? draft.value.channels.filter((row) => row.account.trim().length > 0) : [];
  return [
    { label: "标识", value: draft.value.id.trim() },
    { label: "运行模式", value: draft.value.mode === "channel" ? "频道模式" : "跨频道模式" },
    { label: "模型", value: draft.value.model || willCreateReference.value || "未选择" },
    {
      label: "频道认领",
      value:
        channels.length === 0 ? "不认领任何频道" : channels.map((row) => `${row.account.trim()}（${parsePatterns(row.patterns).length} 个模式）`).join("、"),
    },
    { label: "引擎", value: `context ${draft.value.engines.context} · wakeup ${draft.value.engines.wakeup} · toolcall ${draft.value.engines.toolcall}` },
    { label: "人格", value: draft.value.persona.trim().length > 0 ? `${draft.value.persona.trim().length} 字` : "留空，稍后在编辑器里写" },
  ];
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="profile === undefined ? '配置向导' : `配置向导 · ${profile.id}`"
    desc="按步骤完成 Profile 的基础配置；所有内容只在最后一步统一写入。"
    width="min(860px, 100%)"
    :closable="!submitting"
    :close-on-backdrop="!submitting"
    @close="requestClose"
  >
    <ol class="wizard-steps" aria-label="向导步骤">
      <li
        v-for="(item, index) in steps"
        :key="item.key"
        :class="{ done: index < stepIndex, current: index === stepIndex }"
        :aria-current="index === stepIndex ? 'step' : undefined"
      >
        <span class="wizard-step-mark" aria-hidden="true">{{ index < stepIndex ? "✓" : index + 1 }}</span>
        <span class="wizard-step-label">{{ item.label }}</span>
        <span class="wizard-step-desc">{{ item.desc }}</span>
      </li>
    </ol>

    <div v-if="wizardError.length > 0" class="error-panel" role="alert" style="margin-top: 12px">
      <Icon name="alert" :size="15" />
      <span class="flex-1">{{ wizardError }}</span>
    </div>

    <!-- 第 1 步：基础信息 -->
    <section v-if="step.key === 'basic'" class="stack-sm" style="margin-top: 14px">
      <FormField label="Profile 标识" required :error="profileErrors.id" hint="作为目录名与引用名，创建后不可修改。">
        <input
          :value="draft.id"
          class="input input-mono"
          :disabled="idLocked || submitting"
          placeholder="例如 assistant-main"
          autocomplete="off"
          @input="patchDraft({ id: ($event.target as HTMLInputElement).value })"
        />
      </FormField>
      <FormField label="运行模式" required hint="频道模式为每个频道创建独立实例；跨频道模式在一个实例里汇合多个频道。">
        <div class="chip-set" role="radiogroup" aria-label="运行模式">
          <button type="button" class="chip-toggle" :aria-pressed="draft.mode === 'channel'" :disabled="submitting" @click="patchDraft({ mode: 'channel' })">
            频道模式
          </button>
          <button type="button" class="chip-toggle" :aria-pressed="draft.mode === 'cross'" :disabled="submitting" @click="patchDraft({ mode: 'cross' })">
            跨频道模式
          </button>
        </div>
      </FormField>
    </section>

    <!-- 第 2 步：模型 -->
    <section v-else-if="step.key === 'model'" class="stack-sm" style="margin-top: 14px">
      <div class="segmented" role="group" aria-label="模型来源">
        <button type="button" :aria-pressed="modelSource === 'existing'" :disabled="submitting" @click="((modelSource = 'existing'), touch())">
          使用已声明模型
        </button>
        <button type="button" :aria-pressed="modelSource === 'new'" :disabled="submitting" @click="((modelSource = 'new'), touch())">新建供应商与模型</button>
      </div>

      <template v-if="modelSource === 'existing'">
        <FormField label="模型或模型组" required :error="profileErrors.model" hint="来自模型目录的现有声明；语言模型与模型组都可以。">
          <select
            :value="draft.model"
            class="select"
            :disabled="submitting"
            aria-label="选择模型或模型组"
            @change="patchDraft({ model: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>选择模型或模型组…</option>
            <optgroup v-if="groupOptions.length > 0" label="模型组">
              <option v-for="option in groupOptions" :key="option.reference" :value="option.reference">{{ option.label }}</option>
            </optgroup>
            <optgroup v-if="singleModelOptions.length > 0" label="模型">
              <option v-for="option in singleModelOptions" :key="option.reference" :value="option.reference">{{ option.label }}</option>
            </optgroup>
          </select>
        </FormField>
        <p v-if="singleModelOptions.length === 0 && groupOptions.length === 0" class="field-hint">模型目录还是空的，切换到「新建供应商与模型」开始声明。</p>
      </template>

      <template v-else>
        <div class="form-grid">
          <FormField label="归属供应商" required hint="可以复用现有供应商，或新建一个。">
            <select v-model="providerChoice" class="select" :disabled="submitting" aria-label="归属供应商" @change="touch()">
              <option :value="NEW_PROVIDER">新建供应商</option>
              <option v-for="entry in store.providers" :key="entry.id" :value="entry.id">{{ entry.id }} · {{ entry.api }}</option>
            </select>
          </FormField>
          <FormField
            v-if="providerChoice === NEW_PROVIDER"
            label="供应商 ID"
            required
            :error="providerErrors.providerId"
            hint="例如 deepseek、relay；保存后不可改名。"
          >
            <input v-model="newProviderId" class="input input-mono" placeholder="relay" autocomplete="off" :disabled="submitting" @input="touch()" />
          </FormField>
        </div>

        <template v-if="providerChoice === NEW_PROVIDER">
          <div class="form-grid">
            <FormField label="接口类型" required hint="决定网关如何与该提供商通信。">
              <select v-model="providerDraft.api" class="select" :disabled="submitting" aria-label="接口类型" @change="touch()">
                <option v-for="option in apiOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </FormField>
            <FormField label="API 地址" hint="留空使用接口默认地址。">
              <input
                v-model="providerDraft.baseUrl"
                class="input input-mono"
                placeholder="https://api.example.com/v1"
                autocomplete="off"
                :disabled="submitting"
                @input="touch()"
              />
            </FormField>
          </div>
          <FormField label="API 密钥" required :error="providerErrors.apiKey" hint="明文密钥或 ${环境变量} 引用；只写入服务端配置，不会在页面回显。">
            <input v-model="providerDraft.apiKey" class="input input-mono" type="password" autocomplete="off" :disabled="submitting" @input="touch()" />
          </FormField>
        </template>

        <div class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">从在线名单导入</div>
              <div class="form-section-desc">按当前供应商拉取提供商模型名单，选择后自动填入声明字段。</div>
            </div>
          </div>
          <RemoteModelPicker :query="remoteQuery" :declared="declaredModels" :disabled="submitting" @pick="pickRemoteModel" />
        </div>

        <div class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">模型声明</div>
              <div class="form-section-desc">字段随模型类型变化；不适用的字段不会提交。</div>
            </div>
          </div>
          <ModelFieldsForm :draft="newModelDraft" :errors="stepIssueDetail" :disabled="submitting" @patch="patchModelDraft" />
        </div>
      </template>
    </section>

    <!-- 第 3 步：频道认领（跨频道模式跳过） -->
    <section v-else-if="step.key === 'channels'" class="stack-sm" style="margin-top: 14px">
      <p class="field-hint">认领表决定 Profile 响应哪些频道。账号写成 platform:selfId；模式支持通配与 ! 排除，例如 *、group:*、!private:*。</p>
      <div v-for="(row, index) in draft.channels" :key="index" class="form-grid wizard-channel-row">
        <FormField label="账号" required>
          <input
            :value="row.account"
            class="input input-mono"
            placeholder="qq:12345"
            autocomplete="off"
            :disabled="submitting"
            @input="patchChannel(index, { account: ($event.target as HTMLInputElement).value })"
          />
        </FormField>
        <FormField label="频道模式" required>
          <input
            :value="row.patterns"
            class="input input-mono"
            placeholder="* 或 group:* !private:*"
            autocomplete="off"
            :disabled="submitting"
            @input="patchChannel(index, { patterns: ($event.target as HTMLInputElement).value })"
          />
        </FormField>
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm wizard-channel-remove"
          :aria-label="`移除账号 ${row.account}`"
          :disabled="submitting"
          @click="removeChannel(index)"
        >
          <Icon name="close" :size="14" />
        </button>
      </div>
      <p v-if="profileErrors.channels !== undefined" class="field-error">{{ profileErrors.channels }}</p>
      <div>
        <button type="button" class="btn btn-soft btn-sm" :disabled="submitting" @click="addChannel"><Icon name="plus" :size="13" /> 添加账号</button>
      </div>
      <p class="field-hint">可以先不认领任何频道，之后再在编辑器里补充。</p>
    </section>

    <!-- 第 4 步：人格与引擎 -->
    <section v-else-if="step.key === 'persona'" class="stack-sm" style="margin-top: 14px">
      <FormField label="人格文本" hint="写入第一个指令文件（默认 PERSONA.md），可以留空稍后填写。">
        <textarea
          :value="draft.persona"
          class="textarea"
          rows="8"
          spellcheck="false"
          :disabled="submitting"
          placeholder="用一段话描述这个 Profile 的性格、语气与行为边界。"
          @input="patchDraft({ persona: ($event.target as HTMLTextAreaElement).value })"
        ></textarea>
      </FormField>
      <div class="form-grid three">
        <FormField
          v-for="(choices, kind) in engineDirectories"
          :key="kind"
          :label="kind === 'context' ? '上下文引擎' : kind === 'wakeup' ? '唤醒引擎' : '工具调用引擎'"
          hint="决定该环节的处理方式。"
        >
          <select
            :value="draft.engines[kind]"
            class="select"
            :disabled="submitting"
            :aria-label="`${kind} 引擎`"
            @change="patchDraft({ engines: { ...draft.engines, [kind]: ($event.target as HTMLSelectElement).value } })"
          >
            <option v-for="option in choices" :key="option.name" :value="option.name">
              {{ option.available ? option.label : `${option.label} · 不可用` }}
            </option>
          </select>
        </FormField>
      </div>
    </section>

    <!-- 第 5 步：确认 -->
    <section v-else class="stack-sm" style="margin-top: 14px">
      <p class="field-hint">核对以下内容，确认后写入配置{{ profile === undefined ? "" : "（保存后需要应用才会生效）" }}。</p>
      <dl class="kv">
        <template v-for="row in confirmSummary()" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd class="wrap">{{ row.value }}</dd>
        </template>
      </dl>
    </section>

    <template #footer>
      <span class="dirty-note">
        <template v-if="touched"><span class="badge badge-warning">未保存</span></template>
        <template v-else>尚未修改</template>
      </span>
      <button type="button" class="btn" :disabled="stepIndex === 0 || submitting" @click="goBack">上一步</button>
      <button
        v-if="!lastStep"
        type="button"
        class="btn btn-primary"
        :disabled="stepIssue.length > 0 || submitting"
        :title="stepIssue.length > 0 ? stepIssue : undefined"
        @click="goNext"
      >
        下一步
      </button>
      <button v-else type="button" class="btn btn-primary" :disabled="submitting" @click="finish">
        <span v-if="submitting" class="spinner" aria-hidden="true"></span>
        {{ submitting ? "写入中…" : profile === undefined ? "创建 Profile" : "保存 Profile" }}
      </button>
    </template>
  </BaseModal>

  <BaseModal :open="confirmCancel" title="放弃向导？" desc="已填写的内容不会保留，也不会写入任何配置。" @close="confirmCancel = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmCancel = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="((confirmCancel = false), emit('close'))">放弃</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.wizard-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 0;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-inset);
  list-style: none;
}

.wizard-steps li {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--faint);
  font-size: 12px;
}

.wizard-steps li.done {
  color: var(--accent-ink);
}

.wizard-steps li.current {
  color: var(--ink);
  font-weight: 600;
}

.wizard-step-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface-raised);
  font-family: var(--mono);
  font-size: 11px;
}

li.done .wizard-step-mark {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-ink);
}

li.current .wizard-step-mark {
  border-color: var(--accent);
  color: var(--accent-ink);
}

.wizard-step-desc {
  display: none;
}

@media (min-width: 720px) {
  .wizard-step-desc {
    display: inline;
    font-weight: 400;
    font-size: 11px;
  }
}

.wizard-channel-row {
  grid-template-columns: minmax(140px, 1fr) minmax(0, 1.6fr) auto;
  align-items: end;
}

.wizard-channel-remove {
  margin-bottom: 3px;
}

@media (max-width: 720px) {
  .wizard-channel-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
