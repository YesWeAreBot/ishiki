import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createGateway, type GatewayConfig, type GroupConfig, type ProviderConfig } from "@yesimagent/gateway";
import type Logger from "reggol";
import { parse, stringify } from "yaml";

import type Ishiki from "../index.js";
import { writeAtomic } from "./atomic.js";
import { modelsSchemas } from "./catalog.js";
import { collectSecrets, describeError, ManagementError, redact } from "./errors.js";
import type { ManagementEventBus } from "./events.js";
import type { AuditLog } from "./observability.js";
import type { GroupView, ModelDecl, ModelDeclView, ModelOption, ModelsConfigInput, ModelsDocument, ProviderInput, ProviderView, SecretState } from "./types.js";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function secretOf(apiKey: string | undefined): SecretState {
  if (typeof apiKey !== "string" || apiKey.length === 0) return { configured: false };
  if (apiKey.startsWith("${") && apiKey.endsWith("}")) return { configured: true, reference: apiKey };
  return { configured: true };
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

export class ModelsManager {
  private readonly file: string;

  constructor(
    private readonly host: Ishiki,
    private readonly events: ManagementEventBus,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
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
