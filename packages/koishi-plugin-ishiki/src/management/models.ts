import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { generateText, type LanguageModelV4 } from "@yesimagent/core";
import { createGateway, GROUP_STRATEGIES, type GatewayConfig, type GroupConfig, type ProviderConfig } from "@yesimagent/gateway";
import type Logger from "reggol";
import { parse, stringify } from "yaml";

import type Ishiki from "../index.js";
import { readProfileRaw } from "../profile/index.js";
import { ChangeQueue, digest, writeAtomic } from "./atomic.js";
import { modelsSchemas } from "./catalog.js";
import { collectSecrets, describeError, ManagementError, redact } from "./errors.js";
import type { ManagementEventBus } from "./events.js";
import type { AuditLog } from "./observability.js";
import type { RuntimesManager } from "./runtimes.js";
import type {
  GroupView,
  ModelDecl,
  ModelDeclView,
  ModelOption,
  ModelsConfigInput,
  ModelsDocument,
  ProviderInput,
  ProviderView,
  RemoteModelInfo,
  RemoteModelsDocument,
  RemoteModelsQuery,
  SecretState,
} from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DECL_FIELDS = new Set(["type", "name", "toolCall", "reasoning", "input", "thinking", "contextWindow", "maxTokens", "dimensions"]);

/** 窄修改在内存里改动的可变草稿；落盘前经 normalize 重建为正式 GatewayConfig。 */
interface MutableConfig {
  providers?: Record<string, MutableProvider>;
  groups?: Record<string, MutableGroup>;
}

interface MutableProvider {
  api: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
  models?: ModelDecl[];
}

interface MutableGroup {
  strategy?: GroupConfig["strategy"];
  models: string[];
  circuitBreaker?: GroupConfig["circuitBreaker"];
}

function secretOf(apiKey: string | undefined): SecretState {
  if (typeof apiKey !== "string" || apiKey.length === 0) return { configured: false };
  if (apiKey.startsWith("${") && apiKey.endsWith("}")) return { configured: true, reference: apiKey };
  return { configured: true };
}

/** 网关用 `${NAME}` 引用环境变量；在线名单请求需要同样的展开规则。 */
function expandReference(value: string, where: string): string {
  if (!value.startsWith("${") || !value.endsWith("}")) return value;
  const name = value.slice(2, -1);
  const resolved = process.env[name];
  if (resolved === undefined || resolved.length === 0) {
    throw new ManagementError("invalid", `${where}: 环境变量 ${name} 未设置`);
  }
  return resolved;
}

interface RemoteEndpoint {
  url: string;
  headers: Record<string, string>;
}

