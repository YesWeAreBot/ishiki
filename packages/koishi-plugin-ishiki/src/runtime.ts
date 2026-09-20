import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import { Template } from "@huggingface/jinja";
import {
  Agent,
  AgentCustomEntry,
  AgentEntry,
  AgentEvent,
  AgentPlugin,
  AgentStorage,
  createAgent,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  createUserMessage,
  dynamicTool,
  jsonSchema,
  tool,
  ToolSet,
} from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, h, Logger, Session, sleep } from "koishi";

import { HandlerResult, sessionHandlers } from "./handlers.js";
import { Focus, isChannelAllowed, Profile, resolveFocus } from "./profiles.js";
import { classify, collectLines, eventRenders, formatClock, sceneKey } from "./scene.js";
import type { IshikiEntry, IshikiEvent } from "./types.js";

/** Resolve a path relative to the package root's resources/ directory. Works in both ESM and CJS builds. */
function resourcePath(...segments: string[]): string {
  // In ESM import.meta.url is a file URL; in CJS (esbuild) import.meta is empty but __dirname is a global.
  let srcDir: string;
  if (import.meta.url) {
    srcDir = path.dirname(new URL(import.meta.url).pathname);
    // On Windows, URL pathname starts with /C:/... — strip the leading slash.
    if (process.platform === "win32" && srcDir.startsWith("/")) srcDir = srcDir.slice(1);
  } else {
    // eslint-disable-next-line no-restricted-globals -- CJS global, not available in ESM type definitions
    srcDir = __dirname;
  }
  return path.resolve(srcDir, "..", "resources", ...segments);
}

/** How many lines `peek_channel` reads by default, and the most it will read in one call. */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

/** Used when the model declares no window: the workspace budget is half of it, this is the floor. */
const DEFAULT_WORKSPACE_TOKEN_LIMIT = 8192;
const IDLE_CHECK_INTERVAL_MS = 60_000;

interface SendMessageInput {
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
 * The `<frame ...>` opening tag.
 */
function renderFrameHead(focus: Focus, at: string): string {
  return [`at="${at}"`, `focus_sid="${focus.sid}"`, `focus_channel="${focus.channelId}"`].join(" ");
}

/** The generic loses the narrowing a literal type would give, so the helper owns the one cast. */
function findLastEntry<T extends keyof AgentCustomEntry>(entries: readonly AgentEntry[], type: T): AgentEntry<T> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === type) return entry as AgentEntry<T>;
  }
  return undefined;
}

function sliceWorkspace(entries: readonly AgentEntry[]): readonly AgentEntry[] {
  const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
  return checkpoint === undefined ? entries : entries.slice(entries.indexOf(checkpoint) + 1);
}

export class ProfileRuntime {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly profile: Profile;
  private readonly gateway: Gateway;
  private readonly profileDataPath: string;
  /** Whether this profile has multiple scenes (bodies × channels > 1). */
  private readonly singleScene: boolean;

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
   * Raised by `finish`. `onStepFinish` runs exactly once per step, so it consumes the flag and never lets
   * it leak into the next step.
   */
  private stopRequestedThisStep = false;
  /**
   * Set by `send_message` when `continue` is falsy. The actual stop only fires in `onStepFinish` if no
   * other non-trivial tool (anything besides `think`) ran in the same step — so a parallel switch_focus
   * failure does not silently end the turn.
   */
  private sendWantsStop = false;

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

