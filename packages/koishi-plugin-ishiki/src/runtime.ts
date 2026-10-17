import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  createAgent,
  createJsonlStorage,
  LanguageModelV4,
  ToolConflictError,
  type Agent,
  type AgentMessage,
  type AgentStorage,
  type ToolCallers,
  type ToolSet,
} from "@yesimagent/core";
import type { Logger } from "koishi";

import { Attachment, type AttachmentConfig } from "./attachment/index.js";
import { CODEMODE_TOOL, createCodemode } from "./builtin-tools/codemode.js";
import { FINISH_TOOL } from "./builtin-tools/finish.js";
import { SEND_MESSAGE_TOOL } from "./builtin-tools/send-message.js";
import { createSearchTool, SEARCH_TOOL, ToolsearchState } from "./builtin-tools/toolsearch.js";
import { createWaitTool, WAIT_TOOL, WaitConditionMachine } from "./builtin-tools/wait.js";
import type { ContextEngineInstance } from "./context/index.js";
import { createDebugPlugin } from "./debugger.js";
import { ExtensionInstance } from "./extension.js";
import type { CodemodeConfig, ToolsearchConfig } from "./profile/index.js";
import { ResourceCenter } from "./resources/center.js";
import type { IshikiEvent } from "./types.js";
import type { WakeupEngineInstance } from "./wakeup/index.js";

export interface AgentRuntimeConfig {
  id: string;
  home: string;
  model: LanguageModelV4;
  instructions: string;
  tools: ToolSet;
  extensions: ExtensionInstance[];
  context: ContextEngineInstance;
  wakeup: WakeupEngineInstance;
  codemode: CodemodeConfig;
  toolsearch: ToolsearchConfig;
  debugStream: boolean;
  logger: Logger;
  resources: ResourceCenter;
  attachment: AttachmentConfig;
}

function sendSucceeded(messages: readonly AgentMessage[]): boolean {
  let sent = false;
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== SEND_MESSAGE_TOOL) continue;
      sent = true;
      const output: unknown = part.output;
      if (output === null || typeof output !== "object") return false;
      if (!("type" in output)) return false;
      if (output.type === "error-text" || output.type === "error-json") return false;
      if ("value" in output) {
        const value: unknown = output.value;
        if (value === null || typeof value !== "object" || !("ok" in value) || value.ok !== true) return false;
      }
    }
  }
  return sent;
}

export class AgentRuntime {
  readonly id: string;
  readonly home: string;
  readonly storage: AgentStorage;
  readonly resources: ResourceCenter;
  readonly context: ContextEngineInstance;
  readonly agent: Agent;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngineInstance;
  private readonly extensions: ExtensionInstance[];
  private readonly attachment: Attachment;
  private readonly toolsearch: ToolsearchState;

  private disposeContext?: () => void;
  private disposeWakeup?: () => void;
  private readonly toolCallers: ToolCallers = {};
  private readonly initTools: ToolSet;
  private readonly condition: WaitConditionMachine;
  private readonly disposeExtensions: Array<() => void> = [];
  private readonly config: AgentRuntimeConfig;

  constructor(config: AgentRuntimeConfig) {
    this.config = config;
    this.id = config.id;
    this.home = config.home;
    this.logger = config.logger;
    this.wakeup = config.wakeup;
    this.context = config.context;
    this.extensions = config.extensions;
    this.resources = config.resources;
    this.attachment = new Attachment(config.attachment, config.resources, this);
    this.toolsearch = new ToolsearchState(config.toolsearch);
    this.initTools = config.tools;
    this.condition = new WaitConditionMachine(config.logger);

    mkdirSync(this.home, { recursive: true });
    this.storage = createJsonlStorage(path.join(this.home, "events.jsonl"));

    this.agent = createAgent({
      id: this.id,
      model: config.model,
      storage: this.storage,
      plugins: [
        {
          name: "ishiki.core",
          init: async (agent) => {
            this.disposeContext = this.context.attach?.(agent);
            this.disposeWakeup = this.wakeup.attach(agent);
            this.toolsearch.bind(agent);
            // Assemble the toolset now so the baseline catalog persists before
            // any user message: the core writes turn input only after init
            // resolves, so storage order — and therefore every request's
            // catalog slot, the first request included — is [catalog, user...].
            if (config.toolsearch.enable) {
              await this.assembleTools();
              await this.toolsearch.ensureBaselineCatalog();
            }
          },
          stop: () => {
            this.disposeWakeup?.();
            this.disposeContext?.();
          },
          transformEntries: (entries, options) => {
            return this.context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries;
          },
          transformMessages: (messages, options) => {
            return this.attachment.project(messages, options);
          },
          toModelMessages: (message: unknown) => {
            const custom = message as { role?: string; type?: string; data?: { text?: string } };
            if (custom.role !== "custom" || custom.type !== "ishiki.tools.catalog") return undefined;
            return [{ role: "user" as const, content: custom.data!.text! }];
          },
          extendInstructions: async () => {
            const parts = [config.instructions];
            for (const ext of this.extensions) {
              const contributed = await ext.extendInstructions?.();
              if (contributed !== undefined && contributed.length > 0) parts.push(contributed);
            }
            const extended = (await this.context.instructions?.()) ?? "";
            if (extended.length > 0) parts.push(extended);
            return parts.filter((text) => text.length > 0).join("\n\n");
          },
          extendTools: () => {
            return this.assembleTools();
          },
          prepareStep: (options) => {
            if (!config.toolsearch.enable) return options;
            const visible = this.toolsearch.visibleTools();
            const prior = options.activeTools;
            const activeTools = prior === undefined ? visible : [...new Set([...prior, ...visible])];
            return { ...options, activeTools };
          },
          onStepFinish: (info) => {
            // Emit at most one catalog per step, after the step's search results
            // are persisted and before the next model call; parallel searches
            // within the step coalesce into a single full-replay catalog.
            this.toolsearch.flushCatalog();
            const calls = new Set<string>();
            let sending = false;
            let continueRequested = false;
            for (const message of info.result.messages) {
              if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
              for (const part of message.content) {
                if (part.type !== "tool-call") continue;
                calls.add(part.toolName);
                if (part.toolName !== SEND_MESSAGE_TOOL) continue;
                if ((part.input as { continue?: boolean } | undefined)?.continue === true) {
                  continueRequested = true;
                  break;
                }
                sending = true;
              }
              if (continueRequested) break;
            }

            // 说话即收尾：send_message 成功且没有别的动作时关轮。wait 属于同一类收尾
            // 动作（不算「别的动作」），所以和 send_message 一起调用时照样关轮——
            // 模型不必为了声明下一个唤醒条件再多跑一步。
            if (calls.has(FINISH_TOOL) || calls.has(WAIT_TOOL)) return { continue: false };
            if (!continueRequested && sending && sendSucceeded(info.result.messages)) return { continue: false };
            return undefined;
          },
          onTurnFinish: (result) => {
            this.condition.onTurnEnd(result.status);
          },
        },
        ...(config.debugStream ? [createDebugPlugin(config.id, config.logger)] : []),
      ],
      ...(config.codemode.enable ? { toolCallers: this.toolCallers } : {}),
    });
    this.condition.bind(this.agent);

    for (const ext of this.extensions) this.attachExtension(ext);
  }

