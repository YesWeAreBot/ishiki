import { computed, reactive, ref } from "vue";

import {
  DEMO_ENV,
  DEMO_NOW,
  groups as demoGroups,
  profiles as demoProfiles,
  providers as demoProviders,
  runtimes as demoRuntimes,
  sessions as demoSessions,
} from "./data/demo";
import { audits as demoAudits, cacheSnapshot as demoCache, dataQuality as demoDataQuality, usage as demoUsage } from "./data/demo-observability";
import { buildPromptCacheRows } from "./data/demo-observability";
import { demoSessionEntries } from "./data/demo-sessions";
import type {
  CacheSnapshot,
  DataQualityRow,
  ModelDecl,
  ModelGroup,
  ProfileConfig,
  ProfileView,
  ProviderConfig,
  RuntimeView,
  SessionDetail,
  SessionSummary,
  ToastMessage,
  UsageRecord,
} from "./data/types";
import { findDeclaredModel, modelOptions, parseReference } from "./lib/models";
import { activationError, defaultContextConfig, defaultToolcallConfig, defaultWakeupConfig, validateProfileDraft } from "./lib/profile";

const wait = (milliseconds: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.setTimeout(resolve, milliseconds);
  return promise;
};

let toastSequence = 0;
let turnSequence = 0;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function missingEnv(value: string): string | undefined {
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1];
    if ((DEMO_ENV[name] ?? "").length === 0) return name;
  }
  return undefined;
}

function referenceBase(reference: string): string {
  const parsed = parseReference(reference);
  return "group" in parsed ? reference : `${parsed.provider}:${parsed.modelId}`;
}

function modelReferences(modelReference: string, profiles: readonly ProfileView[], groups: readonly ModelGroup[]): string[] {
  const base = referenceBase(modelReference);
  const references: string[] = [];
  for (const group of groups) {
    if (group.models.some((member) => referenceBase(member) === base)) references.push(`模型组「${group.name}」`);
  }
  for (const profile of profiles) {
    if (referenceBase(profile.config.model) === base) references.push(`Profile「${profile.id}」的 model`);
    const config = profile.config.toolcall.config;
    for (const key of ["decoderModel", "replyModel"]) {
      const value = String(config[key] ?? "");
      if (value.length > 0 && referenceBase(value) === base) references.push(`Profile「${profile.id}」的 toolcall.${key}`);
    }
  }
  return [...new Set(references)];
}

function groupReferences(name: string, profiles: readonly ProfileView[]): string[] {
  return profiles.filter((profile) => referenceBase(profile.config.model) === name).map((profile) => `Profile「${profile.id}」的 model`);
}

