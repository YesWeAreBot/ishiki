<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import BaseModal from "../components/BaseModal.vue";
import FormField from "../components/FormField.vue";
import Icon from "../components/Icon.vue";
import TagInput from "../components/TagInput.vue";
import ToggleSwitch from "../components/ToggleSwitch.vue";
import type { ProfileConfig, ProfileView } from "../data/types";
import { findDeclaredModel, modelOptions } from "../lib/models";
import {
  CONTEXT_ENGINES,
  EXTENSION_CATALOG,
  TOOLCALL_ENGINES,
  WAKEUP_ENGINES,
  cloneProfileConfig,
  createBlankProfileConfig,
  defaultContextConfig,
  defaultJevWakeup,
  defaultOneBotConfig,
  defaultStandardWakeup,
  defaultToolcallConfig,
  defaultV3Wakeup,
  defaultWorkspaceConfig,
  updateEngine,
  validateProfileDraft,
} from "../lib/profile";
import { modelOptionsLanguage, saveProfile, setDirty, store, toast } from "../store";

const props = defineProps<{ profile?: ProfileView }>();
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>();

type Tab = "basic" | "engines" | "runtime" | "extensions";
const activeTab = ref<Tab>("basic");
const attempted = ref(false);
const saving = ref(false);
const confirmCancel = ref(false);
const serverErrors = ref<Record<string, string>>({});
const draftId = ref("");
const persona = ref("");
const config = ref<ProfileConfig>(createBlankProfileConfig(""));
const channelRows = ref<Array<{ uid: number; account: string; patterns: string[] }>>([]);
const baseline = ref("");
let channelUid = 0;

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "basic", label: "基础与频道" },
  { id: "engines", label: "引擎" },
  { id: "runtime", label: "运行策略" },
  { id: "extensions", label: "扩展" },
];

const isNew = computed(() => props.profile === undefined);
const title = computed(() => (isNew.value ? "新建 Profile" : `编辑 ${props.profile?.id}`));
const selectedModel = computed(() => findDeclaredModel(store.providers, config.value.model));
const selectedGroup = computed(() => store.groups.find((group) => group.name === config.value.model));
const groupOptions = computed(() => modelOptionsLanguage.value.filter((option) => option.kind === "group"));
const languageOptions = computed(() =>
  modelOptions(store.providers, store.groups, { languageOnly: true }).filter((option) => option.kind === "model" && !option.disabled),
);
const modelByProvider = computed(() => {
  const map = new Map<string, typeof languageOptions.value>();
  for (const option of languageOptions.value) {
    const key = option.provider ?? "unknown";
    const list = map.get(key) ?? [];
    list.push(option);
    map.set(key, list);
  }
  return [...map.entries()];
});

const context = computed(() => config.value.context.config as Record<string, any>);
const wakeup = computed(() => config.value.wakeup.config as Record<string, any>);
const toolcall = computed(() => config.value.toolcall.config as Record<string, any>);

function extension(name: string) {
  const existing = config.value.extensions[name];
  if (existing !== undefined) return existing;
  const created = { enable: false, config: name === "workspace" ? defaultWorkspaceConfig() : name === "onebot-actions" ? defaultOneBotConfig() : {} };
  config.value.extensions[name] = created;
  return created;
}

function extensionConfig(name: string): Record<string, any> {
  return extension(name).config as Record<string, any>;
}

function initialRows(configValue: ProfileConfig) {
  channelRows.value = Object.entries(configValue.channels).map(([account, patterns]) => ({
    uid: (channelUid += 1),
    account,
    patterns: [...patterns],
  }));
}

function snapshot(): string {
  return JSON.stringify({ id: draftId.value, config: config.value, persona: persona.value, rows: channelRows.value });
}

const dirty = computed(() => baseline.value.length > 0 && snapshot() !== baseline.value);
watch(dirty, (value) => setDirty("profile-editor", value));

const channelDraftError = computed(() => {
  const seen = new Set<string>();
  for (const row of channelRows.value) {
    const account = row.account.trim();
    if (account.length === 0) return "频道账号不能为空；格式为 platform:selfId。";
    if (!account.includes(":")) return `账号「${account}」缺少冒号；格式为 platform:selfId。`;
    if (seen.has(account)) return `账号「${account}」重复。`;
    seen.add(account);
  }
  return undefined;
});

function rebuildChannels(): void {
  const channels: Record<string, string[]> = {};
  for (const row of channelRows.value) {
    const account = row.account.trim();
    if (account.length > 0) channels[account] = row.patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
  }
  config.value.channels = channels;
}

const validation = computed(() =>
  validateProfileDraft({
    id: draftId.value,
    isNew: isNew.value,
    config: config.value,
    profiles: store.profiles,
    providers: store.providers,
    groups: store.groups,
    env: store.env,
  }),
);

const allErrors = computed<Record<string, string>>(() => ({
  ...validation.value.errors,
  ...(channelDraftError.value === undefined ? {} : { "channels.rows": channelDraftError.value }),
  ...serverErrors.value,
}));
const visibleErrors = computed(() => (attempted.value || dirty.value ? allErrors.value : {}));
const warnings = computed(() => validation.value.warnings);

function errorsFor(tab: Tab): number {
  return Object.keys(allErrors.value).filter((key) => tabForError(key) === tab).length;
}

function tabForError(key: string): Tab {
  if (key.startsWith("extensions.")) return "extensions";
  if (key.startsWith("context.") || key.startsWith("wakeup.") || key.startsWith("toolcall.")) return "engines";
  if (
    key.startsWith("failover.") ||
    key.startsWith("codemode.") ||
    key.startsWith("toolsearch.") ||
    key.startsWith("typing.") ||
    key.startsWith("attachment.")
  ) {
    return "runtime";
  }
  return "basic";
}

