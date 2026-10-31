<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { ApiError, call } from "../api";
import { formatRawIssues, inspectProfileConfig, parseRaw, serializeRaw } from "../lib/rawConfig";
import { schemaDefaults, type SchemaNode } from "../lib/schema";
import { store, toast } from "../store";
import type { EngineDescriptor, ExtensionDescriptor, ProfileView } from "../types";
import BaseModal from "./BaseModal.vue";
import FormField from "./FormField.vue";
import Icon from "./Icon.vue";
import RawEditor from "./RawEditor.vue";
import SchemaForm from "./SchemaForm.vue";
import ToggleSwitch from "./ToggleSwitch.vue";

type JsonRecord = Record<string, unknown>;

const props = defineProps<{ profile: ProfileView }>();
const emit = defineEmits<{ saved: [view: ProfileView]; cancel: []; refresh: [] }>();

const ENGINE_KINDS = ["context", "wakeup", "toolcall"] as const;
type EngineKind = (typeof ENGINE_KINDS)[number];

const ENGINE_LABELS: Record<EngineKind, string> = {
  context: "上下文引擎",
  wakeup: "唤醒引擎",
  toolcall: "工具调用引擎",
};

const ENGINE_HINTS: Record<EngineKind, string> = {
  context: "决定消息如何被压缩并组装为上下文。",
  wakeup: "决定哪些消息会触发一次运行。",
  toolcall: "决定模型可以调用的工具与调用方式。",
};

const RESERVED_KEYS = new Set(["context", "wakeup", "toolcall", "extends"]);

interface RawDraft {
  text: string;
  error: string;
}

interface EngineSection {
  kind: EngineKind;
  label: string;
  hint: string;
  current: string;
  options: EngineDescriptor[];
  descriptor: EngineDescriptor | undefined;
  schema: SchemaNode | undefined;
  value: unknown;
}

interface ExtensionRow {
  name: string;
  descriptor: ExtensionDescriptor | undefined;
  known: boolean;
  enabled: boolean;
  schema: SchemaNode | undefined;
  config: unknown;
}

const activeTab = ref<"base" | "engines" | "extensions" | "persona">("base");
const draft = ref<JsonRecord>(cloneRecord(props.profile.config));
const personaText = ref(props.profile.persona);
const dirty = ref(false);
const saving = ref(false);
const error = ref("");
const conflict = ref(false);
const confirmOpen = ref(false);
const rawDrafts = reactive<Record<string, RawDraft>>({});
const mode = ref<"form" | "raw">("form");
const rawDoc = ref("");

const baseSchema = computed<SchemaNode | undefined>(() => store.extensions?.schemas.base);
let seeded = false;
watch(
  baseSchema,
  (schema) => {
    if (seeded || schema === undefined) return;
    seeded = true;
    const defaults = schemaDefaults(schema);
    if (isRecord(defaults)) draft.value = mergeDefaults(defaults, draft.value);
  },
  { immediate: true },
);

const baseValue = computed<JsonRecord>(() => {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(draft.value)) {
    if (!RESERVED_KEYS.has(key)) result[key] = value;
  }
  return result;
});

const extendsRecord = computed<JsonRecord>(() => {
  const value = draft.value.extends;
  return isRecord(value) ? value : {};
});

const engineSections = computed<EngineSection[]>(() =>
  ENGINE_KINDS.map((kind) => {
    const record = engineRecord(kind);
    const current = record !== undefined && typeof record.engine === "string" ? record.engine : "";
    const directory = store.engines?.[kind] ?? [];
    let resolved = directory.find((item) => item.name === current);
    if (current !== "" && resolved === undefined) {
      resolved = { name: current, label: current, available: false };
    }
    const descriptor = resolved;
    const options = [...directory];
    if (descriptor !== undefined && !options.some((item) => item.name === descriptor.name)) {
      options.unshift(descriptor);
    }
    return {
      kind,
      label: ENGINE_LABELS[kind],
      hint: ENGINE_HINTS[kind],
      current,
      options,
      descriptor,
      schema: descriptor?.schema,
      value: current === "" ? undefined : record?.[current],
    };
  }),
);