function stageIssue(providers: readonly ProviderConfig[], groups: readonly ModelGroup[], profiles: readonly ProfileView[]): string | undefined {
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider.id)) return `供应商 ID「${provider.id}」不合法`;
    if (providerIds.has(provider.id)) return `供应商 ID「${provider.id}」重复`;
    providerIds.add(provider.id);
    if (provider.apiKey.trim().length === 0) return `providers.${provider.id}.apiKey 不能为空`;
    const env = missingEnv(provider.apiKey);
    if (env !== undefined) return `providers.${provider.id}.apiKey: environment variable "${env}" is not set`;
    for (const model of provider.models) {
      if (model.id.trim().length === 0) return `providers.${provider.id} 存在空模型 ID`;
      if (model.id.includes(":")) return `模型 ID「${model.id}」不能包含冒号`;
    }
  }

  for (const group of groups) {
    if (group.name.trim().length === 0) return "模型组名称不能为空";
    if (group.name.includes(":")) return `模型组名称「${group.name}」不能包含冒号`;
    if (group.models.length === 0) return `模型组「${group.name}」至少需要一个候选`;
    for (const member of group.models) {
      const parsed = parseReference(member);
      if ("group" in parsed) return `组「${group.name}」的成员「${member}」不是 provider:model 引用`;
      const found = findDeclaredModel(providers, member);
      if (found === undefined) return `组「${group.name}」的成员「${member}」不存在`;
      if (found.model.type !== "language") return `组「${group.name}」的成员「${member}」不是语言模型`;
      if (parsed.level !== undefined && found.model.thinking?.efforts !== undefined && !found.model.thinking.efforts.includes(parsed.level)) {
        return `模型「${member}」不支持思考档位「${parsed.level}」`;
      }
    }
  }

  for (const profile of profiles) {
    const parsed = parseReference(profile.config.model);
    if ("group" in parsed) {
      if (!groups.some((group) => group.name === parsed.group)) return `Profile「${profile.id}」引用的模型组「${parsed.group}」不存在`;
    } else {
      const found = findDeclaredModel(providers, profile.config.model);
      if (found === undefined) return `Profile「${profile.id}」引用的模型「${profile.config.model}」不存在`;
      if (found.model.type !== "language") return `Profile「${profile.id}」引用的「${profile.config.model}」不是语言模型`;
    }
    if (profile.config.attachment.imageInput) {
      const candidates = "group" in parsed ? (groups.find((group) => group.name === parsed.group)?.models ?? []) : [profile.config.model];
      const missing = candidates.filter((member) => {
        const found = findDeclaredModel(providers, member);
        return found === undefined || !found.model.input?.includes("image");
      });
      if (missing.length > 0) return `Profile「${profile.id}」开启 imageInput，但 ${missing.join("、")} 未声明 image 输入`;
    }
    const toolcall = profile.config.toolcall.config;
    for (const key of ["decoderModel", "replyModel"]) {
      const value = String(toolcall[key] ?? "");
      if (value.length === 0) continue;
      const parsedStage = parseReference(value);
      const valid =
        "group" in parsedStage ? groups.some((group) => group.name === parsedStage.group) : findDeclaredModel(providers, value)?.model.type === "language";
      if (!valid) return `Profile「${profile.id}」的 toolcall.${key} 引用「${value}」不存在`;
    }
  }
  return undefined;
}

function affectedRuntimeIds(profileId: string, runtimes: readonly RuntimeView[]): string[] {
  return runtimes.filter((runtime) => runtime.profileId === profileId).map((runtime) => runtime.id);
}

export const store = reactive({
  providers: clone(demoProviders),
  groups: clone(demoGroups),
  profiles: clone(demoProfiles),
  runtimes: clone(demoRuntimes),
  sessions: clone(demoSessions),
  usageRecords: clone(demoUsage),
  audits: clone(demoAudits),
  cache: clone(demoCache) as CacheSnapshot,
  dataQuality: clone(demoDataQuality) as DataQualityRow[],
  env: { ...DEMO_ENV },
  now: DEMO_NOW,
  toasts: [] as ToastMessage[],
  route: ref("/models"),
  query: ref(""),
  dirty: reactive<Record<string, boolean>>({}),
  busyProfiles: reactive<Record<string, "activating" | "stopping" | "restarting" | "deleting">>({}),
  busyRuntimes: reactive<Record<string, "restarting" | "stopping" | "waking">>({}),
  sessionListLoading: ref(true),
  sessionListError: ref<string | undefined>(undefined),
  lastSyncAt: ref<number | undefined>(undefined),
});

const sessionData = new Map<string, { summary: SessionSummary; entries: SessionDetail["entries"] }>();
for (const summary of store.sessions) {
  const fixture = demoSessionEntries.get(summary.id);
  if (fixture === undefined) continue;
  const derived = { ...fixture.summary, state: summary.state, error: summary.error };
  Object.assign(summary, derived);
  sessionData.set(summary.id, { summary: derived, entries: fixture.entries });
}

for (const runtime of store.runtimes) {
  const session = store.sessions.find((summary) => summary.id === runtime.sessionId);
  if (session?.lastActivity !== undefined) runtime.lastActivity = session.lastActivity;
}

