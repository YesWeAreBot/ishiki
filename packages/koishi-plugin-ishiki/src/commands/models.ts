import type { Command, Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import type { ModelDecl, ProviderInput } from "../management/types.js";
import { confirm, hasAuthority, operatorOf, optionFlag, optionNumber, optionText, parseJsonArgument, positional, positionalText } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatGroupDetail, formatModelsList, formatProviderDetail } from "./format.js";

const READ = 2;
const SECRET = 4;

function declModelFromOptions(options: {
  type?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  toolCall?: boolean;
  reasoning?: boolean;
}): ModelDecl {
  const decl: ModelDecl = { id: "" };
  if (options.type !== undefined) decl.type = options.type;
  if (options.name !== undefined) decl.name = options.name;
  if (options.contextWindow !== undefined) decl.contextWindow = options.contextWindow;
  if (options.maxTokens !== undefined) decl.maxTokens = options.maxTokens;
  if (options.toolCall) decl.toolCall = true;
  if (options.reasoning) decl.reasoning = true;
  return decl;
}

export function registerModelCommands(_ctx: Context, host: Ishiki, root: Command, write: number): void {
  const models = host.management.models;
  const logger = host.logger;
  const model = root.subcommand(".model", "模型配置", { authority: READ });

  model
    .subcommand(".list", "供应商与模型组一览（密钥只显示配置状态）", { authority: READ })
    .option("provider", "-p <provider>")
    .action(wrapAction(logger, async (argv) => formatModelsList(await models.read(), optionText(argv, "provider"))));

  model.subcommand(".show <ref>", "供应商、模型或模型组详情", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const ref = positional(argv, 0);
      if (ref === undefined) throw new ManagementError("invalid", "请提供模型引用（provider、provider:modelId 或组名）");
      const document = await models.read();
      const provider = document.providers.find((entry) => entry.id === ref);
      if (provider !== undefined) return formatProviderDetail(provider);
      const group = document.groups.find((entry) => entry.name === ref);
      if (group !== undefined) return formatGroupDetail(group);
      if (ref.includes(":")) {
        const providerId = ref.slice(0, ref.indexOf(":"));
        const modelId = ref.slice(ref.indexOf(":") + 1);
        const decl = document.providers.find((entry) => entry.id === providerId)?.models.find((entry) => entry.id === modelId);
        if (decl !== undefined) {
          const extras = [
            `类型 ${decl.type}`,
            decl.contextWindow === undefined ? undefined : `窗口 ${decl.contextWindow}`,
            decl.maxTokens === undefined ? undefined : `输出上限 ${decl.maxTokens}`,
            decl.toolCall ? "支持工具调用" : undefined,
            decl.reasoning ? "支持推理" : undefined,
          ].filter((item): item is string => item !== undefined);
          return `模型 ${decl.reference}${decl.name === undefined ? "" : `（${decl.name}）`}：${extras.join(" · ")}`;
        }
      }
      throw new ManagementError("not-found", `未找到 ${ref}，可用引用见 ishiki.model.list`);
    }),
  );

  model.subcommand(".test <ref>", "经网关发一次最小请求，回报时延与结果（消耗少量配额）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const ref = positional(argv, 0);
      if (ref === undefined) throw new ManagementError("invalid", "请提供模型引用");
      const result = await models.probe(ref, operatorOf(argv.session));
      return result.ok
        ? `连接正常，时延 ${result.latencyMs} ms${result.detail === undefined || result.detail.length === 0 ? "" : `，返回：${result.detail}`}`
        : `连接失败（${result.latencyMs} ms）：${result.detail ?? "未知原因"}`;
    }),
  );

  const provider = model.subcommand(".provider", "供应商管理");

  provider
    .subcommand(".add <id> <api>", "添加供应商", { authority: write })
    .option("baseUrl", "--base-url <url>")
    .option("apiKey", "--api-key <key>", { authority: SECRET })
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        const api = positional(argv, 1);
        if (id === undefined || api === undefined)
          throw new ManagementError("invalid", "用法：ishiki.model.provider.add <id> <api> [--base-url <url>] [--api-key <key>]");
        const input: ProviderInput = { api, baseUrl: optionText(argv, "baseUrl"), apiKey: optionText(argv, "apiKey") };
        await models.addProvider(id, input, operatorOf(argv.session));
        return `已添加供应商 ${id}（${api}）`;
      }),
    );

  provider.subcommand(".set <id> <field> <value...>", "修改供应商字段（api/baseUrl/apiKey/headers/settings）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const field = positional(argv, 1);
      const text = positionalText(argv, 2);
      if (id === undefined || field === undefined || text === undefined) {
        throw new ManagementError("invalid", "用法：ishiki.model.provider.set <id> <field> <value>");
      }
      if (field !== "api" && field !== "baseUrl" && field !== "apiKey" && field !== "headers" && field !== "settings") {
        throw new ManagementError("invalid", "field 只能是 api、baseUrl、apiKey、headers 或 settings");
      }
      if (field === "apiKey" && !hasAuthority(argv.session, SECRET)) return "权限不足";
      const value = field === "headers" || field === "settings" ? parseJsonArgument(text, field) : text;
      await models.setProviderField(id, field, value, operatorOf(argv.session));
      return `已修改供应商 ${id} 的 ${field}`;
    }),
  );

  provider.subcommand(".remove <id>", "删除供应商（被引用时拒绝并列出引用）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供供应商标识");
      const operator = operatorOf(argv.session);
      const references = await models.references(id);
      if (references.profiles.length > 0 || references.runtimes.length > 0) {
        await models.removeProvider(id, operator);
        return;
      }
      if (argv.session === undefined) throw new ManagementError("rejected", "该操作需要会话确认");
      const modelCount = (await models.read()).providers.find((entry) => entry.id === id)?.models.length ?? 0;
      const proceed = await confirm(argv.session, `将删除供应商 ${id} 及其 ${modelCount} 个模型声明`);
      if (proceed !== true) return proceed;
      await models.removeProvider(id, operator);
      return `已删除供应商 ${id}`;
    }),
  );

  const decl = model.subcommand(".decl", "模型声明管理");

  decl
    .subcommand(".add <provider> <id>", "添加模型声明", { authority: write })
    .option("type", "--type <type>")
    .option("name", "--name <name>")
    .option("contextWindow", "--context-window <n:number>")
    .option("maxTokens", "--max-tokens <n:number>")
    .option("toolCall", "--tool-call")
    .option("reasoning", "--reasoning")
    .action(
      wrapAction(logger, async (argv) => {
        const providerId = positional(argv, 0);
        const modelId = positional(argv, 1);
        if (providerId === undefined || modelId === undefined) throw new ManagementError("invalid", "用法：ishiki.model.decl.add <provider> <id> [选项]");
        const input = declModelFromOptions({
          type: optionText(argv, "type"),
          name: optionText(argv, "name"),
          contextWindow: optionNumber(argv, "contextWindow"),
          maxTokens: optionNumber(argv, "maxTokens"),
          toolCall: optionFlag(argv, "toolCall"),
          reasoning: optionFlag(argv, "reasoning"),
        });
        input.id = modelId;
        await models.addDecl(providerId, input, operatorOf(argv.session));
        return `已添加模型 ${providerId}:${modelId}`;
      }),
    );

  decl.subcommand(".set <provider> <id> <field> <value...>", "修改模型声明字段", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const providerId = positional(argv, 0);
      const modelId = positional(argv, 1);
      const field = positional(argv, 2);
      const text = positionalText(argv, 3);
      if (providerId === undefined || modelId === undefined || field === undefined || text === undefined) {
        throw new ManagementError("invalid", "用法：ishiki.model.decl.set <provider> <id> <field> <value>");
      }
      await models.setDeclField(providerId, modelId, field, coerceDeclValue(field, text), operatorOf(argv.session));
      return `已修改模型 ${providerId}:${modelId} 的 ${field}`;
    }),
  );

  decl.subcommand(".remove <provider> <id>", "删除模型声明（被引用时拒绝并列出引用）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const providerId = positional(argv, 0);
      const modelId = positional(argv, 1);
      if (providerId === undefined || modelId === undefined) throw new ManagementError("invalid", "请提供供应商与模型标识");
      const operator = operatorOf(argv.session);
      const reference = `${providerId}:${modelId}`;
      const references = await models.references(reference);
      if (references.profiles.length > 0 || references.runtimes.length > 0) {
        await models.removeDecl(providerId, modelId, operator);
        return;
      }
      if (argv.session === undefined) throw new ManagementError("rejected", "该操作需要会话确认");
      const proceed = await confirm(argv.session, `将删除模型 ${reference}`);
      if (proceed !== true) return proceed;
      await models.removeDecl(providerId, modelId, operator);
      return `已删除模型 ${reference}`;
    }),
  );

  const group = model.subcommand(".group", "模型组管理");

  group
    .subcommand(".add <name>", "添加模型组", { authority: write })
    .option("strategy", "--strategy <strategy>")
    .option("models", "--models <models>")
    .action(
      wrapAction(logger, async (argv) => {
        const name = positional(argv, 0);
        if (name === undefined) throw new ManagementError("invalid", "请提供模型组名称");
        const members =
          optionText(argv, "models")
            ?.split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0) ?? [];
        await models.addGroup(name, { name, strategy: optionText(argv, "strategy"), models: members }, operatorOf(argv.session));
        return `已添加模型组 ${name}${members.length === 0 ? "" : `（${members.join("、")}）`}`;
      }),
    );

  group.subcommand(".set <name> <field> <value...>", "修改模型组字段（strategy/models）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const name = positional(argv, 0);
      const field = positional(argv, 1);
      const text = positionalText(argv, 2);
      if (name === undefined || field === undefined || text === undefined)
        throw new ManagementError("invalid", "用法：ishiki.model.group.set <name> <field> <value>");
      if (field !== "strategy" && field !== "models") throw new ManagementError("invalid", "field 只能是 strategy 或 models");
      const value =
        field === "models"
          ? text
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : text;
      await models.setGroupField(name, field, value, operatorOf(argv.session));
      return `已修改模型组 ${name} 的 ${field}`;
    }),
  );

  group.subcommand(".remove <name>", "删除模型组（被引用时拒绝并列出引用）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const name = positional(argv, 0);
      if (name === undefined) throw new ManagementError("invalid", "请提供模型组名称");
      const operator = operatorOf(argv.session);
      const references = await models.references(name);
      if (references.profiles.length > 0 || references.runtimes.length > 0) {
        await models.removeGroup(name, operator);
        return;
      }
      if (argv.session === undefined) throw new ManagementError("rejected", "该操作需要会话确认");
      const proceed = await confirm(argv.session, `将删除模型组 ${name}`);
      if (proceed !== true) return proceed;
      await models.removeGroup(name, operator);
      return `已删除模型组 ${name}`;
    }),
  );
}

function coerceDeclValue(field: string, text: string): unknown {
  if (field === "toolCall" || field === "reasoning") return text === "true" || text === "1";
  if (field === "contextWindow" || field === "maxTokens" || field === "dimensions") {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new ManagementError("invalid", `${field} 需要是数字`);
    return value;
  }
  if (field === "input")
    return text
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  if (field === "name" || field === "type") return text;
  throw new ManagementError("invalid", `不支持的字段: ${field}，嵌套结构请在控制台编辑`);
}