const extensionRows = computed<ExtensionRow[]>(() => {
  const registry = store.extensions?.extensions ?? [];
  const entries = extendsRecord.value;
  const rows: ExtensionRow[] = [];
  const seen = new Set<string>();

  const push = (name: string, descriptor: ExtensionDescriptor | undefined): void => {
    const entry = entries[name];
    const record = isRecord(entry) ? entry : undefined;
    const known = descriptor?.known === true;
    rows.push({
      name,
      descriptor,
      known,
      enabled: record !== undefined && record.enable !== false,
      schema: known && descriptor !== undefined && descriptor.schema !== undefined ? descriptor.schema : undefined,
      config: record?.config,
    });
  };

  for (const descriptor of registry) {
    seen.add(descriptor.name);
    push(descriptor.name, descriptor);
  }
  for (const name of Object.keys(entries)) {
    if (!seen.has(name)) push(name, undefined);
  }
  return rows;
});

const enabledExtensions = computed(() => extensionRows.value.filter((row) => row.enabled).length);

const rawKeysInUse = computed<string[]>(() => {
  const keys: string[] = [];
  if (baseSchema.value === undefined) keys.push("base");
  for (const section of engineSections.value) {
    if (section.current !== "" && section.schema === undefined) keys.push(`engine:${section.kind}`);
  }
  for (const row of extensionRows.value) {
    if (row.enabled && row.schema === undefined) keys.push(`ext:${row.name}`);
  }
  return keys;
});

const rawIssue = computed(() => {
  for (const key of rawKeysInUse.value) {
    const entry = rawDrafts[key];
    if (entry !== undefined && entry.error !== "") {
      return `${rawLabel(key)} 的 JSON 内容无效：${entry.error}`;
    }
  }
  return "";
});

const validationIssue = computed(() => {
  if (mode.value === "raw") {
    return rawReport.value.issues.length > 0 ? `原始配置校验未通过：${rawReport.value.issues[0]}` : "";
  }
  if (rawIssue.value !== "") return rawIssue.value;
  const model = draft.value.model;
  if (typeof model !== "string" || model.trim() === "") return "基础配置中的模型不能为空。";
  return "";
});

/* 原始配置模式与表单共用 draft；校验失败时禁止切换与保存。 */

const knownConfigKeys = computed<string[]>(() => {
  const keys = new Set<string>(Object.keys(store.extensions?.schemas.base.dict ?? {}));
  for (const descriptor of store.extensions?.extensions ?? []) keys.add(descriptor.name);
  return [...keys];
});

const rawReport = computed<{ issues: string[]; line: number | undefined; value: JsonRecord | undefined }>(() => {
  if (mode.value !== "raw") return { issues: [], line: undefined, value: undefined };
  const parsed = parseRaw(rawDoc.value);
  if (!parsed.ok) return { issues: formatRawIssues(parsed.issues), line: parsed.issues[0]?.line, value: undefined };
  return { issues: formatRawIssues(inspectProfileConfig(parsed.value, knownConfigKeys.value)), line: undefined, value: parsed.value };
});

function enterRaw(): void {
  rawDoc.value = serializeRaw(draft.value);
  mode.value = "raw";
}

function applyRaw(): boolean {
  const value = rawReport.value.value;
  if (value === undefined) return false;
  draft.value = cloneRecord(value);
  dirty.value = true;
  return true;
}

function switchMode(next: "form" | "raw"): void {
  if (next === mode.value) return;
  if (next === "raw") {
    enterRaw();
    return;
  }
  if (rawReport.value.issues.length > 0 || !applyRaw()) return;
  mode.value = "form";
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function cloneRecord(value: JsonRecord): JsonRecord {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return { ...value };
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch {
    // 配置应当可以序列化；异常时退回浅拷贝。
  }
  return { ...value };
}

function mergeDefaults(defaults: JsonRecord, current: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...current };
  for (const [key, value] of Object.entries(defaults)) {
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (isRecord(existing) && isRecord(value)) result[key] = mergeDefaults(value, existing);
  }
  return result;
}

function setDraft(next: JsonRecord): void {
  draft.value = next;
  dirty.value = true;
}

function engineRecord(kind: EngineKind): JsonRecord | undefined {
  const value = draft.value[kind];
  return isRecord(value) ? value : undefined;
}

function findEngine(kind: EngineKind, name: string): EngineDescriptor | undefined {
  return store.engines?.[kind]?.find((item) => item.name === name);
}

function engineOptionLabel(option: EngineDescriptor): string {
  const base = option.label === option.name ? option.name : `${option.label}（${option.name}）`;
  return option.available ? base : `${base} · 不可用`;
}

