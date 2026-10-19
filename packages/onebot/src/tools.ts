import type { Bot } from "koishi";
import { jsonSchema, tool, type ExtensionContext, type ResourceCenter, type ToolSet } from "koishi-plugin-ishiki";

import { actionsFor, categoriesFor, search, type LiteAction } from "./catalog/index.js";
import { liteOf, renderAction } from "./catalog/render.js";
import type { Backend, CatalogAction, Mode } from "./catalog/types.js";
import type { MediaPublisher } from "./media.js";
import { resolveParams } from "./params.js";

interface TargetInput {
  action: string;
  params?: Record<string, unknown>;
  account?: string;
}

export interface ToolOptions {
  ctx: ExtensionContext["fiber"];
  domain: ExtensionContext["domain"];
  backend: Backend;
  mode: Mode;
  deny: readonly string[];
  resources: ResourceCenter;
  publisher: MediaPublisher;
  maxInlineBytes: number;
  baseUrl?: string;
  logger: ExtensionContext["logger"];
}

/** 该 profile 里可用的账号：频道模式只有一个，cross 模式是认领名单里的全部。 */
function accountsOf(domain: ExtensionContext["domain"]): string[] {
  return domain.mode === "channel" ? [`${domain.platform}:${domain.selfId}`] : [...domain.channels.keys()];
}

/** 适配器把原始请求挂在 bot.internal 上；只有它确实是函数时才敢调用。 */
function requestOf(bot: Bot): (action: string, params: Record<string, unknown>) => Promise<unknown> {
  const sid = bot.sid;
  if (!("internal" in bot)) throw new Error(`机器人 ${sid} 不是 OneBot 适配器实例`);
  const internal: unknown = bot.internal;
  if (internal === null || typeof internal !== "object" || !("_request" in internal)) {
    throw new Error(`机器人 ${sid} 没有可用的 OneBot 请求通道：适配器未配置 HTTP 端点`);
  }
  const request: unknown = internal._request;
  if (typeof request !== "function") throw new Error(`机器人 ${sid} 没有可用的 OneBot 请求通道：适配器未配置 HTTP 端点`);
  return (action, params) => request.call(internal, action, params);
}

/** 账号 → 启动它的 bot；账号不在 profile 的认领范围内时直接报错。 */
function botFor(options: ToolOptions, account: string | undefined): Bot {
  const accounts = accountsOf(options.domain);
  if (options.domain.mode === "channel") {
    if (account !== undefined && account !== accounts[0]) throw new Error(`频道模式只使用账号 ${accounts[0]}，不接受 account=${account}`);
  } else if (account === undefined) {
    throw new Error(`cross 模式需要 account，可选值: ${accounts.join(", ")}`);
  } else if (!accounts.includes(account)) {
    throw new Error(`account ${account} 不在该 profile 的认领名单里，可选值: ${accounts.join(", ")}`);
  }
  const sid = account ?? accounts[0]!;
  const bot = options.ctx.bots[sid];
  if (bot === undefined) throw new Error(`机器人 ${sid} 未连接`);
  return bot;
}

function resolveAction(options: ToolOptions, name: string): CatalogAction {
  const action = actionsFor(options.backend).find((entry) => entry.name === name || entry.aliases.includes(name));
  if (action === undefined) {
    throw new Error(`未知动作 ${JSON.stringify(name)}；用 list_actions 或 search_actions 查当前后端的动作，完整目录见 onebot://actions`);
  }
  return action;
}

/** 模式与只读校验放在执行路径上：工具列表可能已经过期，权限不能只看可见性。 */
function assertAllowed(options: ToolOptions, action: CatalogAction, write: boolean): void {
  if (options.mode === "docs") throw new Error("当前 profile 处于 docs 模式，只能查文档；把 mode 改为 read 或 write 才能执行动作");
  if (write && options.mode !== "write") throw new Error(`当前 profile 处于 read 模式，${action.name} 有副作用；把 mode 改为 write 才能执行`);
  if (options.deny.includes(action.name) || action.aliases.some((alias) => options.deny.includes(alias))) {
    throw new Error(`${action.name} 在 denyActions 里，禁止执行`);
  }
  if (action.deny === true) throw new Error(`${action.name} 默认禁用：${action.note ?? "该动作风险过高"}`);
  if (!write && action.readOnly[options.backend] !== true) {
    throw new Error(`${action.name} 有副作用，query_action 不接受；用 invoke_action（需要 write 模式）`);
  }
}