export const modelOptionsAll = computed(() => modelOptions(store.providers, store.groups));
export const modelOptionsLanguage = computed(() => modelOptions(store.providers, store.groups, { languageOnly: true }));

export const hasDirty = computed(() => Object.values(store.dirty).some(Boolean));

export function setDirty(key: string, value: boolean): void {
  if (value) store.dirty[key] = true;
  else delete store.dirty[key];
}

export function clearDirty(): void {
  for (const key of Object.keys(store.dirty)) delete store.dirty[key];
}

export function navigate(path: string, query?: string): void {
  const next = query === undefined || query.length === 0 ? path : `${path}?${query}`;
  if (next === `${store.route}${store.query ? `?${store.query}` : ""}`) return;
  window.location.hash = next;
}

export function toast(tone: ToastMessage["tone"], title: string, detail?: string): void {
  toastSequence += 1;
  const message: ToastMessage = { id: toastSequence, tone, title, detail };
  store.toasts.push(message);
  window.setTimeout(() => dismissToast(message.id), 5200);
}

export function dismissToast(id: number): void {
  const index = store.toasts.findIndex((entry) => entry.id === id);
  if (index >= 0) store.toasts.splice(index, 1);
}

export function profileById(id: string): ProfileView | undefined {
  return store.profiles.find((profile) => profile.id === id);
}

export function runtimeById(id: string): RuntimeView | undefined {
  return store.runtimes.find((runtime) => runtime.id === id);
}

export function sessionById(id: string): SessionSummary | undefined {
  return store.sessions.find((session) => session.id === id);
}

export function runtimesForProfile(profileId: string): RuntimeView[] {
  return store.runtimes.filter((runtime) => runtime.profileId === profileId);
}

export function sessionsForProfile(profileId: string): SessionSummary[] {
  return store.sessions.filter((session) => session.profileId === profileId);
}

export function referencesForModel(reference: string): string[] {
  return modelReferences(reference, store.profiles, store.groups);
}

export function referencesForGroup(name: string): string[] {
  return groupReferences(name, store.profiles);
}

export function profileConfigSummary(config: ProfileConfig): string {
  return `${config.context.engine} · ${config.wakeup.engine} · ${config.toolcall.engine}`;
}

export async function refreshSessions(): Promise<void> {
  store.sessionListLoading = true;
  store.sessionListError = undefined;
  await wait(650);
  store.sessionListLoading = false;
}

export async function loadSession(id: string): Promise<SessionDetail> {
  const fixture = sessionData.get(id);
  const summary = sessionById(id);
  if (summary === undefined || fixture === undefined) throw new Error("会话不存在或已随 Profile 删除。");
  await wait(420);
  if (summary.state === "error") throw new Error(summary.error ?? "日志读取失败");
  return { summary: fixture.summary, entries: fixture.entries };
}

export interface ModelDraft {
  originalReference?: string;
  providerId: string;
  providerIsNew: boolean;
  api: ProviderConfig["api"];
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  settings: Record<string, unknown>;
  model: ModelDecl;
}