  constructor(ctx: Context, options: { profile: Profile; gateway: Gateway; profilesFile: string; logLevel: number }) {
    this.ctx = ctx;
    this.profile = options.profile;
    this.gateway = options.gateway;
    this.logger = ctx.logger("ishiki-profile-runtime");
    this.logger.level = options.logLevel;
    this.profileDataPath = path.resolve(this.ctx.baseDir, path.dirname(options.profilesFile), this.profile.dataPath);
    if (!existsSync(this.profileDataPath)) {
      mkdirSync(this.profileDataPath, { recursive: true });
    }
    this.currentFocus = { ...this.profile.initialFocus };
    this.storage = createJsonlStorage(path.resolve(this.profileDataPath, "messages.jsonl"));
    // A single scene means exactly one body with exactly one non-wildcard channel.
    const totalChannels = this.profile.allowedChannels.reduce((sum, d) => sum + d.channels.length, 0);
    const hasWildcard = this.profile.allowedChannels.some((d) => d.channels.some((c) => c.includes("*")));
    this.singleScene = totalChannels <= 1 && !hasWildcard;

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
            const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
            const workspace = sliceWorkspace(entries);
            const out: AgentEntry[] = [];
            if (checkpoint !== undefined) {
              out.push(createEntry("message", createUserMessage(checkpoint.data.text), { id: checkpoint.id, timestamp: checkpoint.timestamp }));
            } else {
              // A generation that never had a frame still has a position: the element a frame opens with, derived
              // from the first entry and the configured focus, so every step of the turn renders the same string.
              const first = workspace[0];
              if (first !== undefined) {
                const head = `<frame ${renderFrameHead(this.profile.initialFocus, formatClock(first.timestamp))}/>`;
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
              // a frame and never read back here as somebody else's line in the workspace.
              if (record.entry.data.role !== "custom" || record.entry.data.type === "ishiki.self.message") continue;
              // Non-focus facts are compact notifications: enough to know who said what where, not full context.
              if (!record.focus) {
                const text = `<notification sid="${record.scene.sid}" channel="${record.scene.channelId}">${record.line}</notification>`;
                out.push(createEntry("message", createUserMessage(text), { id: record.entry.data.id, timestamp: record.entry.data.timestamp }));
                inWindow = false;
                continue;
              }
              // Focus fact: bare line, with a header on the first one after non-focus content.
              const text = !inWindow ? `<focus sid="${record.scene.sid}" channel="${record.scene.channelId}">\n${record.line}` : record.line;
              inWindow = true;
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
            // send_message's stop is deferred: it only fires when no other non-trivial tool ran in the
            // same step, so a parallel switch_focus failure doesn't silently end the turn.
            const hasBlockingTool = info.result.messages.some(
              (m) =>
                m.role === "assistant" &&
                Array.isArray(m.content) &&
                m.content.some((p) => p.type === "tool-call" && p.toolName !== "send_message" && p.toolName !== "think"),
            );
            const stop = this.stopRequestedThisStep || (this.sendWantsStop && !hasBlockingTool);
            this.stopRequestedThisStep = false;
            this.sendWantsStop = false;
            return stop ? { continue: false } : undefined;
          },
          onTurnFinish: () => {
            this.stopRequestedThisStep = false;
            this.sendWantsStop = false;
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
      this.cachedInstructions = [persona, await this.renderSystemPrompt()].filter((part) => part.length > 0).join("\n\n");
    }
    if (this.cachedTools === undefined) this.cachedTools = this.buildTools();
  }

  /**
   * Renders the system prompt from the Jinja template, resolving the optional think.md overlay.
   * All template variables are configuration-time constants, so the rendered result is byte-stable.
   */
  private async renderSystemPrompt(): Promise<string> {
    // Resolve think prompt: profile data dir overrides the bundled default.
    let thinkPrompt = "";
    if (this.profile.innerThought) {
      const userThink = path.resolve(this.profileDataPath, "think.md");
      const thinkSource = existsSync(userThink) ? userThink : resourcePath("templates", "think.md");
      const thinkRaw = (await fs.readFile(thinkSource, "utf-8")).trim();
      // The think template itself may use Jinja variables.
      thinkPrompt = new Template(thinkRaw).render({
        singleScene: this.singleScene,
        allowChangeFocus: this.profile.allowChangeFocus,
        bodies: this.profile.allowedChannels,
        profileName: this.profile.name,
      });
    }

    const systemRaw = await fs.readFile(resourcePath("templates", "system.md.jinja"), "utf-8");
    return new Template(systemRaw).render({
      thinkPrompt,
      singleScene: this.singleScene,
      allowChangeFocus: this.profile.allowChangeFocus,
      bodies: this.profile.allowedChannels,
      profileName: this.profile.name,
    });
  }

  // ---------------------------------------------------------------------------
  // Typing delay (human-like pacing between bubbles)
  // ---------------------------------------------------------------------------

  /**
   * Computes a human-like typing delay for `text`, based on character count with separate CJK / latin rates,
   * randomized around the configured `charPerSecond`, clamped to `[minDelay, maxDelay]`.
   */
  private getTypingDelay(text: string): number {
    const { baseDelay, charPerSecond, minDelay, maxDelay } = this.profile.typing;
    if (charPerSecond <= 0) return minDelay;

    // Strip markup so only visible text contributes to the delay.
    const plain = h
      .parse(text)
      .filter((e) => e.type === "text")
      .map((e) => e.attrs?.content ?? String(e))
      .join("");
    if (plain.length === 0) return minDelay;

    const cjkRegex = /[\u4e00-\u9fa5]/g;
    const cjkCount = (plain.match(cjkRegex) ?? []).length;
    const latinCount = plain.length - cjkCount;

    // CJK input (pinyin) is slower; latin characters are ~1.5× faster.
    const cjkDelay = (cjkCount / charPerSecond) * 1000;
    const latinDelay = (latinCount / (charPerSecond * 1.5)) * 1000;

    // Per-character randomness weighted by character type composition.
    const cjkRandomFactor = 0.5;
    const latinRandomFactor = 0.3;
    const totalRandomness = plain.length > 0 ? (cjkCount * cjkRandomFactor + latinCount * latinRandomFactor) / plain.length : 0;
    const randomFactor = 1 + (Math.random() - 0.5) * 2 * totalRandomness;

    const computed = baseDelay + (cjkDelay + latinDelay) * randomFactor;
    return Math.max(minDelay, Math.min(computed, maxDelay));
  }

  /**
   * The tools close over this runtime: the focus they read is the live one, so a switch made mid-step
   * already applies to the rest of that step.
   */
  private buildTools(): ToolSet {
    const requestStop = () => {
      this.stopRequestedThisStep = true;
    };

    const tools: ToolSet = {};

    // -- think (optional) ---------------------------------------------------
    if (this.profile.innerThought) {
      tools.think = tool({
        description: "写下你的想法，只有你自己看得到。按 think_guide 的格式写，和本步的其他工具一起调用。",
        inputSchema: jsonSchema<{ thought: string }>({
          type: "object",
          properties: {
            thought: { type: "string", description: "按 think_guide 的格式写下你此刻的想法" },
          },
        }),
        execute: async ({ thought }) => {
          this.logger.debug(`--- 内心独白 ---\n${thought}`);
          return { ok: true as const };
        },
      });
    }

    // -- send_message -------------------------------------------------------
    tools.send_message = tool({
      description:
        '把话发出去。messages 里每一条是一个独立气泡，按顺序发出。省略 sid 和 channel 就发到当前窗口。element 模式下 <at id="…"/> 会被平台解析为 @。',
      inputSchema: jsonSchema<SendMessageInput>({
        type: "object",
        properties: {
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

            // Human-like typing delay: computed from the message text, applied before sending.
            const delay = this.getTypingDelay(content);
            if (delay > 0) await sleep(delay);

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

        if (input.continue !== true) this.sendWantsStop = true;
        return { ok: true as const, count: sent.length };
      },
    });

    // -- finish -------------------------------------------------------------
    tools.finish = tool({
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
    });

    // -- switch_focus (conditional) -----------------------------------------
    if (!this.singleScene && this.profile.allowChangeFocus) {
      tools.switch_focus = tool({
        description: "切到另一个频道的窗口。切完后本轮后续的发送默认去新频道。",
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
          this.pendingFocus = { previous: this.currentFocus, next: target, ...(input.reason === undefined ? {} : { reason: input.reason }) };
          this.currentFocus = target;
          return { ok: true as const, changed: true, target };
        },
      });
    }

    // -- peek_channel (conditional) -----------------------------------------
    if (!this.singleScene) {
      tools.peek_channel = tool({
        description: "看一眼某个频道最近的消息，不切过去，不留记录。",
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

          const lines = collectLines(await this.agent.storage.read(), target).map((rl) => rl.line);
          const recent = lines.slice(-limit);
          const text = [`<peek sid="${target.sid}" channel="${target.channelId}" count=${recent.length}>`, ...recent].join("\n");
          return { ok: true as const, target, count: recent.length, text };
        },
      });
    }

    // -- report_tool_issue --------------------------------------------------
    tools.report_tool_issue = tool({
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
        await fs.appendFile(path.resolve(this.profileDataPath, "tool_issues.log"), `[${new Date().toISOString()}] Tool: ${args.tool}, Issue: ${args.issue}\n`);
        return { success: true, message: "Noted, thanks" };
      },
    });

    return tools;
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

      // this.logger.debug(`--- Session ---\n${JSON.stringify(session, null, 2)}`);

      let result: HandlerResult | undefined;
      for (const handler of sessionHandlers) {
        result = handler(session, this.profile);
        if (result) break;
      }
      if (!result) return;
      const turnId = this.agent.send(result.message, { trigger: result.trigger, ifBusy: "join" });
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
    const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
    if (checkpoint === undefined) {
      this.generationDirty = entries.length > 0;
      return;
    }

    const after = entries.slice(entries.indexOf(checkpoint) + 1);
    const lastSwitch = findLastEntry(after, "ishiki.focus.changed");
    this.currentFocus = lastSwitch === undefined ? { ...checkpoint.data.frameFocus } : { ...lastSwitch.data.next };
    this.generationDirty = after.length > 0;
  }

