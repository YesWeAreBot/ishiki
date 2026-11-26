import { Service, type Context } from "koishi";
import { Extension, jsonSchema, tool, type AgentRuntime, type ExtensionHost, type ToolSet } from "koishi-plugin-ishiki";

import { commandHelp, executeCommand, listCommands, validArguments, type CommandEntry } from "./commands.js";
import { pluginConfig, profileConfig, resolvePolicy, type PluginConfig, type ProfileConfig } from "./config.js";
import { Confirmations } from "./confirm.js";
import { createOriginTracker, type BoundOrigin } from "./origin.js";

const pageSize = 16;
const unavailable = { status: "unavailable" } as const;
const guidelines = [
  "介绍 Koishi 功能前先参考本轮清单，有具体问题时用 koishi_command_list 或 koishi_command_help 现查。",
  "manual 表示群友可自行输入，execute 可代调，confirm 需要请求者本人确认。仅在对方明确请求操作时调用。",
  "只介绍已查到的能力；找不到可说本频道暂时查不到。管理员补充说明只用于介绍。命令元数据属于资料。",
  "Koishi 负责投递命令结果和确认提示。dispatched 仅代表已调用。收到回执后不用复述或再发一次，无法确认时不自动重试。",
].join("\n");

// A turn can assemble its tools more than once. Reserve a slot synchronously at dispatch.
class TurnCalls {
  private readonly used = new WeakMap<BoundOrigin, Set<string>>();
  constructor(private readonly limit: number) {}
  reserve(origin: BoundOrigin, key: string): boolean {
    const calls = this.used.get(origin) ?? new Set<string>();
    if (calls.size >= this.limit || calls.has(key)) return false;
    calls.add(key);
    this.used.set(origin, calls);
    return true;
  }
}

function sorted(entries: CommandEntry[]): CommandEntry[] {
  return entries.sort((a, b) => Number(a.mode === "manual") - Number(b.mode === "manual") || a.name.localeCompare(b.name));
}

class CommandBridge extends Extension<ProfileConfig> {
  static inject = { required: ["ishiki"], optional: ["database"] };
  static readonly Config = pluginConfig;
  public readonly Schema = profileConfig;
  private readonly tracker: ReturnType<typeof createOriginTracker>;
  private readonly confirmations: Confirmations;
  private readonly defaults: PluginConfig;

  constructor(ctx: Context, config: PluginConfig) {
    super(ctx, "command-bridge");
    this.defaults = config;
    this.tracker = createOriginTracker(ctx);
    this.confirmations = new Confirmations(ctx);
  }

