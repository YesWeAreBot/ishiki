import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import { Template } from "@huggingface/jinja";
import {
  Agent,
  AgentEntry,
  AgentEvent,
  AgentPlugin,
  AgentStorage,
  createAgent,
  createCustomMessage,
  createEntry,
  createJsonlStorage,
  ToolSet,
} from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, Logger, Session } from "koishi";

import { ContextEngine, findLastEntry, sliceWorkspace } from "./context-engine.js";
import { Focus, isChannelAllowed, Profile } from "./profiles.js";
import { SessionHandler } from "./session-handler.js";
import { createFinish, createPeekChannel, createReportToolIssue, createSendMessage, createSwitchFocus, createThink } from "./tools/index.js";
import type { IshikiCheckpointEntry, IshikiMessageCreated } from "./types.js";
import { WeakUpEngine } from "./weakup-engine.js";

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

/** Used when the model declares no window: the workspace budget is half of it, this is the floor. */
const DEFAULT_WORKSPACE_TOKEN_LIMIT = 8192;
const IDLE_CHECK_INTERVAL_MS = 60_000;

export class ProfileRuntime {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly profile: Profile;
  private readonly gateway: Gateway;
  private readonly profileDataPath: string;
  /** Whether this profile has multiple scenes (bodies × channels > 1). */
  private readonly singleScene: boolean;
  /** The profile's ingress: sessions become the facts of its stream. */
  private readonly sessionHandler: SessionHandler;
  /** The single yes-or-no behind every wake: does this event start a turn? */
  private readonly weakup: WeakUpEngine;
  /** The projection: every part of the model context that is not a prompt part. */
  private readonly context: ContextEngine;

  private agent: Agent;
  private storage: AgentStorage;

  /**
   * The scene this mind sits in. `switch_focus` only stages a move; the focus changes when the step boundary
   * turns it into a generation, and a checkpoint that will not write leaves the mind where it was.
   */
  private currentFocus: Focus;
  private pendingFocus: { previous: Focus; next: Focus; reason?: string } | null = null;
  /** Messages a step actually sent; like a monologue, each lands as an ordinary fact at the step boundary. */
  private pendingSelfMessages: IshikiMessageCreated[] = [];
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
    this.sessionHandler = new SessionHandler(this.profile);
    this.weakup = new WeakUpEngine({ ctx: this.ctx, profile: this.profile, currentFocus: () => this.currentFocus });
    this.context = new ContextEngine({ profile: this.profile });

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
          /** The whole projection lives in `ContextEngine`; this hook is only where it attaches. */
          transformEntries: (entries) => this.context.project(entries),
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
            // from its result. The move is atomic — a checkpoint that will not write leaves the mind behind.
            const pending = this.pendingFocus;
            if (pending !== null) {
              this.currentFocus = { ...pending.next };
              if (await this.rebuild("switch")) {
                this.pendingFocus = null;
              } else {
                this.currentFocus = { ...pending.previous };
                this.logger.warn("换代的 checkpoint 未写入，本次切换不生效。");
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

  /**
   * The tools close over this runtime: the focus they read is the live one, which a staged switch has not moved.
   */
  private buildTools(): ToolSet {
    const requestStop = () => {
      this.stopRequestedThisStep = true;
    };

    const tools: ToolSet = {};

    // -- think (optional) ---------------------------------------------------
    if (this.profile.innerThought) tools.think = createThink({ logger: this.logger });

    // -- send_message -------------------------------------------------------
    tools.send_message = createSendMessage({
      ctx: this.ctx,
      profile: this.profile,
      logger: this.logger,
      currentFocus: () => this.currentFocus,
      onSent: (sent) => this.pendingSelfMessages.push(sent),
      onSendEndsTurn: () => {
        this.sendWantsStop = true;
      },
    });

    // -- finish -------------------------------------------------------------
    tools.finish = createFinish({ onStop: requestStop });

    // -- switch_focus (conditional) -----------------------------------------
    if (!this.singleScene && this.profile.allowChangeFocus) {
      tools.switch_focus = createSwitchFocus({
        profile: this.profile,
        // A staged switch has not moved the mind, so this tool reads where the mind believes it stands: a second
        // switch in the same step reads the first one's target and the hop back is a real move. Every other tool
        // reads the live focus.
        currentFocus: () => this.pendingFocus?.next ?? this.currentFocus,
        applySwitch: (previous, next, reason) => {
          this.pendingFocus = { previous, next, ...(reason === undefined ? {} : { reason }) };
        },
      });
    }

    // -- peek_channel (conditional) -----------------------------------------
    if (!this.singleScene) {
      tools.peek_channel = createPeekChannel({
        profile: this.profile,
        currentFocus: () => this.currentFocus,
        lines: async (scene) => this.context.lines(await this.agent.storage.read(), scene).map((read) => read.line),
      });
    }

    // -- report_tool_issue --------------------------------------------------
    tools.report_tool_issue = createReportToolIssue({ logPath: path.resolve(this.profileDataPath, "tool_issues.log") });

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

      const event = this.sessionHandler.handle(session);
      if (event === undefined) return;

      // Where it stands decides whether it can wake the mind; where it cannot, it may be retold as one that can.
      const trigger = this.weakup.handleEvent(event);
      const retellings = trigger ? [] : this.weakup.escalate(event);

      const turnId = this.agent.send(event, { trigger, ifBusy: "join" });
      if (turnId) {
        this.logger.info(`Message sent to agent for profile ${this.profile.id} with turn ID ${turnId}.`);
        void (await this.agent.wait());
      }

      for (const notification of retellings) {
        // The engine has the last word even over a retelling it produced itself.
        if (!this.weakup.handleEvent(notification)) continue;
        const retold = this.agent.send(notification, { trigger: true, ifBusy: "join" });
        if (retold) {
          this.logger.info(`Notification sent to agent for profile ${this.profile.id} with turn ID ${retold}.`);
          void (await this.agent.wait());
        }
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
    const text = this.context.openingFrame(frameFocus);
    const record: IshikiCheckpointEntry = { frameFocus, text, createdAt: Date.now() };

    try {
      await this.storage.append(createEntry("ishiki.checkpoint", record));
    } catch (error) {
      // The projection derives a head on its own, so a failed opening frame costs the greeting, not the run.
      this.logger.warn(`开局帧写入失败，本代由投影自行给出位置：${String(error)}`);
    }
  }

  /**
   * The live focus is the scene the last checkpoint says this generation is in; only a profile without any
   * checkpoint falls back to the configured `initialFocus`. The frame needs no restoring — it lives in the
   * checkpoint payload and the projection reads it from the entry stream.
   */
  private async restoreContext(): Promise<void> {
    const entries = await this.storage.read();
    const checkpoint = findLastEntry(entries, "ishiki.checkpoint");
    if (checkpoint === undefined) {
      this.generationDirty = entries.length > 0;
      return;
    }

    this.currentFocus = { ...checkpoint.data.frameFocus };
    this.generationDirty = entries.length > entries.indexOf(checkpoint) + 1;
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
   * The only materialized write. A failure leaves the generation untouched so the next trigger retries it.
   * A switch forces the write — a switch *is* the generation change — and the new frame then carries the ended
   * generation's trajectory, because it is built from the previous checkpoint's focus. Its success is what makes
   * a switch atomic: until the write lands, the mind keeps the position it started the step in.
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
    const text = this.context.renderFrame(frameFocus, entries, workspace);
    const record: IshikiCheckpointEntry = {
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