  /** The workspace budget: an explicit token limit, else half of the window the model declares. */
  private resolveBudget(): void {
    // The schema always provides a default (8192), so this is never undefined at runtime.
    this.workspaceTokenLimit = this.profile.context.workspaceTokenLimit ?? DEFAULT_WORKSPACE_TOKEN_LIMIT;
  }

  private overBudget(workspace: readonly AgentEntry[]): boolean {
    let chars = 0;
    for (const entry of workspace) chars += JSON.stringify(entry).length;
    return chars / this.profile.context.charsPerToken >= this.workspaceTokenLimit;
  }

  /**
   * Renders the frame text: every admitted scene gets a rolling window of recent facts pulled from the full
   * storage stream. No distinction between "worked in" and "only heard from" — all scenes use the same rule.
   *
   * Scene admission: focus always enters; any scene whose facts appeared in this generation's workspace also enters.
   */
  private renderFrame(frameFocus: Focus, entries: readonly AgentEntry[], workspace: readonly AgentEntry[]): string {
    const now = Date.now();
    const here = sceneKey(frameFocus);
    const { historyEntries, sceneWindowMs } = this.profile.context;

    // Discover every scene that appeared in this generation (for non-focus admission).
    const scenes = new Map<string, Focus>();
    scenes.set(here, frameFocus);
    for (const entry of workspace) {
      if (entry.type !== "message") continue;
      const message = entry.data;
      if (message.role !== "custom") continue;
      const desc = eventRenders[message.type];
      if (desc) {
        const scene = desc.scene(message.data);
        const key = sceneKey(scene);
        if (!scenes.has(key)) scenes.set(key, scene);
      }
    }

    // Build one segment per scene, all from storage with the same tail + time-window rule.
    const segments: Array<{ scene: Focus; lines: string[]; dropped: number; latest: number }> = [];
    for (const [key, scene] of scenes) {
      const fresh = collectLines(entries, scene).filter((rl) => now - rl.timestamp <= sceneWindowMs);
      const kept = fresh.slice(-historyEntries);
      const lines = kept.map((rl) => rl.line);
      const dropped = Math.max(0, fresh.length - historyEntries);
      const latest = kept.at(-1)?.timestamp ?? 0;
      if (lines.length === 0 && key !== here) continue;
      segments.push({ scene, lines, dropped, latest });
    }

    const parts = [`<frame ${renderFrameHead(frameFocus, formatClock(now))}>`];

    // Focus segment first (always present, even if empty).
    const focus = segments.find((s) => sceneKey(s.scene) === here);
    parts.push(`<history sid="${frameFocus.sid}" channel="${frameFocus.channelId}" focus>`);
    if (focus && focus.dropped > 0) parts.push(`<!-- 更早 ${focus.dropped} 条已折叠 -->`);
    parts.push(...(focus?.lines ?? []));
    parts.push("</history>");

    // Other scenes sorted by recency.
    const rest = segments.filter((s) => sceneKey(s.scene) !== here).sort((a, b) => b.latest - a.latest);
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
    const workspace = sliceWorkspace(entries);
    if (workspace.length === 0) {
      this.generationDirty = false;
      return true;
    }

    // Idle is early compression, not a budget decision: folding a quiet generation while it is still small is
    // the point, since nobody is waiting for the answer. A switch is not a decision at all.
    if (reason !== "switch" && reason !== "idle" && !this.overBudget(workspace)) return false;

    const frameFocus = { ...this.currentFocus };
    const text = this.renderFrame(frameFocus, entries, workspace);
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