export async function saveModel(draft: ModelDraft): Promise<{ ok: boolean; error?: string; reference?: string }> {
  await wait(650);
  const model = clone(draft.model);
  model.id = model.id.trim();
  model.name = model.name?.trim();
  if (model.id.length === 0) return { ok: false, error: "模型 ID 不能为空。" };
  if (model.id.includes(":")) return { ok: false, error: "模型 ID 不能包含冒号；思考档位写在引用末尾。" };
  if (draft.providerId.trim().length === 0) return { ok: false, error: "供应商 ID 不能为空。" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(draft.providerId)) {
    return { ok: false, error: "供应商 ID 只能使用字母、数字、点、下划线与连字符。" };
  }

  const providers = clone(store.providers);
  let provider = providers.find((entry) => entry.id === draft.providerId);
  if (provider === undefined) {
    if (!draft.providerIsNew) return { ok: false, error: `供应商「${draft.providerId}」不存在。` };
    provider = {
      id: draft.providerId,
      api: draft.api,
      baseUrl: draft.baseUrl.trim() || undefined,
      apiKey: draft.apiKey,
      headers: { ...draft.headers },
      settings: { ...draft.settings },
      models: [],
    };
    providers.push(provider);
  } else {
    if (draft.providerIsNew) return { ok: false, error: `供应商 ID「${draft.providerId}」已存在。` };
    provider.api = draft.api;
    provider.baseUrl = draft.baseUrl.trim() || undefined;
    provider.apiKey = draft.apiKey;
    provider.headers = { ...draft.headers };
    provider.settings = { ...draft.settings };
  }

  const duplicate = provider.models.find((entry) => entry.id === model.id);
  if (draft.originalReference === undefined) {
    if (duplicate !== undefined) return { ok: false, error: `供应商「${provider.id}」已经声明模型「${model.id}」。` };
    provider.models.push(model);
  } else {
    const original = parseReference(draft.originalReference);
    if ("group" in original) return { ok: false, error: "无法解析原始模型引用。" };
    const index = provider.models.findIndex((entry) => entry.id === original.modelId);
    if (index < 0) return { ok: false, error: "要编辑的模型已不存在。" };
    const references = referencesForModel(draft.originalReference);
    if (references.length > 0 && model.id !== original.modelId) {
      return { ok: false, error: `模型 ID 被 ${references.join("、")} 引用，不能直接改名。先调整引用。` };
    }
    if (references.length > 0 && model.type !== provider.models[index].type) {
      return { ok: false, error: `模型被 ${references.join("、")} 引用，不能更改类型。先调整引用。` };
    }
    if (duplicate !== undefined && duplicate.id !== original.modelId) {
      return { ok: false, error: `供应商「${provider.id}」已经声明模型「${model.id}」。` };
    }
    provider.models[index] = model;
  }

  const issue = stageIssue(providers, store.groups, store.profiles);
  if (issue !== undefined) return { ok: false, error: issue };

  store.providers.splice(0, store.providers.length, ...providers);
  store.lastSyncAt = Date.now();
  return { ok: true, reference: `${provider.id}:${model.id}` };
}

export async function deleteModel(reference: string): Promise<{ ok: boolean; error?: string; references: string[] }> {
  await wait(420);
  const references = referencesForModel(reference);
  if (references.length > 0) {
    return { ok: false, error: "模型仍被其他配置引用。", references };
  }
  const parsed = parseReference(reference);
  if ("group" in parsed) return { ok: false, error: "引用不是模型。", references: [] };
  const provider = store.providers.find((entry) => entry.id === parsed.provider);
  const index = provider?.models.findIndex((entry) => entry.id === parsed.modelId) ?? -1;
  if (provider === undefined || index < 0) return { ok: false, error: "模型已不存在。", references: [] };
  provider.models.splice(index, 1);
  store.lastSyncAt = Date.now();
  return { ok: true, references: [] };
}