/** 各接口方言对应的 /models 端点；baseUrl 缺省时使用该方言的默认地址。 */
function remoteEndpoint(api: string, baseUrl: string | undefined, apiKey: string): RemoteEndpoint {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
      return { url: `${baseUrl ?? "https://api.openai.com/v1"}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "typesafe-ai":
      if (baseUrl === undefined) throw new ManagementError("invalid", "typesafe-ai 需要填写 baseUrl 才能获取在线模型名单");
      return { url: `${baseUrl.replace(/\/$/, "")}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic-messages":
      return {
        url: `${baseUrl ?? "https://api.anthropic.com/v1"}/models?limit=1000`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      };
    case "google-generative-ai":
      return {
        url: `${baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
        headers: {},
      };
    default:
      throw new ManagementError("invalid", `接口类型 ${api} 不支持在线模型名单`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 把各家 /models 响应映射为统一的 RemoteModelInfo；字段缺失时原样省略。 */
function parseRemoteModels(api: string, payload: unknown): RemoteModelInfo[] {
  if (!isRecord(payload)) throw new ManagementError("failed", "模型名单响应不是 JSON 对象");
  const rows: RemoteModelInfo[] = [];
  if (api === "google-generative-ai") {
    const models = payload.models;
    if (!Array.isArray(models)) throw new ManagementError("failed", "模型名单响应缺少 models 数组");
    for (const item of models) {
      if (!isRecord(item)) continue;
      const raw = text(item.name);
      if (raw === undefined) continue;
      rows.push({
        id: raw.replace(/^models\//, ""),
        name: text(item.displayName),
        contextWindow: positiveNumber(item.inputTokenLimit),
        maxTokens: positiveNumber(item.outputTokenLimit),
      });
    }
    return rows;
  }
  const data = payload.data;
  if (!Array.isArray(data)) throw new ManagementError("failed", "模型名单响应缺少 data 数组");
  for (const item of data) {
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (id === undefined) continue;
    if (text(item.type) !== undefined && text(item.type) !== "model") continue;
    rows.push({ id, name: text(item.display_name) });
  }
  return rows;
}

function modelViews(providerId: string, models: readonly ModelDecl[] | undefined): ModelDeclView[] {
  return (models ?? []).map((model) => ({
    ...model,
    type: model.type ?? "language",
    reference: `${providerId}:${model.id}`,
    provider: providerId,
  }));
}

function optionsOf(config: GatewayConfig): ModelOption[] {
  const options: ModelOption[] = [];
  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    for (const model of provider.models ?? []) {
      const reference = `${providerId}:${model.id}`;
      options.push({
        reference,
        label: model.name ?? reference,
        kind: "model",
        type: model.type ?? "language",
        provider: providerId,
      });
    }
  }
  for (const name of Object.keys(config.groups ?? {})) {
    options.push({ reference: name, label: name, kind: "group" });
  }
  return options;
}

function normalize(input: ModelsConfigInput, previous: GatewayConfig): GatewayConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, source] of Object.entries(input.providers)) {
    const provider = source as ProviderInput;
    const old = previous.providers?.[id];
    const apiKey = provider.apiKey !== undefined && provider.apiKey.length > 0 ? provider.apiKey : old?.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ManagementError("invalid", `供应商 "${id}" 缺少密钥`, { field: `providers.${id}.apiKey` });
    }
    providers[id] = {
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey,
      headers: provider.headers,
      settings: provider.settings,
      models: (provider.models ?? []).map((model) => ({ ...model, type: model.type ?? "language" })),
    } as ProviderConfig;
  }

  const groups: Record<string, GroupConfig> = {};
  for (const [name, source] of Object.entries(input.groups)) {
    const group = source as GroupView;
    groups[name] = {
      strategy: group.strategy as GroupConfig["strategy"],
      models: group.models,
      circuitBreaker: group.circuitBreaker,
    };
  }
  return { providers, groups };
}

function providerViews(config: GatewayConfig): ProviderView[] {
  return Object.entries(config.providers ?? {}).map(([id, provider]) => ({
    id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: secretOf(provider.apiKey),
    headers: { ...provider.headers },
    settings: { ...provider.settings },
    models: modelViews(id, provider.models as readonly ModelDecl[] | undefined),
  }));
}

function groupViews(config: GatewayConfig): GroupView[] {
  return Object.entries(config.groups ?? {}).map(([name, group]) => ({
    name,
    strategy: group.strategy,
    models: [...group.models],
    circuitBreaker: group.circuitBreaker,
  }));
}

/** 删除目标会带走的一组模型引用；undefined 表示目标不存在。 */
function coveredReferences(config: GatewayConfig, ref: string): string[] | undefined {
  const provider = config.providers?.[ref];
  if (provider !== undefined) return (provider.models ?? []).map((model) => `${ref}:${model.id}`);
  if (ref.includes(":")) {
    const providerId = ref.slice(0, ref.indexOf(":"));
    const modelId = ref.slice(ref.indexOf(":") + 1);
    if (config.providers?.[providerId]?.models?.some((model) => model.id === modelId)) return [ref];
    return undefined;
  }
  const group = config.groups?.[ref];
  return group === undefined ? undefined : [...group.models];
}

/** 一个 model 字段（模型引用或组名）是否落在删除目标的覆盖范围内。 */
function fieldReferences(config: GatewayConfig, field: string, ref: string, covered: readonly string[]): boolean {
  if (field === ref || covered.includes(field)) return true;
  const group = config.groups?.[field];
  if (group === undefined) return false;
  return group.models.some((member) => member === ref || covered.includes(member));
}

export class ModelsManager {
  private readonly file: string;
  private readonly changes = new ChangeQueue();

  constructor(
    private readonly host: Ishiki,
    private readonly events: ManagementEventBus,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
    private readonly runtimes: RuntimesManager,
  ) {
    this.file = path.join(host.dataPath, "models.yaml");
  }

  async read(): Promise<ModelsDocument> {
    const text = await this.readText();
    const config = this.parse(text);
    return this.document(text, config);
  }

  async validate(input: ModelsConfigInput): Promise<{ config: ModelsConfigInput; options: ModelOption[] }> {
    const previous = this.parse(await this.readText());
    const config = normalize(input, previous);
    this.build(config);
    return { config: input, options: optionsOf(config) };
  }

  async save(input: ModelsConfigInput, revision: string, operator: string): Promise<ModelsDocument> {
    return this.changes.run(() => this.saveNow(input, revision, operator));
  }

  async references(ref: string): Promise<{ profiles: string[]; runtimes: string[] }> {
    const config = this.parse(await this.readText());
    const covered = coveredReferences(config, ref);
    if (covered === undefined) throw new ManagementError("not-found", `模型引用不存在: ${ref}`);

    const profilesRoot = path.join(this.host.dataPath, "profiles");
    const profiles: string[] = [];
    for (const entry of await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const raw = await readProfileRaw(profilesRoot, entry.name);
      if (raw === undefined) continue;
      const model = typeof raw.model === "string" ? raw.model : "";
      if (model.length > 0 && fieldReferences(config, model, ref, covered)) profiles.push(entry.name);
    }
    const runtimes = this.runtimes
      .list()
      .filter((view) => view.model.length > 0 && fieldReferences(config, view.model, ref, covered))
      .map((view) => view.id);
    return { profiles, runtimes };
  }

  async addProvider(id: string, input: ProviderInput, operator: string): Promise<ModelsDocument> {
    if (!ID_PATTERN.test(id)) throw new ManagementError("invalid", `供应商标识无效: ${id}`);
    if (input.api.length === 0) throw new ManagementError("invalid", `供应商 ${id} 缺少 api 类型`);
    if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
      throw new ManagementError("invalid", `供应商 ${id} 缺少密钥，提供明文或 \${ENV} 引用后再添加`);
    }
    return this.commit(`添加供应商 ${id}`, operator, (config) => {
      if (config.providers?.[id] !== undefined) throw new ManagementError("invalid", `供应商 ${id} 已存在`);
      (config.providers ??= {})[id] = {
        api: input.api,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        headers: input.headers,
        settings: input.settings,
        models: input.models ?? [],
      };
    });
  }

  async setProviderField(id: string, field: "api" | "baseUrl" | "apiKey" | "headers" | "settings", value: unknown, operator: string): Promise<ModelsDocument> {
    return this.commit(`修改供应商 ${id}`, operator, (config) => {
      const provider = this.providerOf(config, id);
      if (field === "api" && (typeof value !== "string" || value.length === 0)) throw new ManagementError("invalid", "api 必须是非空字符串");
      if (field === "baseUrl" && value !== undefined && typeof value !== "string") throw new ManagementError("invalid", "baseUrl 必须是字符串");
      if (field === "apiKey" && (typeof value !== "string" || value.length === 0)) {
        throw new ManagementError("invalid", "apiKey 需要新明文或 ${ENV} 引用，不能置空");
      }
      if ((field === "headers" || field === "settings") && (typeof value !== "object" || value === null || Array.isArray(value))) {
        throw new ManagementError("invalid", `${field} 需要是对象`);
      }
      switch (field) {
        case "api":
          provider.api = value as string;
          break;
        case "baseUrl":
          provider.baseUrl = value as string | undefined;
          break;
        case "apiKey":
          provider.apiKey = value as string;
          break;
        case "headers":
          provider.headers = value as Record<string, string>;
          break;
        case "settings":
          provider.settings = value as Record<string, unknown>;
          break;
        default:
          break;
      }
    });
  }

  async removeProvider(id: string, operator: string): Promise<ModelsDocument> {
    await this.assertNotReferenced(id, `供应商 ${id}`);
    return this.commit(`删除供应商 ${id}`, operator, (config) => {
      this.providerOf(config, id);
      this.assertGroupFree(config, `供应商 ${id}`, (member) => member.startsWith(`${id}:`));
      delete config.providers?.[id];
    });
  }

  async addDecl(provider: string, decl: ModelDecl, operator: string): Promise<ModelsDocument> {
    if (decl.id.length === 0) throw new ManagementError("invalid", "模型标识不能为空");
    return this.commit(`添加模型 ${provider}:${decl.id}`, operator, (config) => {
      const target = this.providerOf(config, provider);
      if ((target.models ?? []).some((model) => model.id === decl.id)) throw new ManagementError("invalid", `模型 ${provider}:${decl.id} 已存在`);
      (target.models ??= []).push({ ...decl, type: decl.type ?? "language" });
    });
  }

  async setDeclField(provider: string, modelId: string, field: string, value: unknown, operator: string): Promise<ModelsDocument> {
    if (!DECL_FIELDS.has(field)) throw new ManagementError("invalid", `不支持的字段: ${field}`);
    return this.commit(`修改模型 ${provider}:${modelId}`, operator, (config) => {
      const decl = this.declOf(config, provider, modelId);
      (decl as unknown as Record<string, unknown>)[field] = value;
    });
  }

  async removeDecl(provider: string, modelId: string, operator: string): Promise<ModelsDocument> {
    const reference = `${provider}:${modelId}`;
    await this.assertNotReferenced(reference, `模型 ${reference}`);
    return this.commit(`删除模型 ${reference}`, operator, (config) => {
      this.declOf(config, provider, modelId);
      this.assertGroupFree(config, `模型 ${reference}`, (member) => member === reference);
      const target = this.providerOf(config, provider);
      target.models = (target.models ?? []).filter((model) => model.id !== modelId);
    });
  }

  async addGroup(name: string, group: GroupView, operator: string): Promise<ModelsDocument> {
    if (!ID_PATTERN.test(name)) throw new ManagementError("invalid", `模型组名称无效: ${name}`);
    return this.commit(`添加模型组 ${name}`, operator, (config) => {
      if (config.groups?.[name] !== undefined) throw new ManagementError("invalid", `模型组 ${name} 已存在`);
      if (group.strategy !== undefined && !GROUP_STRATEGIES.includes(group.strategy as (typeof GROUP_STRATEGIES)[number])) {
        throw new ManagementError("invalid", `策略无效: ${group.strategy}`);
      }
      (config.groups ??= {})[name] = { strategy: group.strategy as GroupConfig["strategy"], models: [...group.models], circuitBreaker: group.circuitBreaker };
    });
  }

  async setGroupField(name: string, field: "strategy" | "models", value: unknown, operator: string): Promise<ModelsDocument> {
    return this.commit(`修改模型组 ${name}`, operator, (config) => {
      const group = this.groupOf(config, name);
      if (field === "strategy") {
        if (typeof value !== "string" || !GROUP_STRATEGIES.includes(value as (typeof GROUP_STRATEGIES)[number])) {
          throw new ManagementError("invalid", `策略无效: ${String(value)}`);
        }
        group.strategy = value as GroupConfig["strategy"];
      } else {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ManagementError("invalid", "models 需要是模型引用列表");
        group.models = [...value];
      }
    });
  }

  async removeGroup(name: string, operator: string): Promise<ModelsDocument> {
    await this.assertNotReferenced(name, `模型组 ${name}`);
    return this.commit(`删除模型组 ${name}`, operator, (config) => {
      this.groupOf(config, name);
      delete config.groups?.[name];
    });
  }

  async probe(ref: string, operator: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    let model: LanguageModelV4;
    try {
      model = this.host.gateway.languageModel(ref);
    } catch (error) {
      throw new ManagementError("not-found", describeError(error).message);
    }
    const started = Date.now();
    let result: { ok: boolean; latencyMs: number; detail?: string };
    try {
      const generated = await generateText({ model, prompt: "ping" });
      result = { ok: true, latencyMs: Date.now() - started, detail: generated.text.slice(0, 80) };
    } catch (error) {
      result = { ok: false, latencyMs: Date.now() - started, detail: describeError(error).message };
    }
    await this.audit.append({
      kind: "models.probe",
      operator,
      summary: `连接测试 ${ref}`,
      result: result.ok ? "ok" : "failed",
      target: ref,
      detail: { latencyMs: result.latencyMs },
    });
    return result;
  }

  /**
   * 拉取提供商的在线模型名单。凭据只在服务端展开与使用，明文不会进入返回值或日志。
   * providerId 与 draft 二选一：前者使用已保存配置，后者用于尚未落盘的供应商草稿。
   */
  async listRemote(query: RemoteModelsQuery): Promise<RemoteModelsDocument> {
    let provider: string;
    let api: string;
    let baseUrl: string | undefined;
    let apiKey: string;
    let extraHeaders: Record<string, string> = {};

    if (query.providerId !== undefined) {
      const saved = this.parse(await this.readText()).providers?.[query.providerId];
      if (saved === undefined) throw new ManagementError("not-found", `供应商 ${query.providerId} 不存在`);
      provider = query.providerId;
      api = saved.api;
      baseUrl = saved.baseUrl;
      apiKey = saved.apiKey;
      extraHeaders = { ...saved.headers };
    } else if (query.draft !== undefined) {
      if (query.draft.api.length === 0) throw new ManagementError("invalid", "供应商草稿缺少接口类型");
      if (query.draft.apiKey.length === 0) throw new ManagementError("invalid", "供应商草稿缺少 API 密钥");
      provider = "draft";
      api = query.draft.api;
      baseUrl = query.draft.baseUrl;
      apiKey = query.draft.apiKey;
      extraHeaders = { ...query.draft.headers };
    } else {
      throw new ManagementError("invalid", "缺少 providerId 或供应商草稿");
    }

    apiKey = expandReference(apiKey, `providers.${provider}.apiKey`);
    for (const [name, value] of Object.entries(extraHeaders)) {
      extraHeaders[name] = expandReference(value, `providers.${provider}.headers.${name}`);
    }
    const endpoint = remoteEndpoint(api, baseUrl?.replace(/\/$/, ""), apiKey);
    let response: Response;
    try {
      response = await fetch(endpoint.url, { headers: { ...extraHeaders, ...endpoint.headers }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      // 端点 URL 可能内嵌凭据，错误信息不回显 URL。
      throw new ManagementError("failed", `请求模型名单接口失败: ${describeError(error).message}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 200);
      throw new ManagementError("failed", `获取模型名单失败: HTTP ${response.status}${body.length > 0 ? ` ${body}` : ""}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ManagementError("failed", `模型名单响应无法解析为 JSON: ${describeError(error).message}`);
    }
    const seen = new Set<string>();
    const models = parseRemoteModels(api, payload)
      .filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    return { provider, models };
  }

  private async saveNow(input: ModelsConfigInput, revision: string, operator: string): Promise<ModelsDocument> {
    try {
      const text = await this.readText();
      if (digest(text) !== revision) {
        throw new ManagementError("conflict", "模型配置已被其他操作者修改，请刷新后重试");
      }
      const previous = this.parse(text);
      const config = normalize(input, previous);
      this.build(config);
      const next = stringify(config, { lineWidth: 0 });
      await writeAtomic(this.file, next);

      try {
        this.host.gateway.reconfigure(config);
      } catch (error) {
        await writeAtomic(this.file, text);
        throw new ManagementError("failed", redact(`网关重新配置失败: ${describeError(error).message}`, collectSecrets(config)));
      }

      const document = this.document(next, config);
      this.logger.info("models configuration saved");
      await this.audit.append({
        kind: "models.save",
        operator,
        summary: "保存模型配置",
        result: "ok",
        target: this.file,
        revision: document.revision,
        detail: {
          providers: document.providers.map((provider) => provider.id),
          groups: document.groups.map((group) => group.name),
        },
      });
      this.events.emit("models.changed", {
        revision: document.revision,
        providers: document.providers.map((provider) => provider.id),
        groups: document.groups.map((group) => group.name),
        models: document.options.map((option) => option.reference),
      });
      return document;
    } catch (error) {
      await this.audit.append({
        kind: "models.save",
        operator,
        summary: "保存模型配置",
        result: "failed",
        target: this.file,
        revision,
        error: redact(describeError(error).message, collectSecrets(input)),
      });
      throw error;
    }
  }

  /** 窄修改统一入口：队列内读最新文本、改副本、干跑校验、落盘、重配网关、审计、事件。 */
  private commit(summary: string, operator: string, mutate: (config: MutableConfig) => void): Promise<ModelsDocument> {
    return this.changes.run(async () => {
      let text = "";
      try {
        text = await this.readText();
        const previous = this.parse(text);
        const draft = structuredClone(previous) as unknown as MutableConfig;
        mutate(draft);
        const config = normalize({ providers: draft.providers ?? {}, groups: draft.groups ?? {} } as unknown as ModelsConfigInput, previous);
        this.build(config);
        const next = stringify(config, { lineWidth: 0 });
        await writeAtomic(this.file, next);

        try {
          this.host.gateway.reconfigure(config);
        } catch (error) {
          await writeAtomic(this.file, text);
          throw new ManagementError("failed", redact(`网关重新配置失败: ${describeError(error).message}`, collectSecrets(config)));
        }

        const document = this.document(next, config);
        this.logger.info(`models configuration updated: ${summary}`);
        await this.audit.append({
          kind: "models.save",
          operator,
          summary,
          result: "ok",
          target: this.file,
          revision: document.revision,
        });
        this.events.emit("models.changed", {
          revision: document.revision,
          providers: document.providers.map((provider) => provider.id),
          groups: document.groups.map((group) => group.name),
          models: document.options.map((option) => option.reference),
        });
        return document;
      } catch (error) {
        await this.audit.append({
          kind: "models.save",
          operator,
          summary,
          result: "failed",
          target: this.file,
          error: redact(describeError(error).message, []),
        });
        throw error;
      }
    });
  }

  private providerOf(config: MutableConfig, id: string): MutableProvider {
    const provider = config.providers?.[id];
    if (provider === undefined) throw new ManagementError("not-found", `供应商 ${id} 不存在`);
    return provider;
  }

  private declOf(config: MutableConfig, providerId: string, modelId: string): ModelDecl {
    const provider = this.providerOf(config, providerId);
    const decl = (provider.models ?? []).find((model) => model.id === modelId);
    if (decl === undefined) throw new ManagementError("not-found", `模型 ${providerId}:${modelId} 不存在`);
    return decl;
  }

  private groupOf(config: MutableConfig, name: string): MutableGroup {
    const group = config.groups?.[name];
    if (group === undefined) throw new ManagementError("not-found", `模型组 ${name} 不存在`);
    return group;
  }

  /** 删除前置检查：任何 Profile（含未激活的磁盘配置）或 RuntimeMeta 引用目标即拒绝并列出清单。 */
  private async assertNotReferenced(ref: string, label: string): Promise<void> {
    const { profiles, runtimes } = await this.references(ref);
    if (profiles.length === 0 && runtimes.length === 0) return;
    const parts: string[] = [];
    if (profiles.length > 0) parts.push(`Profile ${profiles.join("、")}`);
    if (runtimes.length > 0) parts.push(`Runtime ${runtimes.join("、")}`);
    throw new ManagementError("rejected", `${label} 被引用（${parts.join("；")}），清理引用后重试`);
  }

  private assertGroupFree(config: MutableConfig, label: string, memberHits: (member: string) => boolean): void {
    const groups = Object.entries(config.groups ?? {}).filter(([, group]) => group.models.some(memberHits));
    if (groups.length > 0) {
      throw new ManagementError("rejected", `${label} 被模型组 ${groups.map(([name]) => name).join("、")} 引用，先调整模型组`);
    }
  }

  private build(config: GatewayConfig): void {
    try {
      createGateway({ config: structuredClone(config) });
    } catch (error) {
      throw new ManagementError("invalid", redact(describeError(error).message, collectSecrets(config)));
    }
  }

  private document(text: string, config: GatewayConfig): ModelsDocument {
    return {
      revision: digest(text),
      providers: providerViews(config),
      groups: groupViews(config),
      options: optionsOf(config),
      schemas: modelsSchemas(this.host.gateway.apis),
      readAt: Date.now(),
    };
  }

  private async readText(): Promise<string> {
    try {
      return await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new ManagementError("failed", `无法读取模型配置: ${describeError(error).message}`);
    }
  }

  private parse(text: string): GatewayConfig {
    try {
      return (parse(text) ?? {}) as GatewayConfig;
    } catch (error) {
      throw new ManagementError("invalid", `模型配置无法解析: ${describeError(error).message}`);
    }
  }
}