function selectEngine(kind: EngineKind, name: string): void {
  const record = engineRecord(kind);
  if (record !== undefined && record.engine === name) return;
  delete rawDrafts[`engine:${kind}`];
  if (name === "") {
    const next = { ...draft.value };
    delete next[kind];
    setDraft(next);
    return;
  }
  const existing = record?.[name];
  const value = existing !== undefined ? existing : engineDefaults(kind, name);
  setDraft({ ...draft.value, [kind]: { engine: name, [name]: value } });
}

function setEngineValue(kind: EngineKind, value: unknown): void {
  const record = engineRecord(kind);
  if (record === undefined || typeof record.engine !== "string") return;
  setDraft({ ...draft.value, [kind]: { ...record, [record.engine]: value } });
}

function updateEngineRaw(kind: EngineKind, raw: string): void {
  const record = engineRecord(kind);
  if (record === undefined || typeof record.engine !== "string") return;
  const name = record.engine;
  updateRawKey(`engine:${kind}`, raw, (parsed) => {
    setDraft({ ...draft.value, [kind]: { ...record, [name]: parsed } });
    return undefined;
  });
}

function extensionDescriptor(name: string): ExtensionDescriptor | undefined {
  return store.extensions?.extensions.find((item) => item.name === name);
}

function extensionDefaults(name: string): unknown {
  const descriptor = extensionDescriptor(name);
  if (descriptor === undefined || descriptor.known !== true || descriptor.schema === undefined) return {};
  const defaults = schemaDefaults(descriptor.schema);
  return defaults === undefined ? {} : defaults;
}

function engineDefaults(kind: EngineKind, name: string): unknown {
  const descriptor = findEngine(kind, name);
  if (descriptor === undefined || descriptor.schema === undefined) return {};
  const defaults = schemaDefaults(descriptor.schema);
  return defaults === undefined ? {} : defaults;
}

function writeExtension(name: string, mutate: (entry: JsonRecord) => void): void {
  const entries = { ...extendsRecord.value };
  const current = entries[name];
  const entry: JsonRecord = isRecord(current) ? { ...current } : { enable: true, config: {} };
  if (typeof entry.enable !== "boolean") entry.enable = true;
  mutate(entry);
  entries[name] = entry;
  setDraft({ ...draft.value, extends: entries });
}

function toggleExtension(name: string, enabled: boolean): void {
  const entries = { ...extendsRecord.value };
  const current = entries[name];
  const entry: JsonRecord = isRecord(current) ? { ...current } : { enable: true, config: extensionDefaults(name) };
  entry.enable = enabled;
  if (enabled && entry.config === undefined) entry.config = extensionDefaults(name);
  entries[name] = entry;
  setDraft({ ...draft.value, extends: entries });
  if (!enabled) delete rawDrafts[`ext:${name}`];
}

function setExtensionConfig(name: string, value: unknown): void {
  writeExtension(name, (entry) => {
    entry.config = value;
    if (entry.enable === false) entry.enable = true;
  });
}

function updateExtensionRaw(name: string, raw: string): void {
  updateRawKey(`ext:${name}`, raw, (parsed) => {
    const entries = { ...extendsRecord.value };
    const current = entries[name];
    const entry: JsonRecord = isRecord(current) ? { ...current } : { enable: true, config: {} };
    if (typeof entry.enable !== "boolean") entry.enable = true;
    entry.config = parsed;
    entries[name] = entry;
    setDraft({ ...draft.value, extends: entries });
    return undefined;
  });
}

function rawText(key: string, value: unknown): string {
  const entry = rawDrafts[key];
  if (entry !== undefined) return entry.text;
  if (value === undefined) return "{}";
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? "{}" : text;
}

function rawError(key: string): string {
  return rawDrafts[key]?.error ?? "";
}

function rawLabel(key: string): string {
  if (key === "base") return "基础配置";
  if (key.startsWith("engine:")) {
    const kind = key.slice("engine:".length);
    if (kind === "context" || kind === "wakeup" || kind === "toolcall") return ENGINE_LABELS[kind];
    return "引擎配置";
  }
  if (key.startsWith("ext:")) return `扩展 ${key.slice("ext:".length)}`;
  return key;
}

