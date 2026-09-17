import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentPlugin,
  AgentStorage,
  createAgent,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  jsonSchema,
  tool,
  ToolSet,
} from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, h, Logger, Session } from "koishi";

import { Focus, isChannelAllowed, Profile, resolveFocus } from "./profiles.js";

/** How many facts `peek_channel` reads by default, and the most it will read in one call. */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

interface SendMessageInput {
  inner_thought?: string;
  sid?: string;
  channel: string;
  messages: string[];
  mode?: "element" | "raw";
  continue?: boolean;
}

interface TargetInput {
  sid?: string;
  channel: string;
}

interface SwitchFocusInput extends TargetInput {
  reason?: string;
}

interface PeekChannelInput extends TargetInput {
  limit?: number;
}

/** Platform failures carry a name worth keeping: `BotNotFound` tells the model to fix the address, `Error` does not. */
function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

export class ProfileRuntime {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly profile: Profile;
  private readonly gateway: Gateway;
  private readonly profileDataPath: string;

  private agent: Agent;
  private storage: AgentStorage;

  /**
   * The scene this mind sits in. `switch_focus` replaces it immediately (so the rest of the step addresses
   * the new scene), while its record waits for the step boundary.
   */
  private currentFocus: Focus;
  private pendingFocus: { previous: Focus; next: Focus; reason?: string } | null = null;
  private switchedThisTurn = false;
  /**
   * Raised by `finish` and by a `send_message` that does not ask to continue. `onStepFinish` runs exactly
   * once per step, so it consumes the flag and never lets it leak into the next step.
   */
  private stopRequestedThisStep = false;

  /**
   * Prompt parts, frozen until `start()` reloads them. Assembly runs every turn, so without the freeze a
   * source that re-reads or rebuilds would rewrite the model-visible prefix every turn.
   */
  private cachedInstructions: string | undefined;
  private cachedTools: ToolSet | undefined;

  constructor(ctx: Context, options: { profile: Profile; gateway: Gateway; profilesPath: string }) {
    this.ctx = ctx;
    this.profile = options.profile;
    this.gateway = options.gateway;
    this.logger = ctx.logger("ishiki-profile-runtime");
    this.profileDataPath = path.resolve(this.ctx.baseDir, path.dirname(options.profilesPath), this.profile.dataPath);
    if (!existsSync(this.profileDataPath)) {
      mkdirSync(this.profileDataPath, { recursive: true });
    }
    this.currentFocus = { ...this.profile.initialFocus };
    this.storage = createJsonlStorage(path.resolve(this.profileDataPath, "messages.jsonl"));

    this.agent = createAgent({
      id: this.profile.id,
      model: this.gateway.languageModel(this.profile.model),
      storage: this.storage,
      plugins: [
        {
          name: "ishiki-prompt-cache",
          extendInstructions: async () => {
            await this.loadPromptParts();
            return this.cachedInstructions;
          },
          extendTools: async () => {
            await this.loadPromptParts();
            return this.cachedTools;
          },
        } satisfies AgentPlugin,
        {
          name: "ishiki-agent-plugin",
          transformEntries: (entries) => {
            // find and transform checkpoint entry, focus change entry
            // return plain messages for previous hook to transform into model messages
            return entries;
          },
          transformMessages: (messages) => {
            // find current focus, filter focus messages, mark awareness messages
            return messages;
          },
          toModelMessages: (message) => {
            // transform custom messages into model messages
            switch (message.type) {
              case "ishiki.message.created":
                return [
                  {
                    role: "user",
                    content: `[频道ID: ${message.data.channelId}] [消息ID: ${message.data.messageId}] [用户ID: ${message.data.userId}] [平台消息] ${message.data.content}`,
                  },
                ];
              case "ishiki.message.deleted":
                return;
              case "onebot.guild.member-added":
                return;
              default:
                return;
            }
          },
          onStepFinish: async (info) => {
            // A step boundary is the earliest moment the switch record can land: the step's assistant and
            // tool entries are already written, so the record never splits a tool call from its result.
            if (this.pendingFocus) {
              try {
                await this.agent.storage.append(createEntry("ishiki.focus.changed", this.pendingFocus, { turnId: info.turnId }));
                this.pendingFocus = null;
              } catch (error) {
                this.logger.warn(`focus change 写入失败，保留待下一次 step 边界重试：${String(error)}`);
              }
            }

            // Consume the flag: this hook runs exactly once per step, so it never leaks into the next one.
            const stop = this.stopRequestedThisStep;
            this.stopRequestedThisStep = false;
            return stop ? { continue: false } : undefined;
          },
          onTurnFinish: () => {
            this.switchedThisTurn = false;
            this.stopRequestedThisStep = false;
          },
        } satisfies AgentPlugin,
      ],
    });
  }

