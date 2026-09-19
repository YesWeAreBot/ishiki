import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import {
  Agent,
  AgentCustomEntry,
  AgentEvent,
  AgentEntry,
  AgentMessage,
  AgentPlugin,
  AgentStorage,
  createAgent,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  createUserMessage,
  jsonSchema,
  tool,
  ToolSet,
} from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, h, Logger, Session } from "koishi";

import { Focus, isChannelAllowed, Profile, resolveFocus } from "./profiles.js";
import { classify, factsOf, formatClock, frameSegments, sceneKey } from "./scene.js";
import type { IshikiEntry, IshikiEvent } from "./types.js";

/** How many facts `peek_channel` reads by default, and the most it will read in one call. */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

/** Used when the model declares no window: the workspace budget is half of it, this is the floor. */
const DEFAULT_WORKSPACE_TOKEN_LIMIT = 8192;
const IDLE_CHECK_INTERVAL_MS = 60_000;

interface SendMessageInput {
  inner_thought?: string;
  sid?: string;
  channel?: string;
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

/**
 * The attributes a position declares, shared by the materialized frames and the projection's own head. The name
 * comes from the first fact of that scene in this generation: taken from anything later, the head could drift.
 */
function positionAttributes(focus: Focus, at: string, workspace: readonly AgentEntry[]): string {
  const name = factsOf(workspace, focus, { retractions: false }).find((fact) => !fact.own)?.channelName;
  return [
    `at="${at}"`,
    `focus_sid="${focus.sid}"`,
    `focus_channel="${focus.channelId}"`,
    ...(name === undefined || name.length === 0 ? [] : [`name="${name}"`]),
  ].join(" ");
}

/** The generic loses the narrowing a literal type would give, so the helper owns the one cast. */
function lastEntryOfType<T extends keyof AgentCustomEntry>(entries: readonly AgentEntry[], type: T): AgentEntry<T> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === type) return entry as AgentEntry<T>;
  }
  return undefined;
}