export async function saveGroup(originalName: string | undefined, group: ModelGroup): Promise<{ ok: boolean; error?: string }> {
  await wait(500);
  const next = clone(group);
  next.name = next.name.trim();
  if (next.name.length === 0) return { ok: false, error: "模型组名称不能为空。" };
  if (next.name.includes(":")) return { ok: false, error: "模型组名称不能包含冒号。" };
  if (next.models.length === 0) return { ok: false, error: "至少选择一个候选模型。" };
  if (new Set(next.models).size !== next.models.length) return { ok: false, error: "候选模型重复。" };
  if (next.circuitBreaker.failureThreshold < 1) return { ok: false, error: "failureThreshold 必须不小于 1。" };
  if (next.circuitBreaker.cooldownSeconds < 0) return { ok: false, error: "cooldownSeconds 不能小于 0。" };

  const groups = clone(store.groups);
  if (originalName === undefined) {
    if (groups.some((entry) => entry.name === next.name)) return { ok: false, error: `模型组「${next.name}」已存在。` };
    groups.push(next);
  } else {
    const references = referencesForGroup(originalName);
    if (references.length > 0 && next.name !== originalName) {
      return { ok: false, error: `模型组被 ${references.join("、")} 引用，不能改名。` };
    }
    const index = groups.findIndex((entry) => entry.name === originalName);
    if (index < 0) return { ok: false, error: "模型组已不存在。" };
    if (groups.some((entry) => entry.name === next.name && entry.name !== originalName)) return { ok: false, error: `模型组「${next.name}」已存在。` };
    groups[index] = next;
  }

  const issue = stageIssue(store.providers, groups, store.profiles);
  if (issue !== undefined) return { ok: false, error: issue };

  store.groups.splice(0, store.groups.length, ...groups);
  store.lastSyncAt = Date.now();
  return { ok: true };
}

export async function deleteGroup(name: string): Promise<{ ok: boolean; error?: string; references: string[] }> {
  await wait(380);
  const references = referencesForGroup(name);
  if (references.length > 0) return { ok: false, error: "模型组仍被 Profile 引用。", references };
  const index = store.groups.findIndex((entry) => entry.name === name);
  if (index < 0) return { ok: false, error: "模型组已不存在。", references: [] };
  store.groups.splice(index, 1);
  store.lastSyncAt = Date.now();
  return { ok: true, references: [] };
}

export async function saveProfile(input: {
  id: string;
  isNew: boolean;
  config: ProfileConfig;
  persona: string;
}): Promise<{ ok: boolean; error?: string; errors: Record<string, string>; warnings: Record<string, string> }> {
  await wait(700);
  const validation = validateProfileDraft({
    id: input.id,
    isNew: input.isNew,
    config: input.config,
    profiles: store.profiles,
    providers: store.providers,
    groups: store.groups,
    env: store.env,
  });
  if (!validation.valid) {
    return { ok: false, error: Object.values(validation.errors)[0], errors: validation.errors, warnings: validation.warnings };
  }

  if (input.isNew) {
    store.profiles.push({
      id: input.id,
      config: clone(input.config),
      persona: input.persona,
      savedAt: Date.now(),
      status: "stopped",
    });
  } else {
    const profile = profileById(input.id);
    if (profile === undefined) return { ok: false, error: "Profile 不存在。", errors: {}, warnings: {} };
    profile.config = clone(input.config);
    profile.persona = input.persona;
    profile.savedAt = Date.now();
    profile.status = profile.status === "error" || profile.status === "waiting" ? "stopped" : profile.status;
    profile.lastError = undefined;
  }
  return { ok: true, errors: {}, warnings: validation.warnings };
}

export async function activateProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const profile = profileById(id);
  if (profile === undefined) return { ok: false, error: "Profile 不存在。" };
  if (profile.status === "active" || profile.status === "activating") return { ok: false, error: "Profile 已在运行。" };
  store.busyProfiles[id] = "activating";
  profile.status = "activating";
  await wait(950);
  const error = activationError(profile, store.providers, store.groups, store.env);
  if (error !== undefined) {
    profile.status = "error";
    profile.lastError = error;
    delete store.busyProfiles[id];
    toast("error", "Profile 激活失败", error);
    return { ok: false, error };
  }
  profile.status = "active";
  profile.lastError = undefined;
  profile.appliedAt = profile.savedAt;
  delete store.busyProfiles[id];
  toast("success", "Profile 已激活", `「${id}」的 runtime 会在收到下一条认领消息时创建。`);
  return { ok: true };
}