function addChannel(): void {
  channelUid += 1;
  channelRows.value.push({ uid: channelUid, account: "", patterns: [] });
}

function removeChannel(index: number): void {
  channelRows.value.splice(index, 1);
  rebuildChannels();
}

function setAccount(index: number, value: string): void {
  channelRows.value[index].account = value;
  rebuildChannels();
}

function setPatterns(index: number, patterns: string[]): void {
  channelRows.value[index].patterns = patterns;
  rebuildChannels();
}

function setContextEngine(value: string): void {
  updateEngine(config.value, "context", value);
  if (value === "narrative" && config.value.toolcall.engine !== "narrative") {
    updateEngine(config.value, "toolcall", "narrative");
  }
}

function setWakeupEngine(value: string): void {
  updateEngine(config.value, "wakeup", value);
}

function setToolcallEngine(value: string): void {
  updateEngine(config.value, "toolcall", value);
  if (value === "narrative" && config.value.context.engine !== "narrative") {
    updateEngine(config.value, "context", "narrative");
  }
}

function resetContext(): void {
  config.value.context.config = defaultContextConfig(config.value.context.engine);
}

function resetWakeup(): void {
  const engine = config.value.wakeup.engine;
  config.value.wakeup.config = engine === "jev" ? defaultJevWakeup() : engine === "v3" ? defaultV3Wakeup() : defaultStandardWakeup();
}

function resetToolcall(): void {
  config.value.toolcall.config = defaultToolcallConfig(config.value.toolcall.engine);
}

function selectedGroupImageCount(): { total: number; withImage: number } {
  const group = selectedGroup.value;
  if (group === undefined) return { total: 0, withImage: 0 };
  let withImage = 0;
  for (const member of group.models) {
    const found = findDeclaredModel(store.providers, member);
    if (found?.model.input?.includes("image")) withImage += 1;
  }
  return { total: group.models.length, withImage };
}

function modelStateLabel(): string {
  if (selectedGroup.value !== undefined) return `模型组 · ${selectedGroup.value.models.length} 个候选 · ${selectedGroup.value.strategy}`;
  if (selectedModel.value !== undefined) {
    const model = selectedModel.value.model;
    return `${model.type} · ${model.contextWindow === undefined ? "上下文未声明" : `${model.contextWindow} tokens`}`;
  }
  return "引用未解析";
}

function submit(): void {
  attempted.value = true;
  rebuildChannels();
  const errors = allErrors.value;
  if (Object.keys(errors).length > 0) {
    const first = Object.keys(errors)[0];
    activeTab.value = tabForError(first);
    toast("error", "配置未通过校验", errors[first]);
    nextTick(() => document.querySelector<HTMLElement>(".profile-form [aria-invalid='true']")?.focus());
    return;
  }
  saving.value = true;
  saveProfile({ id: draftId.value, isNew: isNew.value, config: config.value, persona: persona.value })
    .then((result) => {
      saving.value = false;
      if (!result.ok) {
        serverErrors.value = result.errors;
        if (result.error !== undefined) toast("error", "Profile 保存失败", result.error);
        return;
      }
      setDirty("profile-editor", false);
      baseline.value = snapshot();
      toast(
        "success",
        isNew.value ? "Profile 已创建" : "Profile 配置已保存",
        isNew.value ? "新 Profile 处于停止状态，点击激活后生效。" : "运行状态不受影响；配置在重新激活后应用。",
      );
      emit("saved", draftId.value);
    })
    .catch((error: unknown) => {
      saving.value = false;
      toast("error", "Profile 保存失败", error instanceof Error ? error.message : String(error));
    });
}

function requestCancel(): void {
  if (dirty.value) confirmCancel.value = true;
  else emit("cancel");
}

function discardAndCancel(): void {
  confirmCancel.value = false;
  setDirty("profile-editor", false);
  emit("cancel");
}

watch(
  () => [draftId.value, config.value, persona.value, channelRows.value],
  () => {
    if (baseline.value.length > 0) serverErrors.value = {};
  },
  { deep: true },
);

onMounted(() => {
  if (props.profile !== undefined) {
    draftId.value = props.profile.id;
    config.value = cloneProfileConfig(props.profile.config);
    persona.value = props.profile.persona;
  } else {
    const preferred = store.groups.find((group) => group.name === "chat")?.name ?? modelOptionsLanguage.value[0]?.reference ?? "";
    draftId.value = "";
    config.value = createBlankProfileConfig(preferred);
    persona.value = "";
  }
  initialRows(config.value);
  nextTick(() => {
    baseline.value = snapshot();
    setDirty("profile-editor", false);
  });
});

onBeforeUnmount(() => setDirty("profile-editor", false));
</script>

