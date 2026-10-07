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

import { CODE_MODE, createCodemode } from "./builtin-tools/codemode.js";
import type { ContextEngineInstance } from "./context/index.js";
import { createDebugPlugin } from "./debugger.js";
import { ExtensionInstance } from "./extension.js";
import type { CodemodeConfig } from "./profile/index.js";
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
  debugStream: boolean;
  logger: Logger;
  /** Runtime-scoped resource center; readers register schemes on it. */
  resources: ResourceCenter;
}

const FINISH_TOOL = "finish";
const SEND_MESSAGE_TOOL = "send_message";

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
          },
          stop: () => {
            this.disposeWakeup?.();
            this.disposeContext?.();
          },
          transformEntries: (entries, options) => this.context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries,
          transformMessages: (messages, options) => this.context.renderMessages?.(messages, { turnId: options.turnId, signal: options.signal }) ?? messages,
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
            if (!config.codemode.enable) return base;
            const sandbox = createCodemode(config.codemode, base);
            for (const name of Object.keys(toolCallers)) delete toolCallers[name];
            Object.assign(toolCallers, sandbox.callers);
            return { ...base, [CODE_MODE]: sandbox.tool };
          },
          onStepFinish: (info) => {
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
    const trigger = (await this.wakeup.decide(event)) === "trigger";
    this.agent.send(event, { trigger, ifBusy: "join" });
  }

  async stop(): Promise<void> {
    await this.agent.stop();
  }
}