  /**
   * Merge base tools with extension contributions and builtin routing, then
   * sync the toolsearch state with the final set. Runs on every turn (core
   * `assemblePrompt`) and once at init, so both see the same assembled toolset;
   * re-entry rebuilds the routing tables instead of accumulating wrappers.
   */
  private async assembleTools(): Promise<ToolSet> {
    const merged: ToolSet = { ...this.initTools };
    for (const ext of this.extensions) {
      const contributed = await ext.extendTools?.();
      if (contributed === undefined) continue;
      for (const [name, tool] of Object.entries(contributed)) {
        if (name in merged) throw new ToolConflictError(name);
        merged[name] = tool;
      }
    }
    const final: ToolSet = { ...merged };
    if (WAIT_TOOL in merged) throw new ToolConflictError(WAIT_TOOL);
    final[WAIT_TOOL] = createWaitTool(this.condition);
    for (const name of Object.keys(this.toolCallers)) delete this.toolCallers[name];
    if (this.config.codemode.enable) {
      const sandbox = createCodemode(this.config.codemode, merged, this.config.toolsearch.enable);
      Object.assign(this.toolCallers, sandbox.callers);
      final[CODEMODE_TOOL] = sandbox.tool;
    }
    if (this.config.toolsearch.enable) final[SEARCH_TOOL] = createSearchTool(this.toolsearch);
    const wrapped = this.attachment.wrap(final);
    if (this.config.toolsearch.enable) {
      this.toolsearch.codemodeEnabled = this.config.codemode.enable;
      this.toolsearch.refresh(final, new Set(this.toolsearch.residentNames()), new Set(Object.keys(this.toolCallers)));
    }
    return wrapped;
  }

  /** attach 一次；返回值（同步或 Promise）作为 disposer 收集，失败只记录不上抛。 */
  private attachExtension(ext: ExtensionInstance): void {
    const fail = (error: unknown): void => {
      this.logger.warn(`[${this.id}] extension attach failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.debug(error);
    };
    const collect = (disposer: void | (() => void)): void => {
      if (typeof disposer === "function") this.disposeExtensions.push(disposer);
    };
    try {
      const result = ext.attach?.(this);
      if (result instanceof Promise) void result.then(collect, fail);
      else collect(result);
    } catch (error) {
      fail(error);
    }
  }

  async deliver(event: IshikiEvent): Promise<void> {
    if (event.type === "ishiki.message.created") {
      const { platform, selfId, channelId, messageId, content } = event.data;
      event.data.content = await this.attachment.capture(content, { platform, selfId, channelId, messageId });
    }

    this.agent.send(event, { trigger: false, ifBusy: "join" });
  }

  wake(prompt?: string): string | undefined {
    return this.agent.continue(prompt);
  }

  async stop(): Promise<void> {
    this.condition.dispose();
    for (const ext of this.extensions) {
      try {
        await ext.stop?.();
      } catch (error) {
        this.logger.warn(`[${this.id}] extension stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const dispose of this.disposeExtensions.splice(0)) {
      try {
        dispose();
      } catch (error) {
        this.logger.warn(`[${this.id}] extension dispose failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.agent.stop();
  }
}