<template>
  <div class="panel profile-form">
    <div class="panel-head">
      <div>
        <div class="panel-title">{{ title }}</div>
        <div class="panel-sub">
          {{ isNew ? "保存后处于停止状态；激活时才会解析引擎与模型依赖。" : "保存写入配置；运行中的 Profile 继续使用 appliedAt 对应的版本。" }}
        </div>
      </div>
      <div class="panel-actions">
        <span v-if="dirty" class="badge badge-warning">未保存</span>
        <button type="button" class="btn" @click="requestCancel">取消</button>
      </div>
    </div>

    <div style="padding: 0 18px">
      <div class="tabs" role="tablist" aria-label="Profile 编辑分区">
        <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" class="tab" :aria-selected="activeTab === tab.id" @click="activeTab = tab.id">
          {{ tab.label }}
          <span v-if="errorsFor(tab.id) > 0" class="badge badge-danger" style="margin-left: 6px">{{ errorsFor(tab.id) }}</span>
        </button>
      </div>
    </div>

    <div class="panel-body">
      <div v-if="props.profile?.status === 'active'" class="notice notice-info" style="margin-bottom: 16px">
        <Icon name="info" :size="15" />
        <span>该 Profile 正在运行。保存不会替换运行中的实例；使用详情页的「重新激活」才会读取新配置。</span>
      </div>

      <template v-if="activeTab === 'basic'">
        <div class="form-grid">
          <FormField
            label="Profile 目录名"
            required
            :error="visibleErrors.id"
            :hint="isNew ? '对应 profiles/<目录名>/profile.yml。创建后不可更改。' : '目录名是该 Profile 的稳定标识。'"
          >
            <input v-model="draftId" class="input input-mono" :disabled="!isNew" :aria-invalid="visibleErrors.id !== undefined" placeholder="neko" />
          </FormField>

          <FormField label="模型或模型组" required :error="visibleErrors.model" hint="引用 provider:model[:level] 或组名；模型选择器随模型配置实时更新。">
            <select v-model="config.model" class="select" :aria-invalid="visibleErrors.model !== undefined">
              <option value="">选择模型…</option>
              <optgroup label="模型组">
                <option v-for="option in groupOptions" :key="option.reference" :value="option.reference">{{ option.reference }}</option>
              </optgroup>
              <optgroup v-for="[providerId, options] in modelByProvider" :key="providerId" :label="providerId">
                <option v-for="option in options" :key="option.reference" :value="option.reference">{{ option.label }}</option>
              </optgroup>
            </select>
          </FormField>

          <div class="span-2 session-meta-strip" style="margin: 0">
            <span
              >当前引用 <strong>{{ config.model || "未选择" }}</strong></span
            >
            <span>{{ modelStateLabel() }}</span>
            <span v-if="selectedModel?.model.input !== undefined"
              >模态 <strong>{{ selectedModel.model.input.join(" / ") }}</strong></span
            >
            <span v-if="selectedGroup !== undefined" class="sync-note"
              ><Icon name="check" :size="12" /> 组内 {{ selectedGroupImageCount().withImage }}/{{ selectedGroupImageCount().total }} 个候选支持图片</span
            >
          </div>

          <FormField label="实例模式" required hint="channel：每个认领频道一个 runtime；cross：整个 Profile 共用一个 runtime。">
            <select v-model="config.mode" class="select">
              <option value="channel">channel · 按频道隔离</option>
              <option value="cross">cross · 跨频道共享</option>
            </select>
          </FormField>

          <FormField label="人格 persona.md" class="span-2" hint="保存后写入 profile 目录；激活时注入系统提示词。">
            <textarea v-model="persona" class="textarea" rows="4" placeholder="你是 neko。说话简短，先接住对方的意思，再给判断。"></textarea>
          </FormField>
        </div>

        <section class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">频道认领</div>
              <div class="form-section-desc">账号格式 platform:selfId；每个账号至少一个正项，! 开头表示排除，尾随 * 按前缀匹配。</div>
            </div>
            <button type="button" class="btn btn-sm" style="margin-left: auto" @click="addChannel"><Icon name="plus" :size="13" /> 添加账号</button>
          </div>
          <div v-if="visibleErrors['channels.rows']" class="field-error" style="margin-bottom: 8px">{{ visibleErrors["channels.rows"] }}</div>
          <div v-else-if="visibleErrors.channels" class="field-error" style="margin-bottom: 8px">{{ visibleErrors.channels }}</div>

          <div v-if="channelRows.length === 0" class="notice">
            <Icon name="info" :size="15" />
            <span>还没有认领账号。Profile 加载时 channels 为空会直接失败。</span>
          </div>
          <div v-else class="stack-sm">
            <div v-for="(row, index) in channelRows" :key="row.uid" class="panel" style="box-shadow: none">
              <div class="panel-body" style="padding: 12px">
                <div class="row channel-row" style="align-items: flex-start">
                  <div class="field channel-account" style="width: 240px">
                    <span class="field-label">账号</span>
                    <input
                      :value="row.account"
                      class="input input-mono"
                      placeholder="onebot:2847113223"
                      :aria-label="`账号 ${index + 1}`"
                      :aria-invalid="visibleErrors[`channels.${row.account}`] !== undefined"
                      @input="setAccount(index, ($event.target as HTMLInputElement).value)"
                    />
                    <span v-if="visibleErrors[`channels.${row.account}`]" class="field-error">{{ visibleErrors[`channels.${row.account}`] }}</span>
                  </div>
                  <div class="field flex-1">
                    <span class="field-label">频道名单</span>
                    <TagInput
                      :model-value="row.patterns"
                      placeholder="输入 group:* 后按 Enter，可继续添加 !group:987654321"
                      aria-label="频道名单"
                      @update:model-value="setPatterns(index, $event)"
                    />
                  </div>
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="移除账号" style="margin-top: 24px" @click="removeChannel(index)">
                    <Icon name="trash" :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </template>

      <template v-else-if="activeTab === 'engines'">
        <div class="notice" style="margin-bottom: 16px">
          <Icon name="info" :size="15" />
          <span>引擎变体由已注册的 Koishi Service 决定。演示环境已注册 standard、v3、narrative，以及全部 toolcall 协议。</span>
        </div>

        <section class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">上下文引擎</div>
              <div class="form-section-desc">{{ CONTEXT_ENGINES.find((entry) => entry.name === config.context.engine)?.description }}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" style="margin-left: auto" @click="resetContext">恢复该引擎默认值</button>
          </div>
          <div class="form-grid">
            <FormField label="engine" required :error="visibleErrors['context.engine']">
              <select :value="config.context.engine" class="select" @change="setContextEngine(($event.target as HTMLSelectElement).value)">
                <option v-for="engine in CONTEXT_ENGINES" :key="engine.name" :value="engine.name">{{ engine.label }} · {{ engine.packageName }}</option>
              </select>
            </FormField>

            <template v-if="config.context.engine === 'standard'">
              <FormField label="maxTokens" :error="visibleErrors['context.maxTokens']" hint="单轮模型输入的 token 上限；0 关闭压缩。">
                <input
                  v-model.number="context.maxTokens"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['context.maxTokens'] !== undefined"
                />
              </FormField>
              <FormField label="refillRatio" :error="visibleErrors['context.refillRatio']" hint="压缩后目标比例，范围 (0, 1]。">
                <input
                  v-model.number="context.refillRatio"
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.05"
                  class="input"
                  :aria-invalid="visibleErrors['context.refillRatio'] !== undefined"
                />
              </FormField>
            </template>

            <template v-else-if="config.context.engine === 'v3'">
              <FormField label="maxMessages" :error="visibleErrors['context.maxMessages']" hint="保留的近期消息数。">
                <input
                  v-model.number="context.maxMessages"
                  type="number"
                  min="1"
                  class="input"
                  :aria-invalid="visibleErrors['context.maxMessages'] !== undefined"
                />
              </FormField>
              <FormField label="keepFullTurnCount" :error="visibleErrors['context.keepFullTurnCount']" hint="完整保留的轮次数。">
                <input
                  v-model.number="context.keepFullTurnCount"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['context.keepFullTurnCount'] !== undefined"
                />
              </FormField>
              <div class="field span-2">
                <span class="field-label">记忆块</span>
                <ToggleSwitch :checked="Boolean(context.memoryBlocks)" label="读取 profile/memory/*.md" @update:checked="context.memoryBlocks = $event" />
              </div>
            </template>

            <template v-else-if="config.context.engine === 'narrative'">
              <FormField label="maxTokens" :error="visibleErrors['context.maxTokens']" hint="剧本正文预算；0 关闭自动压缩。">
                <input
                  v-model.number="context.maxTokens"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['context.maxTokens'] !== undefined"
                />
              </FormField>
              <FormField label="refillRatio" :error="visibleErrors['context.refillRatio']" hint="压缩后目标比例。">
                <input
                  v-model.number="context.refillRatio"
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.05"
                  class="input"
                  :aria-invalid="visibleErrors['context.refillRatio'] !== undefined"
                />
              </FormField>
              <FormField label="recentEntries" :error="visibleErrors['context.recentEntries']" hint="保留的近期原始证据条数。">
                <input
                  v-model.number="context.recentEntries"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['context.recentEntries'] !== undefined"
                />
              </FormField>
            </template>
          </div>
        </section>

        <section class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">唤醒引擎</div>
              <div class="form-section-desc">{{ WAKEUP_ENGINES.find((entry) => entry.name === config.wakeup.engine)?.description }}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" style="margin-left: auto" @click="resetWakeup">恢复该引擎默认值</button>
          </div>
          <div class="form-grid">
            <FormField label="engine" required>
              <select :value="config.wakeup.engine" class="select" @change="setWakeupEngine(($event.target as HTMLSelectElement).value)">
                <option v-for="engine in WAKEUP_ENGINES" :key="engine.name" :value="engine.name">{{ engine.label }} · {{ engine.packageName }}</option>
              </select>
            </FormField>

            <template v-if="config.wakeup.engine === 'standard'">
              <div class="field span-2">
                <span class="field-label">触发规则</span>
                <div class="row row-wrap">
                  <ToggleSwitch :checked="Boolean(wakeup.direct)" label="私聊必醒 direct" @update:checked="wakeup.direct = $event" />
                  <ToggleSwitch :checked="Boolean(wakeup.atSelf)" label="被 @ 必醒 atSelf" @update:checked="wakeup.atSelf = $event" />
                  <ToggleSwitch :checked="Boolean(wakeup.quoteSelf)" label="被引用必醒 quoteSelf" @update:checked="wakeup.quoteSelf = $event" />
                </div>
              </div>
              <FormField label="关键词" class="span-2" hint="消息包含任一关键词时唤醒；不区分来源。">
                <TagInput v-model="wakeup.keywords" placeholder="输入关键词后按 Enter" aria-label="唤醒关键词" />
              </FormField>
            </template>

            <template v-else-if="config.wakeup.engine === 'jev'">
              <FormField label="API Key" :warning="warnings['wakeup.apiKey']" hint="留空时读取 TYPESAFE_API_KEY；两者都没有会让激活失败。">
                <input v-model="wakeup.apiKey" class="input input-mono" type="password" placeholder="或留空使用环境变量" />
              </FormField>
              <FormField label="模型" hint="默认 jev-latest。">
                <input v-model="wakeup.model" class="input input-mono" />
              </FormField>
              <FormField label="Endpoint" class="span-2">
                <input v-model="wakeup.endpoint" class="input input-mono" />
              </FormField>
              <FormField label="threshold" :error="visibleErrors['wakeup.threshold']" hint="0 到 1；三维合成后的开口阈值。">
                <input
                  v-model.number="wakeup.threshold"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  class="input"
                  :aria-invalid="visibleErrors['wakeup.threshold'] !== undefined"
                />
              </FormField>
              <FormField label="冷却时间 cooldownMs" :error="visibleErrors['wakeup.cooldownMs']" hint="毫秒；硬命中规则不受冷却约束。">
                <input
                  v-model.number="wakeup.cooldownMs"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['wakeup.cooldownMs'] !== undefined"
                />
              </FormField>
              <FormField label="超时 timeoutMs" :error="visibleErrors['wakeup.timeoutMs']" hint="毫秒；超时按不唤醒处理。">
                <input
                  v-model.number="wakeup.timeoutMs"
                  type="number"
                  min="100"
                  class="input"
                  :aria-invalid="visibleErrors['wakeup.timeoutMs'] !== undefined"
                />
              </FormField>
              <FormField label="历史条数 historyMessages" :error="visibleErrors['wakeup.historyMessages']" hint="1 到 50。">
                <input
                  v-model.number="wakeup.historyMessages"
                  type="number"
                  min="1"
                  max="50"
                  class="input"
                  :aria-invalid="visibleErrors['wakeup.historyMessages'] !== undefined"
                />
              </FormField>
              <FormField label="补充判据 instruction" class="span-2" hint="语气、何时该闭嘴等；不写身份与兴趣。">
                <textarea v-model="wakeup.instruction" class="textarea" rows="3"></textarea>
              </FormField>
              <FormField label="兴趣 interests" class="span-2" hint="只影响 interested 维度；留空表示不偏袒任何话题。">
                <TagInput v-model="wakeup.interests" placeholder="输入兴趣后按 Enter" aria-label="唤醒兴趣" />
              </FormField>
              <div class="field span-2">
                <span class="field-label">兜底规则 rules</span>
                <div class="row row-wrap">
                  <ToggleSwitch :checked="Boolean(wakeup.rules?.direct)" label="私聊" @update:checked="wakeup.rules.direct = $event" />
                  <ToggleSwitch :checked="Boolean(wakeup.rules?.atSelf)" label="被 @" @update:checked="wakeup.rules.atSelf = $event" />
                  <ToggleSwitch :checked="Boolean(wakeup.rules?.quoteSelf)" label="被引用" @update:checked="wakeup.rules.quoteSelf = $event" />
                </div>
              </div>
            </template>

            <template v-else-if="config.wakeup.engine === 'v3'">
              <FormField label="base" :error="visibleErrors['wakeup.base']"
                ><input v-model.number="wakeup.base" type="number" min="0" class="input"
              /></FormField>
              <FormField label="atMention" :error="visibleErrors['wakeup.atMention']"
                ><input v-model.number="wakeup.atMention" type="number" min="0" class="input"
              /></FormField>
              <FormField label="isQuote" :error="visibleErrors['wakeup.isQuote']"
                ><input v-model.number="wakeup.isQuote" type="number" min="0" class="input"
              /></FormField>
              <FormField label="isDirectMessage" :error="visibleErrors['wakeup.isDirectMessage']"
                ><input v-model.number="wakeup.isDirectMessage" type="number" min="0" class="input"
              /></FormField>
              <FormField label="keywordMultiplier" hint="关键词命中倍率。"
                ><input v-model.number="wakeup.keywordMultiplier" type="number" step="0.1" class="input"
              /></FormField>
              <FormField label="defaultMultiplier" hint="普通消息倍率。"
                ><input v-model.number="wakeup.defaultMultiplier" type="number" step="0.1" class="input"
              /></FormField>
              <FormField label="maxWillingness"><input v-model.number="wakeup.maxWillingness" type="number" min="0" class="input" /></FormField>
              <FormField label="decayHalfLifeSeconds" hint="意愿衰减半衰期（秒）。"
                ><input v-model.number="wakeup.decayHalfLifeSeconds" type="number" min="0" class="input"
              /></FormField>
              <FormField label="probabilityThreshold" :error="visibleErrors['wakeup.probabilityThreshold']" hint="0 到 100。"
                ><input v-model.number="wakeup.probabilityThreshold" type="number" min="0" max="100" class="input"
              /></FormField>
              <FormField label="probabilityAmplifier"><input v-model.number="wakeup.probabilityAmplifier" type="number" step="0.01" class="input" /></FormField>
              <FormField label="replyCost" hint="每次开口消耗的意愿值。"
                ><input v-model.number="wakeup.replyCost" type="number" min="0" class="input"
              /></FormField>
              <FormField label="keywords" class="span-2" hint="命中后按 keywordMultiplier 放大意愿。">
                <TagInput v-model="wakeup.keywords" placeholder="输入关键词后按 Enter" aria-label="v3 唤醒关键词" />
              </FormField>
            </template>
          </div>
        </section>

        <section class="form-section">
          <div class="form-section-head">
            <div>
              <div class="form-section-title">工具调用引擎</div>
              <div class="form-section-desc">{{ TOOLCALL_ENGINES.find((entry) => entry.name === config.toolcall.engine)?.description }}</div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" style="margin-left: auto" @click="resetToolcall">恢复默认值</button>
          </div>
          <div class="form-grid">
            <FormField label="engine" required :error="visibleErrors['toolcall.engine']">
              <select :value="config.toolcall.engine" class="select" @change="setToolcallEngine(($event.target as HTMLSelectElement).value)">
                <option v-for="engine in TOOLCALL_ENGINES" :key="engine.name" :value="engine.name">{{ engine.label }} · {{ engine.packageName }}</option>
              </select>
            </FormField>
            <div v-if="visibleErrors['context.engine']" class="field-error">{{ visibleErrors["context.engine"] }}</div>

            <template v-if="config.toolcall.engine === 'narrative'">
              <FormField label="decoderModel" :error="visibleErrors['toolcall.decoderModel']" hint="行动解码模型；留空复用 Profile 主模型。">
                <select v-model="toolcall.decoderModel" class="select">
                  <option value="">复用主模型</option>
                  <option v-for="option in groupOptions" :key="option.reference" :value="option.reference">{{ option.reference }}</option>
                  <option v-for="option in languageOptions" :key="option.reference" :value="option.reference">{{ option.reference }}</option>
                </select>
              </FormField>
              <FormField label="replyModel" :error="visibleErrors['toolcall.replyModel']" hint="最终回复模型；留空复用主模型。">
                <select v-model="toolcall.replyModel" class="select">
                  <option value="">复用主模型</option>
                  <option v-for="option in groupOptions" :key="option.reference" :value="option.reference">{{ option.reference }}</option>
                  <option v-for="option in languageOptions" :key="option.reference" :value="option.reference">{{ option.reference }}</option>
                </select>
              </FormField>
              <FormField label="narratorInstructions" class="span-2" hint="追加作者续写指令。">
                <textarea v-model="toolcall.narratorInstructions" class="textarea" rows="2"></textarea>
              </FormField>
              <FormField label="decoderInstructions" class="span-2" hint="追加行动解码指令。">
                <textarea v-model="toolcall.decoderInstructions" class="textarea" rows="2"></textarea>
              </FormField>
              <FormField label="replyerInstructions" class="span-2" hint="追加可见表达指令。">
                <textarea v-model="toolcall.replyerInstructions" class="textarea" rows="2"></textarea>
              </FormField>
            </template>
            <div v-else class="notice span-2">
              <Icon name="info" :size="15" />
              <span>{{ config.toolcall.engine }} 协议没有 profile 级配置段。工具面仍由 codemode 与 toolsearch 控制。</span>
            </div>
          </div>
        </section>
      </template>

      <template v-else-if="activeTab === 'runtime'">
        <details class="collapse" open>
          <summary>
            失败转移 failover <span class="summary-meta">{{ config.failover.attempts }} 次尝试</span>
          </summary>
          <div class="collapse-body">
            <div class="form-grid three">
              <FormField label="attempts" :error="visibleErrors['failover.attempts']" hint="最大尝试次数。">
                <input
                  v-model.number="config.failover.attempts"
                  type="number"
                  min="1"
                  class="input"
                  :aria-invalid="visibleErrors['failover.attempts'] !== undefined"
                />
              </FormField>
              <FormField label="backoffMs" :error="visibleErrors['failover.backoffMs']" hint="逐次翻倍，封顶 8 秒。">
                <input
                  v-model.number="config.failover.backoffMs"
                  type="number"
                  min="0"
                  class="input"
                  :aria-invalid="visibleErrors['failover.backoffMs'] !== undefined"
                />
              </FormField>
              <FormField label="failoverOn" hint="unavailable 只换服务类错误；any 连参数错误也换。">
                <select v-model="config.failover.failoverOn" class="select">
                  <option value="unavailable">unavailable</option>
                  <option value="any">any</option>
                </select>
              </FormField>
            </div>
          </div>
        </details>

        <details class="collapse" :open="config.codemode.enable" style="margin-top: 10px">
          <summary>
            代码模式 codemode
            <span class="summary-meta">{{ config.codemode.enable ? "已启用" : "已关闭" }}</span>
          </summary>
          <div class="collapse-body">
            <div class="row" style="margin-bottom: 12px">
              <ToggleSwitch :checked="config.codemode.enable" label="启用 codemode" @update:checked="config.codemode.enable = $event" />
            </div>
            <div v-if="config.codemode.enable" class="form-grid">
              <FormField label="direct" class="span-2" hint="保持模型直调的工具名；未列出的工具收进沙箱。">
                <TagInput v-model="config.codemode.direct" placeholder="输入工具名后按 Enter" aria-label="codemode 直调工具" />
              </FormField>
              <FormField label="timeoutMs" :error="visibleErrors['codemode.timeoutMs']"
                ><input v-model.number="config.codemode.timeoutMs" type="number" min="1" class="input"
              /></FormField>
              <FormField label="memoryLimitBytes" :error="visibleErrors['codemode.memoryLimitBytes']"
                ><input v-model.number="config.codemode.memoryLimitBytes" type="number" min="1" class="input"
              /></FormField>
              <FormField label="maxToolInputBytes" :error="visibleErrors['codemode.maxToolInputBytes']"
                ><input v-model.number="config.codemode.maxToolInputBytes" type="number" min="1" class="input"
              /></FormField>
              <FormField label="maxToolOutputBytes" :error="visibleErrors['codemode.maxToolOutputBytes']"
                ><input v-model.number="config.codemode.maxToolOutputBytes" type="number" min="1" class="input"
              /></FormField>
              <FormField label="maxResultBytes" :error="visibleErrors['codemode.maxResultBytes']"
                ><input v-model.number="config.codemode.maxResultBytes" type="number" min="1" class="input"
              /></FormField>
            </div>
          </div>
        </details>

        <details class="collapse" :open="config.toolsearch.enable" style="margin-top: 10px">
          <summary>
            工具检索 toolsearch
            <span class="summary-meta">{{ config.toolsearch.enable ? "已启用" : "已关闭" }}</span>
          </summary>
          <div class="collapse-body">
            <div class="row" style="margin-bottom: 12px">
              <ToggleSwitch :checked="config.toolsearch.enable" label="启用 toolsearch" @update:checked="config.toolsearch.enable = $event" />
            </div>
            <div v-if="config.toolsearch.enable" class="form-grid">
              <FormField label="resident" class="span-2" hint="额外常驻工具名；其余进入延迟池。">
                <TagInput v-model="config.toolsearch.resident" placeholder="输入工具名后按 Enter" aria-label="常驻工具" />
              </FormField>
              <FormField label="maxResults" :error="visibleErrors['toolsearch.maxResults']"
                ><input v-model.number="config.toolsearch.maxResults" type="number" min="1" class="input"
              /></FormField>
              <FormField label="catalogMode" hint="incremental 只发增量；replace 每次发完整快照。">
                <select v-model="config.toolsearch.catalogMode" class="select">
                  <option value="incremental">incremental</option>
                  <option value="replace">replace</option>
                </select>
              </FormField>
              <FormField label="fullSnapshotEvery" :error="visibleErrors['toolsearch.fullSnapshotEvery']" hint="0 表示不按次数补快照。"
                ><input v-model.number="config.toolsearch.fullSnapshotEvery" type="number" min="0" class="input"
              /></FormField>
              <div class="field">
                <span class="field-label">knownIndex</span>
                <ToggleSwitch :checked="config.toolsearch.knownIndex" label="增量末尾附带工具名列表" @update:checked="config.toolsearch.knownIndex = $event" />
              </div>
            </div>
          </div>
        </details>

        <details class="collapse" open style="margin-top: 10px">
          <summary>打字模拟 typing</summary>
          <div class="collapse-body">
            <div class="form-grid">
              <FormField label="baseDelay" :error="visibleErrors['typing.baseDelay']"
                ><input v-model.number="config.typing.baseDelay" type="number" min="0" class="input"
              /></FormField>
              <FormField label="charPerSecond" :error="visibleErrors['typing.charPerSecond']"
                ><input v-model.number="config.typing.charPerSecond" type="number" min="0" class="input"
              /></FormField>
              <FormField label="minDelay" :error="visibleErrors['typing.minDelay']"
                ><input v-model.number="config.typing.minDelay" type="number" min="0" class="input"
              /></FormField>
              <FormField label="maxDelay" :error="visibleErrors['typing.maxDelay']"
                ><input v-model.number="config.typing.maxDelay" type="number" min="0" class="input"
              /></FormField>
            </div>
          </div>
        </details>

        <details class="collapse" open style="margin-top: 10px">
          <summary>
            附件策略 attachment <span class="summary-meta">{{ config.attachment.imageInput ? "图片输入开启" : "纯文本" }}</span>
          </summary>
          <div class="collapse-body">
            <div class="row" style="margin-bottom: 12px">
              <ToggleSwitch :checked="config.attachment.imageInput" label="允许图片输入 imageInput" @update:checked="config.attachment.imageInput = $event" />
            </div>
            <div v-if="visibleErrors['attachment.imageInput']" class="field-error" style="margin-bottom: 8px">{{ visibleErrors["attachment.imageInput"] }}</div>
            <div v-if="warnings['attachment.imageInput']" class="field-warning" style="margin-bottom: 8px">{{ warnings["attachment.imageInput"] }}</div>
            <div class="form-grid">
              <FormField label="recentImageCount" hint="recent 图片目标保留数。"
                ><input v-model.number="config.attachment.recentImageCount" type="number" min="1" class="input"
              /></FormField>
              <FormField label="imagePruneBatchSize" hint="每次移除的最旧已查看图片数。"
                ><input v-model.number="config.attachment.imagePruneBatchSize" type="number" min="1" class="input"
              /></FormField>
              <FormField label="maxImageBytes" hint="单图字节上限。"
                ><input v-model.number="config.attachment.maxImageBytes" type="number" min="0" class="input"
              /></FormField>
              <FormField label="maxTotalImageBytes" hint="单次请求图片累计上限。"
                ><input v-model.number="config.attachment.maxTotalImageBytes" type="number" min="0" class="input"
              /></FormField>
              <FormField label="maxImageCount" hint="单次请求图片张数上限。"
                ><input v-model.number="config.attachment.maxImageCount" type="number" min="0" class="input"
              /></FormField>
              <FormField label="maxImageDimension" hint="已知尺寸的单边像素上限。"
                ><input v-model.number="config.attachment.maxImageDimension" type="number" min="1" class="input"
              /></FormField>
            </div>
          </div>
        </details>
      </template>

      <template v-else>
        <div class="notice" style="margin-bottom: 16px">
          <Icon name="info" :size="15" />
          <span>扩展由已安装的插件 Service 提供。开启即成为必需依赖；缺少 Service 时 Profile 会停在等待态。</span>
        </div>
        <div class="stack">
          <details v-for="entry in EXTENSION_CATALOG" :key="entry.name" class="collapse" :open="extension(entry.name).enable">
            <summary>
              {{ entry.label }}
              <span class="badge badge-outline" style="margin-left: 6px">{{ entry.packageName }}</span>
              <span class="summary-meta">{{ extension(entry.name).enable ? "已启用" : "未启用" }}</span>
            </summary>
            <div class="collapse-body">
              <div class="row" style="margin-bottom: 12px">
                <ToggleSwitch :checked="extension(entry.name).enable" label="在 Profile 中启用" @update:checked="extension(entry.name).enable = $event" />
              </div>
              <div class="field-hint" style="margin-bottom: 12px">{{ entry.description }}</div>

              <template v-if="entry.name === 'workspace' && extension(entry.name).enable">
                <div class="form-grid">
                  <FormField label="backend" hint="sandbox 使用隔离环境；native 直接运行宿主机 shell。">
                    <select v-model="extensionConfig('workspace').backend" class="select">
                      <option value="sandbox">sandbox</option>
                      <option value="native">native</option>
                    </select>
                  </FormField>
                  <FormField label="shell" hint="native 模式的 shell 路径；留空自动选择。">
                    <input v-model="extensionConfig('workspace').shell" class="input input-mono" />
                  </FormField>
                  <FormField label="cwd" hint="sandbox 初始工作目录。">
                    <input v-model="extensionConfig('workspace').cwd" class="input input-mono" />
                  </FormField>
                  <FormField label="timeoutMs"><input v-model.number="extensionConfig('workspace').timeoutMs" type="number" min="1" class="input" /></FormField>
                  <FormField label="maxExecutionOutputBytes"
                    ><input v-model.number="extensionConfig('workspace').maxExecutionOutputBytes" type="number" min="1" class="input"
                  /></FormField>
                  <div class="field">
                    <span class="field-label">沙箱选项</span>
                    <div class="row row-wrap">
                      <ToggleSwitch
                        :checked="extensionConfig('workspace').network"
                        label="network"
                        @update:checked="extensionConfig('workspace').network = $event"
                      />
                      <ToggleSwitch
                        :checked="extensionConfig('workspace').javascript"
                        label="javascript"
                        @update:checked="extensionConfig('workspace').javascript = $event"
                      />
                      <ToggleSwitch
                        :checked="extensionConfig('workspace').python"
                        label="python"
                        @update:checked="extensionConfig('workspace').python = $event"
                      />
                    </div>
                  </div>
                  <FormField label="skills" class="span-2" hint="额外技能目录，相对 profile 目录解析。">
                    <TagInput v-model="extensionConfig('workspace').skills" placeholder="输入目录后按 Enter" aria-label="技能目录" />
                  </FormField>
                  <FormField label="mounts" class="span-2" hint="source:target[:ro]，source 相对 profile 目录。">
                    <TagInput v-model="extensionConfig('workspace').mounts" placeholder="输入挂载后按 Enter" aria-label="挂载目录" />
                  </FormField>
                </div>
              </template>

              <template v-else-if="entry.name === 'onebot-actions' && extension(entry.name).enable">
                <div class="form-grid">
                  <FormField label="backend" required :error="visibleErrors['extensions.onebot-actions.backend']" hint="协议后端决定动作目录。">
                    <select
                      v-model="extensionConfig('onebot-actions').backend"
                      class="select"
                      :aria-invalid="visibleErrors['extensions.onebot-actions.backend'] !== undefined"
                    >
                      <option value="napcat">napcat</option>
                      <option value="snowluma">snowluma</option>
                    </select>
                  </FormField>
                  <FormField label="mode" hint="docs 只读目录；read 执行只读动作；write 放开写操作。">
                    <select v-model="extensionConfig('onebot-actions').mode" class="select">
                      <option value="docs">docs</option>
                      <option value="read">read</option>
                      <option value="write">write</option>
                    </select>
                  </FormField>
                  <FormField label="maxInlineBytes"
                    ><input v-model.number="extensionConfig('onebot-actions').maxInlineBytes" type="number" min="1" class="input"
                  /></FormField>
                  <FormField label="resourceBaseUrl" hint="协议端访问 Koishi HTTP 服务的 origin；留空使用 selfUrl。">
                    <input v-model="extensionConfig('onebot-actions').resourceBaseUrl" class="input input-mono" />
                  </FormField>
                  <FormField label="denyActions" class="span-2" hint="额外禁用的动作名；内置危险动作始终禁用。">
                    <TagInput v-model="extensionConfig('onebot-actions').denyActions" placeholder="输入动作名后按 Enter" aria-label="禁用动作" />
                  </FormField>
                  <FormField label="logLevel">
                    <select v-model.number="extensionConfig('onebot-actions').logLevel" class="select">
                      <option :value="0">0 · trace</option>
                      <option :value="1">1 · debug</option>
                      <option :value="2">2 · info</option>
                      <option :value="3">3 · warn</option>
                    </select>
                  </FormField>
                </div>
              </template>

              <div v-else-if="entry.name === 'mcp-client' && extension(entry.name).enable" class="notice">
                <Icon name="info" :size="15" />
                <span>mcp-client 没有实例配置。连接参数来自插件配置与 profile 目录下的 mcp.json。</span>
              </div>
            </div>
          </details>
        </div>
      </template>
    </div>

    <div class="panel-foot editor-bar">
      <div class="row" style="gap: 8px">
        <span v-if="dirty" class="badge badge-warning">未保存</span>
        <span class="field-hint">{{ isNew ? "保存后停在停止状态，激活时读取配置。" : "保存配置不会自动重启运行实例。" }}</span>
      </div>
      <div class="row" style="gap: 8px; margin-left: auto">
        <button type="button" class="btn" @click="requestCancel">取消</button>
        <button type="button" class="btn btn-primary" :disabled="saving" @click="submit">
          <span v-if="saving" class="spinner" aria-hidden="true"></span>
          {{ saving ? "保存中…" : "保存 Profile" }}
        </button>
      </div>
    </div>
  </div>

  <BaseModal :open="confirmCancel" title="放弃未保存的修改？" desc="当前 Profile 表单内容会丢失。" @close="confirmCancel = false">
    <template #footer>
      <button type="button" class="btn" @click="confirmCancel = false">继续编辑</button>
      <button type="button" class="btn btn-danger" @click="discardAndCancel">放弃修改</button>
    </template>
  </BaseModal>
</template>