export async function stopProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const profile = profileById(id);
  if (profile === undefined) return { ok: false, error: "Profile 不存在。" };
  if (profile.status !== "active" && profile.status !== "error" && profile.status !== "waiting") {
    return { ok: false, error: "当前状态不能停止。" };
  }
  store.busyProfiles[id] = "stopping";
  const previousStatus = profile.status;
  profile.status = "stopping";
  await wait(800);
  const removed = affectedRuntimeIds(id, store.runtimes);
  for (let index = store.runtimes.length - 1; index >= 0; index -= 1) {
    if (store.runtimes[index].profileId === id) store.runtimes.splice(index, 1);
  }
  for (const session of store.sessions) {
    if (removed.includes(session.runtimeId)) session.state = "stopped";
  }
  profile.status = previousStatus === "error" ? "stopped" : "stopped";
  profile.lastError = undefined;
  delete store.busyProfiles[id];
  toast("success", "Profile 已停止", removed.length > 0 ? `已停止 ${removed.length} 个运行实例；会话日志保留。` : "没有活跃的运行实例。");
  return { ok: true };
}

export async function restartProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const profile = profileById(id);
  if (profile === undefined) return { ok: false, error: "Profile 不存在。" };
  if (profile.status !== "active" && profile.status !== "error" && profile.status !== "waiting") {
    return { ok: false, error: "当前状态不能重新激活。" };
  }
  store.busyProfiles[id] = "restarting";
  await wait(500);
  const removed = affectedRuntimeIds(id, store.runtimes);
  for (let index = store.runtimes.length - 1; index >= 0; index -= 1) {
    if (store.runtimes[index].profileId === id) store.runtimes.splice(index, 1);
  }
  for (const session of store.sessions) {
    if (removed.includes(session.runtimeId)) session.state = "stopped";
  }
  await wait(600);
  const error = activationError(profile, store.providers, store.groups, store.env);
  if (error !== undefined) {
    profile.status = "error";
    profile.lastError = error;
    delete store.busyProfiles[id];
    toast("error", "重新激活失败", error);
    return { ok: false, error };
  }
  profile.status = "active";
  profile.appliedAt = profile.savedAt;
  profile.lastError = undefined;
  delete store.busyProfiles[id];
  toast("success", "Profile 已重新激活", `运行实例会在下一条消息到来时重建。`);
  return { ok: true };
}

export async function deleteProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  const profile = profileById(id);
  if (profile === undefined) return { ok: false, error: "Profile 不存在。" };
  if (profile.status === "active" || profile.status === "activating" || profile.status === "stopping") {
    return { ok: false, error: "运行中的 Profile 不能删除。先停止。" };
  }
  store.busyProfiles[id] = "deleting";
  await wait(650);
  const index = store.profiles.findIndex((entry) => entry.id === id);
  if (index >= 0) store.profiles.splice(index, 1);
  for (let runtimeIndex = store.runtimes.length - 1; runtimeIndex >= 0; runtimeIndex -= 1) {
    if (store.runtimes[runtimeIndex].profileId === id) store.runtimes.splice(runtimeIndex, 1);
  }
  for (let sessionIndex = store.sessions.length - 1; sessionIndex >= 0; sessionIndex -= 1) {
    if (store.sessions[sessionIndex].profileId === id) {
      sessionData.delete(store.sessions[sessionIndex].id);
      store.sessions.splice(sessionIndex, 1);
    }
  }
  delete store.busyProfiles[id];
  toast("success", "Profile 已删除", "运行数据目录与关联会话已移除；历史用量与审计记录保留。");
  return { ok: true };
}