function updateRawKey(key: string, raw: string, apply: (parsed: unknown) => string | undefined): void {
  const entry = rawDrafts[key] ?? (rawDrafts[key] = { text: "", error: "" });
  entry.text = raw;
  if (raw.trim() === "") {
    entry.error = apply({}) ?? "";
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error_) {
    entry.error = error_ instanceof Error ? error_.message : "JSON 解析失败";
    return;
  }
  entry.error = apply(parsed) ?? "";
}

function updateBase(value: unknown): void {
  if (!isRecord(value)) return;
  const next: JsonRecord = {};
  for (const key of Object.keys(draft.value)) {
    if (RESERVED_KEYS.has(key)) next[key] = draft.value[key];
  }
  for (const [key, field] of Object.entries(value)) {
    if (!RESERVED_KEYS.has(key)) next[key] = field;
  }
  setDraft(next);
}

function updateBaseRaw(raw: string): void {
  updateRawKey("base", raw, (parsed) => {
    if (!isRecord(parsed)) return "需要一个 JSON 对象";
    const next: JsonRecord = {};
    for (const key of Object.keys(draft.value)) {
      if (RESERVED_KEYS.has(key)) next[key] = draft.value[key];
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!RESERVED_KEYS.has(key)) next[key] = value;
    }
    setDraft(next);
    return undefined;
  });
}

function onPersonaInput(event: Event): void {
  personaText.value = (event.target as HTMLTextAreaElement).value;
  dirty.value = true;
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return String(caught);
}

async function save(): Promise<void> {
  if (saving.value || validationIssue.value !== "") return;
  if (mode.value === "raw") {
    if (rawReport.value.issues.length > 0 || !applyRaw()) return;
    mode.value = "form";
  }
  saving.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const view = await call<ProfileView>(
      "ishiki/profiles/save",
      props.profile.id,
      { config: cloneRecord(draft.value), persona: personaText.value },
      props.profile.revision,
    );
    dirty.value = false;
    toast("success", "人格配置已保存", `${view.id} 的配置已保存，应用后才会生效。`);
    emit("saved", view);
  } catch (error_) {
    const message = describeError(error_);
    error.value = message;
    conflict.value = error_ instanceof ApiError && error_.code === "conflict";
    toast("error", "保存失败", message);
  } finally {
    saving.value = false;
  }
}

function requestCancel(): void {
  if (saving.value) return;
  if (dirty.value) {
    confirmOpen.value = true;
    return;
  }
  emit("cancel");
}

function requestReload(): void {
  toast("info", "正在重新读取", "将载入磁盘上的最新版本，当前未保存的修改会被放弃。");
  emit("refresh");
}

function discard(): void {
  confirmOpen.value = false;
  emit("cancel");
}

const personaPath = computed(() => {
  const file = props.profile.instructions.find((item) => !item.missing);
  return file?.path;
});
</script>