  /** Loads what the two halves of the assembly need, once per `start()`. */
  private async loadPromptParts(): Promise<void> {
    if (this.cachedInstructions === undefined) {
      const personaFile = path.resolve(this.profileDataPath, "persona.md");
      const persona = existsSync(personaFile) ? (await fs.readFile(personaFile, "utf-8")).trim() : "";
      this.cachedInstructions = [persona, this.toolGuide()].filter((part) => part.length > 0).join("\n\n");
    }
    if (this.cachedTools === undefined) this.cachedTools = this.buildTools();
  }

  /** The bodies and channels this mind can act on — the list behind every addressing parameter. */
  private toolGuide(): string {
    const bodies = this.profile.allowedChannels.map((declaration) => `  ${declaration.sid} → ${declaration.channels.join(", ")}`).join("\n");

    return [
      "工具是你在这台设备上行动的唯一途径：你的文本输出不会被任何人看到。",
      "",
      "你的身体与可发言频道（channel 的语义域是 sid）：",
      bodies,
      "",
      "send_message(channel, messages, mode?, continue?, sid?, inner_thought?)",
      "  逐条发出 messages，一条消息一句话。channel 必填；sid 省略即当前 focus 的身体。",
      '  mode="raw" 按字面发送；默认 "element"，正文中的 <at id="…"/> 等元素会被平台解析。',
      "  未把 continue 设为 true 时，本 step 结束即结束本轮。",
      "",
      "switch_focus(channel, sid?, reason?)",
      "  改变你的默认情境，不立即重建上下文；切换后本轮的后续发送默认去新场景。一轮只允许切一次。",
      "",
      "peek_channel(channel, sid?, limit?)",
      "  只读查看某频道最近消息；不改变 focus，不产生记录。",
      "",
      "finish(reason?)",
      "  结束本轮而不发言。看过消息但决定不回复时用它。",
    ].join("\n");
  }

