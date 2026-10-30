import { GROUP_STRATEGIES, MODALITIES, MODEL_TYPES } from "@yesimagent/gateway";
import type { Context } from "koishi";
import Schema from "schemastery";

import { ContextEngine } from "../context/engine.js";
import { Extension } from "../extension.js";
import { CodemodeConfig, FailoverConfig, PacingConfig, ProfileConfig, TypingConfig, type ProfileConfig as ProfileConfigShape } from "../profile/index.js";
import { serviceName } from "../registry.js";
import { AttachmentConfig } from "../resource/config.js";
import { ToolcallEngine } from "../toolcall/engine.js";
import { WakeupEngine } from "../wakeup/engine.js";
import { serializeSchema, type SchemaNode } from "./schema.js";
import type { EngineDescriptor, EnginesDirectory, ExtensionDescriptor, ExtensionsDirectory, ModelsSchemas } from "./types.js";

const ENGINE_LABELS: Record<string, string> = {
  standard: "标准",
  jev: "Jev 判定",
  willingness: "响应意愿",
  native: "原生工具调用",
  hermes: "Hermes",
  qwen3coder: "Qwen3 Coder",
  "morph-xml": "Morph XML",
  "yaml-xml": "YAML XML",
  workspace: "工作区",
  "mcp-client": "MCP 客户端",
  "onebot-actions": "OneBot 动作",
};

const KNOWN_EXTENSIONS: Record<string, true> = {
  workspace: true,
  "mcp-client": true,
  "onebot-actions": true,
};

function labelOf(name: string): string {
  return ENGINE_LABELS[name] ?? name;
}

function engineConfig(engines: ReadonlyArray<{ name: string; Schema?: Schema<any> }>): Schema<any> {
  if (engines.length === 0) return Schema.any();
  return Schema.union(
    engines.map((engine) => {
      const dict: Record<string, Schema> = { engine: Schema.const(engine.name).required() };
      if (engine.Schema) dict[engine.name] = engine.Schema;
      return Schema.object(dict).description(labelOf(engine.name));
    }),
  );
}

function descriptor(name: string, schema: Schema<any> | undefined): EngineDescriptor {
  return { name, label: labelOf(name), schema: serializeSchema(schema), available: true };
}

export function modelsSchemas(apis: readonly string[]): ModelsSchemas {
  const api = apis.length > 0 ? Schema.union(apis.map((name) => Schema.const(name))) : Schema.string();

  const model = Schema.object({
    id: Schema.string().required().description("模型标识，profile 的 model 字段引用这个名称"),
    type: Schema.union(MODEL_TYPES.map((type) => Schema.const(type)))
      .default("language")
      .description("模型用途"),
    name: Schema.string().description("展示名称"),
    toolCall: Schema.boolean().description("支持工具调用"),
    reasoning: Schema.boolean().description("支持推理内容"),
    input: Schema.array(Schema.union(MODALITIES.map((modality) => Schema.const(modality)))).description("接受的输入类型"),
    thinking: Schema.object({
      mode: Schema.string().required().description("思考模式参数名"),
      efforts: Schema.array(Schema.string()).default([]).description("支持的思考档位"),
    }).description("思考档位声明"),
    contextWindow: Schema.number().description("上下文窗口 token 数"),
    maxTokens: Schema.number().description("单次输出 token 上限"),
    dimensions: Schema.number().description("向量维度，仅嵌入模型使用"),
  });

  const provider = Schema.object({
    api: api.required().description("供应商接口类型"),
    baseUrl: Schema.string().description("留空使用接口默认地址"),
    apiKey: Schema.string().role("secret").description("明文密钥或 ${环境变量} 引用；留空保持原有密钥"),
    headers: Schema.dict(Schema.string()).default({}).description("附加请求头"),
    settings: Schema.dict(Schema.any()).default({}).description("接口的附加设置"),
    models: Schema.array(model).default([]).description("该供应商声明的模型"),
  });

  const group = Schema.object({
    strategy: Schema.union(GROUP_STRATEGIES.map((strategy) => Schema.const(strategy)))
      .default("failover")
      .description("多个模型之间的选择方式"),
    models: Schema.array(Schema.string()).required().description("参与组合的模型引用"),
    circuitBreaker: Schema.object({
      failureThreshold: Schema.number().min(1).default(3).description("连续失败多少次后跳过"),
      cooldownSeconds: Schema.number().min(1).default(60).description("跳过持续时间（秒）"),
    }).description("故障熔断设置"),
  });

  return {
    provider: serializeSchema(provider)!,
    model: serializeSchema(model)!,
    group: serializeSchema(group)!,
  };
}

export function enginesDirectory(ctx: Context): EnginesDirectory {
  return {
    context: ContextEngine.list(ctx).map((engine) => descriptor(serviceName(engine) ?? engine.name, engine.Schema)),
    wakeup: WakeupEngine.list(ctx).map((engine) => descriptor(serviceName(engine) ?? engine.name, engine.Schema)),
    toolcall: ToolcallEngine.list(ctx).map((engine) => descriptor(serviceName(engine) ?? engine.name, engine.Schema)),
  };
}

export function extensionsDirectory(ctx: Context): ExtensionsDirectory {
  const engines = enginesDirectory(ctx);
  const profile = Schema.object({
    ...ProfileConfig.dict,
    context: engineConfig(engines.context).required(),
    wakeup: engineConfig(engines.wakeup).required(),
    toolcall: Schema.union([engineConfig(engines.toolcall), Schema.any()]),
  }) as unknown as Schema<ProfileConfigShape>;

  const extensions: ExtensionDescriptor[] = Extension.list(ctx)
    .map((extension) => ({
      name: extension.name.replace(/^ishiki\.ext\./, ""),
      schema: serializeSchema(extension.Schema),
      known: KNOWN_EXTENSIONS[extension.name.replace(/^ishiki\.ext\./, "")] === true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const { context: _context, wakeup: _wakeup, toolcall: _toolcall, extends: _extends, ...base } = ProfileConfig.dict ?? {};
  return {
    extensions,
    schemas: {
      base: serializeSchema(Schema.object(base))!,
      profile: serializeSchema(profile)!,
      failover: serializeSchema(FailoverConfig)!,
      codemode: serializeSchema(CodemodeConfig)!,
      pacing: serializeSchema(PacingConfig)!,
      typing: serializeSchema(TypingConfig)!,
      attachment: serializeSchema(AttachmentConfig)!,
    },
  };
}

export function profileSchemaNode(ctx: Context): SchemaNode {
  return extensionsDirectory(ctx).schemas.profile;
}