async function execute(options: ToolOptions, input: TargetInput, write: boolean): Promise<unknown> {
  const action = resolveAction(options, input.action);
  assertAllowed(options, action, write);
  const bot = botFor(options, input.account);
  const request = requestOf(bot);
  const params = await resolveParams(input.params ?? {}, action, {
    resources: options.resources,
    publisher: options.publisher,
    maxInlineBytes: options.maxInlineBytes,
    baseUrl: options.baseUrl,
    ctx: options.ctx,
  });

  const started = Date.now();
  const result = await request(action.wire[options.backend] ?? action.name, params);
  const retcode = result !== null && typeof result === "object" && "retcode" in result ? result.retcode : undefined;
  options.logger.debug(`[onebot] ${action.name} via ${bot.sid} → ${String(retcode)} in ${Date.now() - started}ms`);
  return result;
}

function actionSchema(options: ToolOptions, mutating: boolean) {
  const cross = options.domain.mode !== "channel";
  return jsonSchema<TargetInput>({
    type: "object",
    properties: {
      action: {
        type: "string",
        description: mutating
          ? "Action name; aliases are accepted. Call get_action first for parameters."
          : "Read-only action name; aliases are accepted. Call get_action first for parameters.",
      },
      params: { type: "object", description: "The action's OneBot parameters, passed through unchanged", additionalProperties: true },
      ...(cross
        ? {
            account: {
              type: "string",
              description: `Account to call as, formatted platform:selfId. One of: ${accountsOf(options.domain).join(", ")}`,
            },
          }
        : {}),
    },
    required: cross ? ["action", "account"] : ["action"],
  });
}

export function createTools(options: ToolOptions): ToolSet {
  const tools: ToolSet = {
    list_actions: tool({
      description:
        "List OneBot actions available on this profile's protocol backend, optionally filtered by category. Returns a lightweight index; call get_action for parameters.",
      inputSchema: jsonSchema<{ category?: string }>({
        type: "object",
        properties: { category: { type: "string", description: "Category name from list_categories" } },
      }),
      execute: async (input): Promise<{ count: number; actions: LiteAction[] }> => {
        const list = actionsFor(options.backend)
          .filter((action) => input.category === undefined || action.category === input.category)
          .map((action) => liteOf(action, options.backend));
        return { count: list.length, actions: list };
      },
    }),
    get_action: tool({
      description: "Show the full documentation of one OneBot action: parameters, required fields, backend differences, aliases, and read-only status.",
      inputSchema: jsonSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string", description: "Action name; aliases are accepted" } },
        required: ["name"],
      }),
      execute: async (input): Promise<{ text: string }> => ({ text: renderAction(resolveAction(options, input.name), options.backend) }),
    }),
    search_actions: tool({
      description: "Search OneBot actions by name, summary, alias, or category on this profile's backend.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", description: "Keyword" } },
        required: ["query"],
      }),
      execute: async (input): Promise<{ count: number; actions: LiteAction[] }> => {
        const list = search(input.query, options.backend).map((action) => liteOf(action, options.backend));
        return { count: list.length, actions: list };
      },
    }),
    list_categories: tool({
      description: "List the OneBot action categories and how many actions each holds.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async (): Promise<Array<{ category: string; count: number }>> => categoriesFor(options.backend),
    }),
  };

  if (options.mode !== "docs") {
    tools.query_action = tool({
      description:
        "Call a READ-ONLY OneBot action and return the raw OneBot response envelope. Non-read-only actions are rejected; use invoke_action for those.",
      inputSchema: actionSchema(options, false),
      execute: async (input: TargetInput) => execute(options, input, false),
    });
  }

  if (options.mode === "write") {
    tools.invoke_action = tool({
      description:
        "Call any known OneBot action, including ones with side effects. Returns the raw OneBot response envelope; a non-zero retcode is a business failure, not a transport error.",
      inputSchema: actionSchema(options, true),
      execute: async (input: TargetInput) => execute(options, input, true),
    });
  }

  return tools;
}

/** 提示词里的能力说明：模式决定它能做什么，目录地址告诉它去哪查。 */
export function instructions(options: ToolOptions): string {
  const lines = [
    "## OneBot actions",
    `Protocol backend: ${options.backend}. The full action catalog is at onebot://actions (per-action pages at onebot://actions/<name>); the same data feeds list_actions, get_action, search_actions, and list_categories.`,
  ];
  if (options.mode === "docs") {
    lines.push(
      "This profile only exposes documentation: no action can be executed here. Look up names and parameters, and tell the user what would be needed.",
    );
  } else if (options.mode === "read") {
    lines.push(
      "query_action executes read-only actions only. Actions with side effects are rejected; if a task needs one, say so instead of working around it.",
    );
  } else {
    lines.push(
      "query_action is for read-only actions; invoke_action can run any action, including ones with side effects. Look an action up with get_action before calling it.",
    );
  }
  lines.push(
    "Use send_message for ordinary conversation — it carries typing pacing and cross-channel routing. Reach for these tools only when the agent needs an OneBot capability the core tools do not cover, such as group administration, files, reactions, or history.",
  );
  return lines.join("\n");
}