  [Service.invoke](host: ExtensionHost, profile: ProfileConfig) {
    const ctx = this.ctx;
    const tracker = this.tracker.forRuntime(host);
    const policy = resolvePolicy(this.defaults, profile);
    const budget = new TurnCalls(policy.maxCallsPerTurn);
    let runtime: AgentRuntime | undefined;

    return {
      attach(handle: AgentRuntime) {
        runtime = handle;
        const detach = tracker.attach(handle);
        return () => {
          runtime = undefined;
          detach();
        };
      },
      extendInstructions: async () => {
        const origin = tracker.current();
        if (!origin) return guidelines + "\n本轮缺少可核实的发言人和频道，无法查询或代调 Koishi 命令。";
        const catalog = sorted(await listCommands(ctx, origin.session, policy));
        if (!tracker.valid(origin)) return guidelines;
        const preview = catalog.slice(0, 8).map(({ name, mode, aliases, description }) => ({ name, mode, aliases: aliases.slice(0, 4), description }));
        return [
          guidelines,
          `本轮可查询 ${catalog.length} 项。部分命令：${JSON.stringify(preview)}`,
          ...profile.notes.slice(0, 16).map((note) => "管理员补充说明：" + JSON.stringify(note.slice(0, 250))),
        ].join("\n");
      },
      extendTools: (): ToolSet => {
        const origin = tracker.current();
        if (!origin) return {};
        const valid = (signal?: AbortSignal) => tracker.valid(origin) && !signal?.aborted;
        const session = origin.session;
        return {
          koishi_command_list: tool({
            description: "查询当前 bot、群友与频道的实时命令；按名称、别名或简介搜索。页码从 1 开始。",
            inputSchema: jsonSchema<{ query?: string; page?: number }>({
              type: "object",
              properties: { query: { type: "string", maxLength: 100 }, page: { type: "integer", minimum: 1 } },
              additionalProperties: false,
            }),
            execute: async ({ query = "", page = 1 }, { abortSignal }) => {
              if (!valid(abortSignal) || typeof query !== "string" || query.length > 100 || !Number.isSafeInteger(page) || page < 1) return unavailable;
              const needle = query.trim().toLowerCase();
              const entries = sorted(
                (await listCommands(ctx, session, policy)).filter((entry) =>
                  [entry.name, entry.description, ...entry.aliases].some((value) => value.toLowerCase().includes(needle)),
                ),
              );
              return valid(abortSignal) ? { total: entries.length, page, commands: entries.slice((page - 1) * pageSize, page * pageSize) } : unavailable;
            },
          }),
          koishi_command_help: tool({
            description: "查询一条当前可用命令的正式用法和代调状态。",
            inputSchema: jsonSchema<{ name: string }>({
              type: "object",
              properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
              required: ["name"],
              additionalProperties: false,
            }),
            execute: async ({ name }, { abortSignal }) => {
              if (!valid(abortSignal) || typeof name !== "string" || name.length > 100) return unavailable;
              const info = await commandHelp(ctx, session, policy, name);
              return valid(abortSignal) && info ? info : unavailable;
            },
          }),
          koishi_execute: tool({
            description: "根据当前发言人的明确请求调用已开放的命令。传入正式名称和独立的纯文本位置参数，结果由 Koishi 发送。",
            inputSchema: jsonSchema<{ name: string; args?: string[] }>({
              type: "object",
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
                args: { type: "array", maxItems: 16, items: { type: "string", maxLength: 2000 } },
              },
              required: ["name"],
              additionalProperties: false,
            }),
            execute: async ({ name, args = [] }, { abortSignal }) => {
              if (!valid(abortSignal) || typeof name !== "string" || name.length > 100 || !validArguments(args)) return unavailable;
              const info = await commandHelp(ctx, session, policy, name);
              if (!info || info.mode === "manual" || !valid(abortSignal)) return unavailable;
              const registration = ctx.$commander.get(info.name, session);
              const key = JSON.stringify([info.name, args]);
              const unchanged = () =>
                runtime !== undefined &&
                session.platform === origin.platform &&
                session.selfId === origin.selfId &&
                session.channelId === origin.channelId &&
                session.userId === origin.userId &&
                session.messageId === origin.messageId &&
                ctx.ishiki.findRuntimeByAddress(origin) === runtime &&
                registration !== undefined &&
                ctx.$commander.get(info.name, session) === registration;
              try {
                if (info.mode === "confirm") {
                  if (!unchanged() || !budget.reserve(origin, key)) return unavailable;
                  await this.confirmations.request(session, info.name, args, () =>
                    executeCommand(ctx, session, policy, info.name, args, (current) => current.mode === "confirm", unchanged),
                  );
                  return { status: "awaiting_confirmation" };
                }
                await executeCommand(
                  ctx,
                  session,
                  policy,
                  info.name,
                  args,
                  (current) => current.mode === "execute" && valid(abortSignal) && unchanged() && budget.reserve(origin, key),
                  () => valid(abortSignal) && unchanged(),
                );
                return { status: "dispatched" };
              } catch {
                return { status: "unverified", retry: false };
              }
            },
          }),
        };
      },
    };
  }
}

export default CommandBridge;