  /**
   * The tools close over this runtime: the focus they read is the live one, so a switch made mid-step
   * already applies to the rest of that step.
   */
  private buildTools(): ToolSet {
    const requestStop = () => {
      this.stopRequestedThisStep = true;
    };

    return {
      send_message: tool({
        description: "向频道发送消息。这是消息到达平台的唯一途径——你的文本输出不会被发送，只有本工具发出的内容会被别人看到。",
        inputSchema: jsonSchema<SendMessageInput>({
          type: "object",
          properties: {
            ...(this.profile.innerThought
              ? {
                  inner_thought: {
                    type: "string",
                    description: "本次发送前的内心独白；",
                  },
                }
              : {}),
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "目标频道 ID；它的语义域由 sid 决定" },
            messages: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
              description: "要发送的消息，每一项作为一条独立消息按顺序发出",
            },
            mode: {
              type: "string",
              enum: ["element", "raw"],
              description: 'element（默认）时正文中的 <at id="…"/> 等元素会被平台解析；raw 时正文按字面发送',
            },
            continue: {
              type: "boolean",
              description: "true 时发送后继续生成；省略或 false 时发完即结束本轮",
            },
          },
          required: ["messages", "channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error, sent: [], failedAt: 0 };

          const messages = input.messages;
          if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => typeof message !== "string" || message.length === 0)) {
            return { ok: false as const, error: { name: "InvalidInput", message: "messages 必须是非空字符串数组" }, sent: [], failedAt: 0 };
          }

          const sent: string[] = [];
          const bot = this.ctx.bots[target.sid];
          if (!bot) return { ok: false as const, error: { name: "BotNotFound", message: `Bot with sid ${target.sid} not found` }, sent: [], failedAt: 0 };

          for (let index = 0; index < messages.length; index += 1) {
            try {
              const content = input.mode === "raw" ? h.escape(messages[index]) : messages[index];
              sent.push(...(await bot.sendMessage(target.channelId, content)));
            } catch (error) {
              return { ok: false as const, sent, failedAt: index, error: describeError(error) };
            }
          }

          if (input.continue !== true) requestStop();
          return { ok: true as const, target, messageIds: sent, count: sent.length };
        },
      }),
      finish: tool({
        description: "结束本轮而不发言。看过消息但决定不回复时用它。",
        inputSchema: jsonSchema<{ reason?: string }>({
          type: "object",
          properties: {
            reason: { type: "string", description: "结束原因" },
          },
          required: [],
        }),
        execute: async () => {
          requestStop();
          return { ok: true as const };
        },
      }),
      switch_focus: tool({
        description: "切换你的默认情境（focus）。切换后本轮的后续发送默认去新场景，不立即重建上下文。一轮只允许切换一次。",
        inputSchema: jsonSchema<SwitchFocusInput>({
          type: "object",
          properties: {
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "目标频道 ID" },
            reason: { type: "string", description: "切换原因" },
          },
          required: ["channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error };

          if (target.sid === this.currentFocus.sid && target.channelId === this.currentFocus.channelId) {
            return { ok: true as const, changed: false, target };
          }
          if (this.switchedThisTurn) {
            return { ok: false as const, error: { name: "FocusCooldown", message: "本轮已经切换过 focus" } };
          }

          this.pendingFocus = { previous: this.currentFocus, next: target, ...(input.reason === undefined ? {} : { reason: input.reason }) };
          this.currentFocus = target;
          this.switchedThisTurn = true;
          return { ok: true as const, changed: true, target };
        },
      }),
      peek_channel: tool({
        description: "只读查看某个频道最近的消息。不改变 focus，也不产生任何记录。",
        inputSchema: jsonSchema<PeekChannelInput>({
          type: "object",
          properties: {
            sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
            channel: { type: "string", minLength: 1, description: "要查看的频道 ID" },
            limit: { type: "number", description: `读取条数，默认 ${PEEK_DEFAULT_LIMIT}，上限 ${PEEK_MAX_LIMIT}` },
          },
          required: ["channel"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error };

          const limit = input.limit ?? PEEK_DEFAULT_LIMIT;
          if (!Number.isInteger(limit) || limit <= 0 || limit > PEEK_MAX_LIMIT) {
            return { ok: false as const, error: { name: "LimitTooLarge", message: `limit 必须是 1 到 ${PEEK_MAX_LIMIT} 之间的整数` } };
          }

          const lines: string[] = [];
          for (const entry of await this.agent.storage.read()) {
            if (entry.type !== "message") continue;
            const message = entry.data;
            if (message.role !== "custom" || message.type !== "ishiki.message.created") continue;
            const fact = message.data;
            if (`${fact.platform}:${fact.selfId}` !== target.sid || fact.channelId !== target.channelId) continue;
            lines.push(`[${formatClock(fact.timestamp)}] ${fact.userId} #${fact.messageId}: ${fact.content}`);
          }

          const recent = lines.slice(-limit);
          const text = [`<peek sid="${target.sid}" channel="${target.channelId}" count=${recent.length}>`, ...recent].join("\n");
          return { ok: true as const, target, count: recent.length, text };
        },
      }),
      report_tool_issue: tool({
        description: "报告工具调用问题",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            tool: { type: "string", description: "工具名称" },
            issue: { type: "string", description: "concise description of the issue" },
          },
          required: ["tool", "issue"],
        }),
        execute: async (args) => {
          await fs.appendFile(
            path.resolve(this.profileDataPath, "tool_issues.log"),
            `[${new Date().toISOString()}] Tool: ${args.tool}, Issue: ${args.issue}\n`,
          );
          return { success: true, message: "Noted, thanks" };
        },
      }),
    };
  }

  async start() {
    // Reloading eagerly surfaces a failing source here instead of inside a turn.
    this.cachedInstructions = undefined;
    this.cachedTools = undefined;
    await this.loadPromptParts();

    // The tools close over this runtime, so the agent has to be reachable before the first prompt assembly.
    await this.agent.init();

    this.logger.info(`Agent for profile ${this.profile.id} initialized with model ${this.profile.model}.`);

    this.agent.channel.subscribe("agent", (event: AgentEvent) => {
      this.logger.debug(`--- Agent Event ---\n${JSON.stringify(event, null, 2)}`);
    });

    this.ctx.on("internal/session", async (session: Session) => {
      if (!isChannelAllowed(this.profile, session.sid, session.channelId ?? "")) return;

      this.logger.debug(`--- Session ---\n${JSON.stringify(session, null, 2)}`);

      let shouldTrigger: boolean = false;
      let message: AgentMessage | undefined;
      switch (session.type) {
        case "message-created":
          message = createCustomMessage("ishiki.message.created", {
            content: session.content!,
            userId: session.userId!,
            channelId: session.channelId,
            guildId: session.guildId,
            messageId: session.messageId!,
            timestamp: session.timestamp,
            platform: session.platform,
            selfId: session.selfId,
            quote: session.quote
              ? {
                  id: session.quote.id!,
                  content: session.quote.content,
                  user: session.quote.user,
                  channel: session.quote.channel,
                  guild: session.quote.guild,
                }
              : undefined,
          });
          if (
            session.isDirect ||
            session.stripped.atSelf ||
            (session.stripped.hasAt && session.elements?.some((el) => el.type === "at" && el.attrs?.id === session.selfId)) ||
            this.profile.keywords.some((keyword) => session.content?.includes(keyword))
          ) {
            shouldTrigger = true;
          }
          break;
        case "message-deleted":
          break;
        case "guild-member-added":
          break;
        default:
          break;
      }
      if (!message) return;
      const turnId = this.agent.send(message, { trigger: shouldTrigger, ifBusy: "join" });
      if (turnId) {
        this.logger.info(`Message sent to agent for profile ${this.profile.id} with turn ID ${turnId}.`);
        void (await this.agent.wait());
      }
    });
  }

  async stop() {
    if (!this.agent) return;
    await this.agent.stop();
  }
}