function workspaceOf(entries: readonly AgentEntry[]): readonly AgentEntry[] {
  const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
  return checkpoint === undefined ? entries : entries.slice(entries.indexOf(checkpoint) + 1);
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
  /** Messages a step actually sent; like a monologue, each lands as an ordinary fact at the step boundary. */
  private pendingSelfMessages: IshikiEvent.MessageCreated[] = [];
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

  /** Set by any appended entry; cleared by a successful rebuild and used to skip idle checks on a quiet mind. */
  private generationDirty = false;
  /** A trigger fired while a turn was running: run it at the turn boundary instead. */
  private rebuildPending = false;
  private rebuildChain: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  /** Workspace budget in tokens: the profile's own value, else half the window the model declares. */
  private workspaceTokenLimit = DEFAULT_WORKSPACE_TOKEN_LIMIT;

  constructor(ctx: Context, options: { profile: Profile; gateway: Gateway; profilesPath: string; logLevel: number }) {
    this.ctx = ctx;
    this.profile = options.profile;
    this.gateway = options.gateway;
    this.logger = ctx.logger("ishiki-profile-runtime");
    this.logger.level = options.logLevel;
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
          onAppend: (entries) => {
            this.generationDirty = true;
            return entries;
          },
          /**
           * The whole projection, in the one hook that sees entries. Everything before the last checkpoint
           * already lives inside the frame text, so this walks the current generation only and its cost
           * tracks the generation, not the history. Output is native messages: no render types, no second
           * hook to carry a cursor across.
           */
          transformEntries: (entries) => {
            const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
            const workspace = workspaceOf(entries);
            const out: AgentEntry[] = [];
            if (checkpoint !== undefined) {
              out.push(createEntry("message", createUserMessage(checkpoint.data.text), { id: checkpoint.id, timestamp: checkpoint.timestamp }));
            } else {
              // A generation that never had a frame still has a position: the element a frame opens with, derived
              // from the first entry and the configured focus, so every step of the turn renders the same string.
              const first = workspace[0];
              if (first !== undefined) {
                const head = `<frame ${positionAttributes(this.profile.initialFocus, formatClock(first.timestamp), workspace)}/>`;
                out.push(createEntry("message", createUserMessage(head), { id: `frame:${first.id}`, timestamp: first.timestamp }));
              }
            }

            // The generation starts here; only recorded switches move it, so the live focus never
            // reinterprets messages that were already rendered.
            const startFocus = checkpoint === undefined ? this.profile.initialFocus : checkpoint.data.frameFocus;

            // The slot sits between the frame and the workspace: re-derived on every step, never stored and never
            // folded. The clock is the one thing the projection reads from outside the stream, quantized to a
            // daypart so its bytes move at most four times a day. Pinned to the entry that opened the segment.
            const anchor = checkpoint ?? workspace[0];
            if (anchor !== undefined) {
              const now = new Date();
              const hour = now.getHours();
              const daypart = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
              const slot = ["<state>", `当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${daypart}`, "</state>"].join("\n");
              out.push(
                createEntry("message", createUserMessage(slot), { id: `slot:${anchor.id}`, timestamp: workspace.at(-1)?.timestamp ?? anchor.timestamp }),
              );
            }

            // Lines from the open window are bare, so the first one after anything else opens with a header.
            let inWindow = false;
            for (const record of classify(this.profile, workspace, startFocus)) {
              if (record.kind === "switch") {
                // The head declares the new scene, so the bare lines under it need no second header.
                const reason =
                  record.reason === undefined || record.reason.length === 0 ? "" : ` reason="${record.reason.replaceAll('"', "'").replaceAll("\n", " ")}"`;
                const head = `<focus from="${sceneKey(record.previous)}" to="${sceneKey(record.next)}"${reason}>`;
                out.push(createEntry("message", createUserMessage(head), { id: record.entry.id, timestamp: record.entry.timestamp }));
                inWindow = true;
                continue;
              }
              // Assistant and tool entries pass through untouched: the mind's own behavior is a real message here.
              if (record.kind === "trace") {
                out.push(record.entry);
                inWindow = false;
                continue;
              }
              // What the mind said is marked by the tool call that sent it, so its own message is projected into
              // a frame and never read back here as somebody else's line.
              if (record.own) continue;
              // A fact of another scene renders as a block: only the scene the mind is in prints bare lines.
              const body = record.focus
                ? record.line
                : [
                    `<awareness sid="${record.scene.sid}" channel="${record.scene.channelId}"${record.channelName === undefined || record.channelName.length === 0 ? "" : ` name="${record.channelName}"`}>`,
                    record.line,
                    "</awareness>",
                  ].join("\n");

              // The first line of a run opens with the header; the ones after it stay bare.
              const text = record.focus && !inWindow ? `<focus sid="${record.scene.sid}" channel="${record.scene.channelId}">\n${body}` : body;
              inWindow = record.focus;
              out.push(createEntry("message", createUserMessage(text), { id: record.entry.data.id, timestamp: record.entry.data.timestamp }));
            }
            return out;
          },
          onStepFinish: async (info) => {
            // The messages that actually left land as ordinary facts of their scene, under their own type: the
            // frame and `peek_channel` read them back like anybody else's line, while the live projection, which
            // only knows the platform's own facts, never sees them.
            if (this.pendingSelfMessages.length > 0) {
              const facts = this.pendingSelfMessages.map((sent) =>
                createEntry("message", createCustomMessage("ishiki.self.message", sent), { turnId: info.turnId }),
              );
              try {
                await this.agent.storage.append(...facts);
                this.pendingSelfMessages = [];
              } catch (error) {
                this.logger.warn(`自消息写入失败，保留待下一次 step 边界重试：${String(error)}`);
              }
            }

            // A switch is the generation change itself, and a step boundary is the earliest moment it can
            // happen: the step's assistant and tool entries are written, so the new frame never splits a call
            // from its result. A failed checkpoint leaves a minimal change entry as the fuse instead.
            const pending = this.pendingFocus;
            if (pending !== null) {
              if (await this.rebuild("switch")) {
                this.pendingFocus = null;
              } else {
                try {
                  await this.agent.storage.append(createEntry("ishiki.focus.changed", pending, { turnId: info.turnId }));
                  this.pendingFocus = null;
                  this.logger.warn("换代的 checkpoint 未写入，已落 change 条目作为保险丝。");
                } catch (error) {
                  this.logger.warn(`change 条目也写入失败，保留待下一次 step 边界重试：${String(error)}`);
                }
              }
            }

            // Consume the flag: this hook runs exactly once per step, so it never leaks into the next one.
            const stop = this.stopRequestedThisStep;
            this.stopRequestedThisStep = false;
            return stop ? { continue: false } : undefined;
          },
          onTurnFinish: () => {
            this.stopRequestedThisStep = false;
            if (this.generationDirty || this.rebuildPending) this.scheduleRebuild("turn-finish");
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
      this.cachedInstructions = [persona, this.stableZone()].filter((part) => part.length > 0).join("\n\n");
    }
    if (this.cachedTools === undefined) this.cachedTools = this.buildTools();
  }

  /**
   * The stable zone: how this mind works, what focus means, and the bodies it acts through. What a tool
   * takes and returns is stated in that tool's own schema — a second copy here would drift from it.
   */
  private stableZone(): string {
    const bodies = this.profile.allowedChannels.map((declaration) => `  ${declaration.sid} → ${declaration.channels.join(", ")}`).join("\n");

    return [
      "你是一个心智：在聊天软件上拥有自己的账号，在频道里跟人说话、看别人说话。没有人给你派任务，也没有人等你交付什么。",
      "",
      "## 说话方式",
      "",
      "你写下的正文只有你自己看得见；想让别人收到话，必须调用工具发出去（send_message）。",
      "",
      "## 你在哪：一个窗口",
      "",
      "你的账号同时在线，但你同一时刻只打开一个频道的窗口，那就是焦点（focus）。",
      "",
      "- 帧是回顾：一个场景一段，段头写明 sid 与 channel，带 focus 的那段就是你正打开的窗口，段内裸行都属于这个场景。",
      "- 帧之后才是正在发生的事：窗口里的行以 <focus sid channel> 块头出现，别处够得着的以 <awareness> 块出现。",
      "- 别把两处的话串起来：同一个人可能同时在私聊和群里跟你讲话，那是两场对话；答话要答在跟你说话的那个频道。",
      "- 发消息默认发到 focus：省略 channel 与 sid；要发去别的频道、或改用另一个账号，才写它们。",
      "- 换窗口用 switch_focus；换过之后本轮的后续动作默认在新窗口发生，你离开的那个场景在新帧里有自己的一段。",
      "",
      "你的账号与可发消息的频道（channel 的语义域是 sid）：",
      bodies,
      "",
      "你的 uid 是账号里 platform: 后面那一段。",
      "行里括号中的 id 等于你的 uid 时，这一行就是你说的；你自己的话与别人的话写法相同。",
      "",
      "## 一次被叫到",
      "",
      "有人叫到你，你就来一轮；一轮里可以连续调用多个工具。",
      "把话说完，这一轮就结束了：不必留在原地等回复，对方下一条消息会再叫你一次。",
      "没有想说的话就不说，沉默是允许的。",
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
        description: "把你的话发到某个频道。",
        inputSchema: jsonSchema<SendMessageInput>({
          type: "object",
          properties: {
            ...(this.profile.innerThought
              ? {
                  inner_thought: {
                    type: "string",
                    description: "本次发送前的内心独白，只留给你自己看，不会发出去",
                  },
                }
              : {}),
            sid: { type: "string", description: "账号（platform:selfId）；省略即 focus 所在的账号" },
            channel: { type: "string", minLength: 1, description: "目标频道；省略即 focus 的频道" },
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
              description: "true 只用于本轮还有下一步要做；省略即发完结束本轮",
            },
          },
          required: ["messages"],
        }),
        execute: async (input) => {
          const target = resolveFocus(this.profile, this.currentFocus, input);
          if ("error" in target) return { ok: false as const, error: target.error, sent: [], failedAt: 0 };

          const messages = input.messages;
          if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => typeof message !== "string" || message.length === 0)) {
            return { ok: false as const, error: { name: "InvalidInput", message: "messages 必须是非空字符串数组" }, sent: [], failedAt: 0 };
          }
          const bot = this.ctx.bots[target.sid];
          if (!bot) return { ok: false as const, error: { name: "BotNotFound", message: `Bot with sid ${target.sid} not found` }, sent: [], failedAt: 0 };

          const platform = bot.platform!;
          const sent: string[] = [];

          for (let index = 0; index < messages.length; index += 1) {
            try {
              const content = input.mode === "raw" ? h.escape(messages[index]) : messages[index];
              const ids = await bot.sendMessage(target.channelId, content);
              sent.push(...ids);
              if (ids.length === 0) {
                this.logger.warn(`平台没有返回消息 id，这条自消息不进记录：${target.sid}/${target.channelId}`);
              } else {
                this.pendingSelfMessages.push({
                  platform,
                  channel: { id: target.channelId },
                  content: content,
                  messageId: ids[0],
                  timestamp: Date.now(),
                  selfId: bot.selfId,
                  user: { id: bot.selfId, name: bot.user?.name ?? this.profile.name },
                });
              }
            } catch (error) {
              // A platform failure carries a name worth keeping: `BotNotFound` tells the model to fix the address.
              const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
              return { ok: false as const, sent, failedAt: index, error: failure };
            }
          }

          if (input.continue !== true) requestStop();
          return { ok: true as const, count: sent.length };
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
        description: "换 focus（当前打开的窗口）。换过之后，本轮的后续发送默认去新场景；一轮只能换一次。",
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
          // No cooldown: a switch ends the generation, so "once per generation" is structural. Frequent
          // hopping pays its own frame-level misses.
          this.pendingFocus = { previous: this.currentFocus, next: target, ...(input.reason === undefined ? {} : { reason: input.reason }) };
          this.currentFocus = target;
          return { ok: true as const, changed: true, target };
        },
      }),
      peek_channel: tool({
        description: "只读查看某个频道最近的消息；不改变 focus，也不产生记录。",
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

          const lines = factsOf(await this.agent.storage.read(), target, { retractions: false }).map((fact) => fact.line);
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
    await this.openFrame();
    await this.restoreContext();
    this.resolveBudget();

    // The tools close over this runtime, so the agent has to be reachable before the first prompt assembly.
    await this.agent.init();

    this.logger.info(`Agent for profile ${this.profile.id} initialized with model ${this.profile.model}.`);

    this.agent.channel.subscribe("agent", (event: AgentEvent) => {
      this.logger.debug(`--- Agent Event ---\n${JSON.stringify(event, null, 2)}`);
    });

    this.idleTimer = setInterval(() => void this.checkIdle(), IDLE_CHECK_INTERVAL_MS);

    this.ctx.on("internal/session", async (session: Session) => {
      if (!isChannelAllowed(this.profile, session.sid, session.channelId ?? "")) return;
      // One of this profile's own bodies speaking is not input: without this the mind reads its own words back
      // as somebody else's message, and the same sentence enters the stream twice.
      if (session.userId !== undefined && this.profile.allowedChannels.some((declaration) => declaration.sid === `${session.platform}:${session.userId}`))
        return;

      this.logger.debug(`--- Session ---\n${JSON.stringify(session, null, 2)}`);

      let shouldTrigger: boolean = false;
      let message: AgentMessage | undefined;
      switch (session.type) {
        case "message-created": {
          const authorName = session.author?.name;
          const channelName = session.event?.channel?.name;
          message = createCustomMessage("ishiki.message.created", {
            content: session.content!,
            user: { id: session.userId!, ...(authorName === undefined ? {} : { name: authorName }) },
            channel: { id: session.channelId!, ...(channelName === undefined ? {} : { name: channelName }), direct: session.isDirect },
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
        }
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

  /**
   * A profile with an empty stream gets its position written before the first turn. Materializing it here —
   * instead of after a turn has already been sent — keeps every request's prefix untouched, and from then on
   * it is an ordinary checkpoint: the projection, the rebuild and the restore need no special case.
   */
  private async openFrame(): Promise<void> {
    const entries = await this.storage.read();
    if (entries.length > 0) return;

    const frameFocus = { ...this.profile.initialFocus };
    const text = [
      `<frame at="${formatClock(Date.now())}" focus_sid="${frameFocus.sid}" focus_channel="${frameFocus.channelId}">`,
      "（在此之前没有发生过任何事。）",
      "</frame>",
    ].join("\n");
    const record: IshikiEntry.Checkpoint = { frameFocus, text, createdAt: Date.now() };

    try {
      await this.storage.append(createEntry("ishiki.checkpoint", record));
    } catch (error) {
      // The projection derives a head on its own, so a failed opening frame costs the greeting, not the run.
      this.logger.warn(`开局帧写入失败，本代由投影自行给出位置：${String(error)}`);
    }
  }

  /**
   * The live focus is the switch recorded after the last checkpoint; only a profile without any checkpoint
   * falls back to the configured `initialFocus`. The frame needs no restoring — it lives in the checkpoint
   * payload and the projection reads it from the entry stream.
   */
  private async restoreContext(): Promise<void> {
    const entries = await this.storage.read();
    const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
    if (checkpoint === undefined) {
      this.generationDirty = entries.length > 0;
      return;
    }

    const after = entries.slice(entries.indexOf(checkpoint) + 1);
    const lastSwitch = lastEntryOfType(after, "ishiki.focus.changed");
    this.currentFocus = lastSwitch === undefined ? { ...checkpoint.data.frameFocus } : { ...lastSwitch.data.next };
    this.generationDirty = after.length > 0;
  }

  /** The workspace budget: an explicit token limit, else half of the window the model declares. */
  private resolveBudget(): void {
    const declared = this.profile.context.workspaceTokenLimit;
    if (declared !== undefined) {
      this.workspaceTokenLimit = declared;
      return;
    }
    const window = this.gateway.models("language").find((model) => model.id === this.profile.model)?.metadata.contextWindow;
    this.workspaceTokenLimit = window === undefined ? DEFAULT_WORKSPACE_TOKEN_LIMIT : Math.floor(window * 0.5);
  }

  private overBudget(workspace: readonly AgentEntry[]): boolean {
    let chars = 0;
    for (const entry of workspace) chars += JSON.stringify(entry).length;
    return chars / this.profile.context.charsPerToken >= this.workspaceTokenLimit;
  }

  /**
   * The text of the next frame: one segment per scene. A fact belongs to the scene it came from; a tool call
   * belongs to the scene the mind was in when it ran, so a switch hands the trajectory it produced to the scene it
   * is leaving. A scene the generation was focused in keeps that slice of it; one it only heard from is read back
   * out of storage instead, which is the only place that holds a conversation rather than fragments of attention.
   * `startFocus` is where the generation's cursor began, which is the scene a switch is leaving.
   */
  private frameTextFor(frameFocus: Focus, startFocus: Focus, entries: readonly AgentEntry[], workspace: readonly AgentEntry[]): string {
    const at = Date.now();
    const here = sceneKey(frameFocus);
    const { historyEntries, sceneWindowMs } = this.profile.context;
    const segments = frameSegments(this.profile, workspace, startFocus);

    const parts = [`<frame ${positionAttributes(frameFocus, formatClock(at), workspace)}>`];

    // The open window leads with the lines the live path showed, and it declares nothing twice: the frame head
    // already says where the mind is.
    const open = segments.find((segment) => sceneKey(segment.scene) === here);
    parts.push(`<history sid="${frameFocus.sid}" channel="${frameFocus.channelId}" focus>`);
    parts.push(...(open?.lines ?? []));
    parts.push("</history>");

    const rest: Array<{ scene: Focus; lines: string[]; dropped: number; latest: number }> = [];
    for (const segment of segments) {
      if (sceneKey(segment.scene) === here) continue;
      let lines = segment.lines;
      let dropped = 0;
      let latest = segment.latest;
      if (!segment.focus) {
        // A scene the generation only heard from is read back out of storage — the only place that holds a
        // conversation rather than fragments of attention.
        const fresh = factsOf(entries, segment.scene).filter((fact) => at - fact.timestamp <= sceneWindowMs);
        const kept = fresh.slice(-historyEntries);
        lines = kept.map((fact) => fact.line);
        dropped = Math.max(0, fresh.length - historyEntries);
        latest = kept.at(-1)?.timestamp ?? 0;
      }
      if (lines.length === 0) continue;
      rest.push({ scene: segment.scene, lines, dropped, latest });
    }
    rest.sort((left, right) => right.latest - left.latest);

    for (const segment of rest) {
      parts.push(`<history sid="${segment.scene.sid}" channel="${segment.scene.channelId}">`);
      if (segment.dropped > 0) parts.push(`<!-- 更早 ${segment.dropped} 条已折叠 -->`);
      parts.push(...segment.lines);
      parts.push("</history>");
    }

    parts.push("</frame>");
    return parts.join("\n");
  }

  /**
   * The only materialized write. A failure leaves the generation untouched so the next trigger retries it.
   * A switch forces the write — a switch *is* the generation change — and the new frame then carries the ended
   * generation's trajectory, because it is built from the previous checkpoint's focus. The result lets the
   * switch path fall back to its fuse.
   */
  private async rebuild(reason: string): Promise<boolean> {
    const entries = await this.storage.read();
    const workspace = workspaceOf(entries);
    if (workspace.length === 0) {
      this.generationDirty = false;
      return true;
    }

    // Idle is early compression, not a budget decision: folding a quiet generation while it is still small is
    // the point, since nobody is waiting for the answer. A switch is not a decision at all.
    if (reason !== "switch" && reason !== "idle" && !this.overBudget(workspace)) return false;

    const frameFocus = { ...this.currentFocus };
    const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
    const startFocus = checkpoint === undefined ? this.profile.initialFocus : checkpoint.data.frameFocus;
    const text = this.frameTextFor(frameFocus, startFocus, entries, workspace);
    const record: IshikiEntry.Checkpoint = {
      frameFocus,
      text,
      createdAt: Date.now(),
    };

    try {
      await this.storage.append(createEntry("ishiki.checkpoint", record));
    } catch (error) {
      this.logger.warn(`checkpoint 写入失败（${reason}），本代保留待下次重试：${String(error)}`);
      return false;
    }

    this.generationDirty = false;
    this.rebuildPending = false;
    this.logger.debug(`帧重建完成（${reason}），${text.length} 字符`);
    return true;
  }

  private scheduleRebuild(reason: string): void {
    this.rebuildChain = this.rebuildChain
      .then(async () => {
        await this.rebuild(reason);
      })
      .catch((error: unknown) => this.logger.warn(`帧重建异常（${reason}）：${String(error)}`));
  }

  /** Early compression: a quiet generation is folded before the next message has to pay for it. */
  private async checkIdle(): Promise<void> {
    if (!this.generationDirty) return;
    if (!this.agent.isIdle()) {
      this.rebuildPending = true;
      return;
    }
    const entries = await this.storage.read();
    const last = entries.at(-1);
    if (last === undefined || Date.now() - last.timestamp < this.profile.context.idleMs) return;
    this.scheduleRebuild("idle");
  }

  async stop() {
    clearInterval(this.idleTimer);
    await this.agent.stop();
  }
}
