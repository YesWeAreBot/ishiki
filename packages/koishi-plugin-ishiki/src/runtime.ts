import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  createAgent,
  createJsonlStorage,
  LanguageModelV4,
  ToolConflictError,
  type Agent,
  type AgentStorage,
  type ToolCallers,
  type ToolSet,
} from "@yesimagent/core";
import type { Logger } from "koishi";

import { CODEMODE_TOOL, createCodemode } from "./builtin-tools/codemode.js";
import { FINISH_TOOL } from "./builtin-tools/finish.js";
import { SEND_MESSAGE_TOOL } from "./builtin-tools/send-message.js";
import { createSearchTool, SEARCH_TOOL, ToolsearchState } from "./builtin-tools/toolsearch.js";
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
  /** Runtime-scoped resource center; extensions register schemes on it. */
  resources: ResourceCenter;
}

export class AgentRuntime {
  readonly id: string;
  readonly home: string;
  readonly storage: AgentStorage;
  readonly resources: ResourceCenter;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngineInstance;
  private readonly context: ContextEngineInstance;
  private readonly extensions: ExtensionInstance[];
  private readonly agent: Agent;
  private readonly toolsearch: ToolsearchState;

  private disposeContext?: () => void;
  private disposeWakeup?: () => void;

  constructor(config: AgentRuntimeConfig) {
    this.id = config.id;
    this.home = config.home;
    this.logger = config.logger;
    this.wakeup = config.wakeup;
    this.context = config.context;
    this.extensions = config.extensions;
    this.resources = config.resources;
    this.toolsearch = new ToolsearchState(config.toolsearch);

    mkdirSync(this.home, { recursive: true });
    this.storage = createJsonlStorage(path.join(this.home, "events.jsonl"));

    const toolCallers: ToolCallers = {};

    this.agent = createAgent({
      id: this.id,
      model: config.model,
      storage: this.storage,
      plugins: [
        {
          name: "ishiki.core",
          init: (agent) => {
            this.disposeContext = this.context.attach?.(agent);
            this.disposeWakeup = this.wakeup.attach?.(agent);
            this.toolsearch.bind(agent);
          },
          stop: () => {
            this.disposeWakeup?.();
            this.disposeContext?.();
          },
          transformEntries: (entries, options) => this.context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries,
          transformMessages: (messages, options) => this.context.renderMessages?.(messages, { turnId: options.turnId, signal: options.signal }) ?? messages,
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
          extendTools: async () => {
            const merged: ToolSet = { ...config.tools };
            for (const ext of this.extensions) {
              const contributed = await ext.extendTools?.();
              if (contributed === undefined) continue;
              for (const [name, tool] of Object.entries(contributed)) {
                if (name in merged) throw new ToolConflictError(name);
                merged[name] = tool;
              }
            }
            const base = merged;
            if (!config.codemode.enable) {
              if (config.toolsearch.enable) {
                // No sandbox: search itself is resident, everything else deferred.
                const resident = new Set(this.toolsearch.residentNames());
                const final: ToolSet = { ...base, [SEARCH_TOOL]: createSearchTool(this.toolsearch) };
                this.toolsearch.codemodeEnabled = false;
                this.toolsearch.refresh(final, resident, new Set());
                return final;
              }
              return base;
            }
            const conversation = config.toolsearch.enable;
            const sandbox = createCodemode(config.codemode, base, conversation);
            for (const name of Object.keys(toolCallers)) delete toolCallers[name];
            Object.assign(toolCallers, sandbox.callers);
            const withSandbox: ToolSet = { ...base, [CODEMODE_TOOL]: sandbox.tool };
            if (!config.toolsearch.enable) return withSandbox;
            // Sandbox on: search joins the direct-calling floor; deferred tools may
            // be routed to the sandbox per the caller table.
            const resident = new Set(this.toolsearch.residentNames());
            const final: ToolSet = { ...withSandbox, [SEARCH_TOOL]: createSearchTool(this.toolsearch) };
            this.toolsearch.codemodeEnabled = true;
            this.toolsearch.refresh(final, resident, new Set(Object.keys(sandbox.callers)));
            return final;
          },
          prepareStep: async (options) => {
            // The baseline catalog must join the FIRST request itself: joined messages only
            // flush after a step's output (core turn.ts), so anything sent during the turn
            // would be invisible to every request of that turn. Persist it now and prepend
            // the projected message to the messages about to be sent. flushCatalog's key
            // bookkeeping mirrors this emission, so a later flush only fires on real changes.
            let messages = options.messages;
            if (config.toolsearch.enable && options.stepNumber === 0) {
              const entry = await this.toolsearch.ensureBaselineCatalog();
              if (entry) {
                const projected = this.toModelMessages(entry.data);
                if (projected && projected.length > 0) messages = [...projected, ...messages];
              }
            }
            if (!config.toolsearch.enable) return { ...options, messages };
            const visible = this.toolsearch.visibleTools();
            const prior = options.activeTools;
            const activeTools = prior === undefined ? visible : [...new Set([...prior, ...visible])];
            return { ...options, messages, activeTools };
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

            let sentOk = sending;
            for (const message of info.result.messages) {
              if (!sentOk) break;
              if (message.role !== "tool" || !Array.isArray(message.content)) continue;
              for (const part of message.content) {
                if (part.type !== "tool-result" || part.toolName !== SEND_MESSAGE_TOOL) continue;
                if (part.output.type === "error-text" || part.output.type === "error-json") {
                  sentOk = false;
                  break;
                }
                const value = part.output.type === "json" ? part.output.value : undefined;
                if ((value as { ok?: boolean } | undefined)?.ok !== true) {
                  sentOk = false;
                  break;
                }
              }
            }

            const others = [...calls].some((name) => name !== FINISH_TOOL && name !== SEND_MESSAGE_TOOL);
            if (calls.has(FINISH_TOOL) || (!others && calls.has(SEND_MESSAGE_TOOL) && !continueRequested && sentOk)) {
              return { continue: false };
            }
            return undefined;
          },
        },
        ...(config.debugStream ? [createDebugPlugin(config.id, config.logger)] : []),
      ],
      ...(config.codemode.enable ? { toolCallers } : {}),
    });
  }

  async deliver(event: IshikiEvent): Promise<void> {
    if (event.type === "ishiki.message.created") {
      const { media, content } = event.data;
      // Register each media element's source URL as an asset and rewrite the
      // message content so the model sees `<img src="asset://<id>"/>` instead
      // of an expiring CDN link. Bytes fetch lazily on first `read` (or
      // sandbox mount access); the element's remaining attributes stay in
      // place, so the model still sees whatever the platform provided.
      if (media.length > 0) {
        let rewritten = content;
        for (const item of media) {
          const url = await this.resources.store.registerAsset(item.src, { mediaType: item.mediaType, filename: item.filename, sourceInfo: item.sourceInfo });
          rewritten = rewritten.split(item.src).join(url);
        }
        event.data.content = rewritten;
      }
    }
    const trigger = (await this.wakeup.decide(event)) === "trigger";
    this.agent.send(event, { trigger, ifBusy: "join" });
  }

  async stop(): Promise<void> {
    await this.agent.stop();
  }

  /** Projects a persisted catalog message to its model-visible form (shared with the plugin hook). */
  private toModelMessages(message: unknown): [{ role: "user"; content: string }] | undefined {
    const custom = message as { role?: string; type?: string; data?: { text?: string } };
    if (custom.role !== "custom" || custom.type !== "ishiki.tools.catalog") return undefined;
    return [{ role: "user", content: custom.data!.text! }];
  }
}