export async function wakeRuntime(id: string, prompt?: string): Promise<{ ok: boolean; merged?: boolean; error?: string }> {
  const runtime = runtimeById(id);
  if (runtime === undefined) return { ok: false, error: "运行实例不存在。" };
  store.busyRuntimes[id] = "waking";
  await wait(420);
  delete store.busyRuntimes[id];
  if (runtime.state === "running") {
    toast("info", "唤醒已合并", "运行实例当前正忙，请求会并入待处理的唤醒。");
    return { ok: true, merged: true };
  }
  turnSequence += 1;
  runtime.state = "running";
  runtime.activeTurnId = `turn-demo-${turnSequence.toString(36).padStart(3, "0")}`;
  runtime.lastActivity = Date.now();
  const session = sessionById(runtime.sessionId);
  if (session !== undefined) {
    session.state = "running";
    session.lastActivity = runtime.lastActivity;
  }
  if (prompt !== undefined && prompt.trim().length > 0) {
    toast("success", "已请求唤醒", `提示词会作为新轮次的起始 user 消息（${prompt.length} 字符）。`);
  } else {
    toast("success", "已请求唤醒", "新轮次会基于已存储的历史开启，不写入占位消息。");
  }
  window.setTimeout(() => {
    const current = runtimeById(id);
    if (current === undefined) return;
    current.state = "idle";
    current.activeTurnId = undefined;
    current.lastActivity = Date.now();
    const currentSession = sessionById(current.sessionId);
    if (currentSession !== undefined) {
      currentSession.state = "idle";
      currentSession.lastActivity = current.lastActivity;
    }
  }, 5200);
  return { ok: true };
}

export async function restartRuntime(id: string): Promise<{ ok: boolean; error?: string }> {
  const runtime = runtimeById(id);
  if (runtime === undefined) return { ok: false, error: "运行实例不存在。" };
  store.busyRuntimes[id] = "restarting";
  await wait(900);
  runtime.state = "idle";
  runtime.activeTurnId = undefined;
  runtime.error = undefined;
  runtime.createdAt = Date.now();
  runtime.lastActivity = Date.now();
  const session = sessionById(runtime.sessionId);
  if (session !== undefined) {
    session.state = "idle";
    session.lastActivity = runtime.lastActivity;
  }
  delete store.busyRuntimes[id];
  toast("success", "运行实例已重启", "实例 ID 与工作目录保持不变；会话日志继续使用原文件。");
  return { ok: true };
}

export async function stopRuntime(id: string): Promise<{ ok: boolean; error?: string }> {
  const runtime = runtimeById(id);
  if (runtime === undefined) return { ok: false, error: "运行实例不存在。" };
  store.busyRuntimes[id] = "stopping";
  await wait(700);
  const index = store.runtimes.findIndex((entry) => entry.id === id);
  if (index >= 0) store.runtimes.splice(index, 1);
  for (const session of store.sessions) {
    if (session.runtimeId === id) session.state = "stopped";
  }
  delete store.busyRuntimes[id];
  toast("success", "运行实例已停止", "会话日志与资源目录保留；该频道下次产生输入时会创建新实例。");
  return { ok: true };
}

export function aggregateUsage(records: readonly UsageRecord[]) {
  const recorded = records.filter((record) => record.source === "recorded");
  const totals = recorded.reduce(
    (accumulator, record) => {
      accumulator.input += record.input;
      accumulator.output += record.output;
      accumulator.cacheRead += record.cacheRead;
      accumulator.cacheWrite += record.cacheWrite;
      accumulator.reasoning += record.reasoning;
      accumulator.total += record.total;
      return accumulator;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
  );
  return { ...totals, calls: recorded.length, missing: records.length - recorded.length };
}

export function refreshCachePromptRows(): void {
  store.cache.prompt = buildPromptCacheRows(store.usageRecords);
}

export function resetFormDefaults(engine: string, family: "context" | "wakeup" | "toolcall"): Record<string, unknown> {
  if (family === "context") return defaultContextConfig(engine);
  if (family === "wakeup") return defaultWakeupConfig(engine);
  return defaultToolcallConfig(engine);
}

window.setTimeout(() => {
  store.sessionListLoading = false;
}, 620);