<template>
  <div class="stack">
    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title mono">{{ profile.id }}</div>
          <div class="panel-sub">编辑配置与人格。保存会写入配置文件，应用后才会影响运行实例。</div>
        </div>
        <div class="panel-actions">
          <span v-if="dirty" class="badge badge-warning">未保存</span>
          <div class="segmented" role="group" aria-label="编辑模式">
            <button type="button" :aria-pressed="mode === 'form'" @click="switchMode('form')">表单</button>
            <button type="button" :aria-pressed="mode === 'raw'" @click="switchMode('raw')">原始配置</button>
          </div>
        </div>
      </div>

      <div class="panel-body stack-sm">
        <div v-if="profile.state === 'active'" class="notice notice-info">
          <Icon name="info" :size="14" />
          <span>这份人格配置正在运行。保存不会替换当前实例，需要重新加载或应用后才会生效。</span>
        </div>

        <div v-if="error !== ''" class="error-panel" role="alert">
          <Icon name="alert" :size="15" />
          <span class="flex-1">{{ error }}</span>
          <button v-if="conflict" type="button" class="btn btn-sm" @click="requestReload"><Icon name="refresh" :size="13" /> 重新读取</button>
        </div>

        <div v-if="mode === 'raw'" class="stack-sm">
          <p class="field-hint">直接编辑 YAML 配置。人格文本仍在表单模式的「人格与指令」分区维护；校验失败时无法切回表单或保存，原文会保留。</p>
          <RawEditor :model-value="rawDoc" :error-line="rawReport.line" :aria-label="`原始配置 ${profile.id}`" @update:model-value="rawDoc = $event" />
          <div v-if="rawReport.issues.length > 0" class="error-panel" role="alert">
            <Icon name="alert" :size="15" />
            <div class="flex-1">
              <strong>原始配置校验未通过</strong>
              <ul class="raw-issue-list">
                <li v-for="issue in rawReport.issues" :key="issue">{{ issue }}</li>
              </ul>
            </div>
          </div>
        </div>

        <template v-else>
          <div class="tabs" role="tablist" aria-label="人格配置编辑分区">
            <button type="button" class="tab" role="tab" :aria-selected="activeTab === 'base'" @click="activeTab = 'base'">基础配置</button>
            <button type="button" class="tab" role="tab" :aria-selected="activeTab === 'engines'" @click="activeTab = 'engines'">
              引擎<span class="tab-count">3</span>
            </button>
            <button type="button" class="tab" role="tab" :aria-selected="activeTab === 'extensions'" @click="activeTab = 'extensions'">
              扩展<span class="tab-count">{{ enabledExtensions }}</span>
            </button>
            <button type="button" class="tab" role="tab" :aria-selected="activeTab === 'persona'" @click="activeTab = 'persona'">人格与指令</button>
          </div>

          <div v-if="activeTab === 'base'" class="stack">
            <div class="form-section">
              <div class="form-section-head">
                <div class="form-section-title">基础配置</div>
                <div class="form-section-desc">模型、频道认领与运行策略，字段由服务端定义生成。</div>
              </div>
              <SchemaForm v-if="baseSchema !== undefined" :schema="baseSchema" :model-value="baseValue" @update:model-value="updateBase" />
              <FormField v-else label="基础配置（JSON）" hint="服务端尚未提供基础字段定义，直接编辑原始 JSON。" :error="rawError('base')">
                <textarea
                  class="textarea input-mono"
                  rows="14"
                  spellcheck="false"
                  :value="rawText('base', baseValue)"
                  @input="updateBaseRaw(($event.target as HTMLTextAreaElement).value)"
                ></textarea>
              </FormField>
            </div>
          </div>

          <div v-else-if="activeTab === 'engines'" class="stack">
            <div v-for="section in engineSections" :key="section.kind" class="form-section">
              <div class="form-section-head">
                <div class="form-section-title">{{ section.label }}</div>
                <span v-if="section.current === ''" class="badge badge-neutral">未配置</span>
                <span v-else-if="section.descriptor?.available === false" class="badge badge-warning">不可用</span>
                <div class="form-section-desc">{{ section.hint }}</div>
              </div>

              <FormField label="引擎" hint="选择后配置会写入这份人格配置的对应引擎键。">
                <select class="select" :value="section.current" @change="selectEngine(section.kind, ($event.target as HTMLSelectElement).value)">
                  <option value="">未配置</option>
                  <option v-for="option in section.options" :key="option.name" :value="option.name">
                    {{ engineOptionLabel(option) }}
                  </option>
                </select>
              </FormField>

              <template v-if="section.current !== ''">
                <SchemaForm
                  v-if="section.schema !== undefined"
                  :schema="section.schema"
                  :model-value="section.value"
                  @update:model-value="setEngineValue(section.kind, $event)"
                />
                <FormField
                  v-else
                  label="引擎配置（JSON）"
                  hint="该引擎没有可用字段定义，直接编辑原始 JSON；配置会原样保存。"
                  :error="rawError(`engine:${section.kind}`)"
                >
                  <textarea
                    class="textarea input-mono"
                    rows="10"
                    spellcheck="false"
                    :value="rawText(`engine:${section.kind}`, section.value)"
                    @input="updateEngineRaw(section.kind, ($event.target as HTMLTextAreaElement).value)"
                  ></textarea>
                </FormField>
              </template>
              <p v-else class="field-hint">未配置时使用服务端默认引擎。</p>
            </div>
          </div>

          <div v-else-if="activeTab === 'extensions'" class="stack">
            <template v-if="extensionRows.length === 0">
              <div class="empty">
                <div class="empty-mark"><Icon name="settings" :size="20" /></div>
                <div class="empty-title">没有可配置的扩展</div>
                <p class="empty-desc">服务端尚未注册扩展，或这份人格配置中没有扩展条目。</p>
              </div>
            </template>

            <template v-else>
              <div v-for="row in extensionRows" :key="row.name" class="form-section">
                <div class="form-section-head">
                  <div class="form-section-title mono">{{ row.name }}</div>
                  <span class="badge" :class="row.known ? 'badge-outline' : 'badge-warning'">
                    {{ row.known ? "已知扩展" : "未知扩展" }}
                  </span>
                  <span v-if="row.descriptor === undefined" class="badge badge-neutral">未注册</span>
                  <span class="spacer"></span>
                  <ToggleSwitch :checked="row.enabled" :label="row.enabled ? '启用' : '停用'" @update:checked="toggleExtension(row.name, $event)" />
                </div>

                <template v-if="row.enabled">
                  <SchemaForm
                    v-if="row.schema !== undefined"
                    :schema="row.schema"
                    :model-value="row.config"
                    @update:model-value="setExtensionConfig(row.name, $event)"
                  />
                  <FormField
                    v-else
                    label="扩展配置（JSON）"
                    hint="该扩展没有可用的字段定义，直接编辑原始 JSON；内容会原样保存。"
                    :error="rawError(`ext:${row.name}`)"
                  >
                    <textarea
                      class="textarea input-mono"
                      rows="10"
                      spellcheck="false"
                      :value="rawText(`ext:${row.name}`, row.config)"
                      @input="updateExtensionRaw(row.name, ($event.target as HTMLTextAreaElement).value)"
                    ></textarea>
                  </FormField>
                </template>
                <p v-else class="field-hint">已停用，配置会保留，重新启用后恢复使用。</p>
              </div>
            </template>
          </div>

          <div v-else class="stack">
            <div class="form-section">
              <div class="form-section-head">
                <div class="form-section-title">人格文本</div>
                <div class="form-section-desc">保存时写入第一个指令文件；读取时使用第一个未缺失的指令文件。</div>
              </div>
              <textarea class="textarea profile-persona-editor" rows="16" spellcheck="false" :value="personaText" @input="onPersonaInput"></textarea>
              <p class="field-hint">
                当前人设文件：<span class="mono">{{ personaPath ?? "未找到可用文件" }}</span>
              </p>
            </div>

            <div class="form-section">
              <div class="form-section-head">
                <div class="form-section-title">指令文件</div>
                <div class="form-section-desc">路径来自人格配置，绝对路径只读展示。</div>
              </div>
              <div class="profile-file-list">
                <div v-for="file in profile.instructions" :key="file.path" class="profile-file-row">
                  <span class="profile-file-path mono">{{ file.path }}</span>
                  <span class="profile-file-tags">
                    <span v-if="file.missing" class="badge badge-danger">缺失</span>
                    <span v-if="file.path === personaPath" class="badge badge-info">人设文件</span>
                  </span>
                </div>
                <p v-if="profile.instructions.length === 0" class="field-hint">未配置指令文件，保存人格时默认写入 PERSONA.md。</p>
              </div>
            </div>
          </div>
        </template>

        <div v-if="validationIssue !== ''" class="field-error" role="alert">
          {{ validationIssue }}
        </div>
      </div>

      <div class="panel-foot editor-bar">
        <span v-if="dirty" class="badge badge-warning">未保存</span>
        <span v-else class="muted small">配置与已保存版本一致</span>
        <span class="spacer"></span>
        <button type="button" class="btn" :disabled="saving" @click="requestCancel">取消</button>
        <button type="button" class="btn btn-primary" :disabled="saving || validationIssue !== ''" @click="save">
          <span v-if="saving" class="spinner" aria-hidden="true"></span>
          {{ saving ? "保存中…" : "保存人格配置" }}
        </button>
      </div>
    </section>

    <BaseModal :open="confirmOpen" title="放弃未保存的修改？" desc="返回详情后，本次编辑的内容不会保留。" @close="confirmOpen = false">
      <p>当前编辑器中有尚未保存的修改。放弃后会恢复为最近一次读取的配置。</p>
      <template #footer>
        <button type="button" class="btn" @click="confirmOpen = false">继续编辑</button>
        <button type="button" class="btn btn-danger" @click="discard">放弃修改</button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.profile-persona-editor {
  min-height: 320px;
  line-height: 1.65;
  resize: vertical;
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

.profile-file-list {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.profile-file-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
  min-width: 0;
  padding: 9px 11px;
  background: var(--surface-muted);
}

.profile-file-row + .profile-file-row {
  border-top: 1px solid var(--line);
}

.profile-file-path {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  font-size: 11.5px;
  line-height: 1.55;
}

.profile-file-tags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

@media (max-width: 620px) {
  .profile-file-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .profile-file-tags {
    justify-content: flex-start;
  }
}
</style>
