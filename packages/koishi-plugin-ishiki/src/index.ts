import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { Agent, AgentEvent, AgentMessage, AgentPlugin, createAgent, createCustomMessage, createJsonlStorage } from "@yesimagent/core";
import { createGateway, Gateway, GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema, Session } from "koishi";
import { parse } from "yaml";

import { createDumpFetch } from "./debug.js";
import { createSendMessageTool, type SendMessageTool } from "./tools.js";
import {} from "./types.js";

async function createPersonaPlugin(ctx: Context, config: Ishiki.Config): Promise<AgentPlugin> {
  const logger = ctx.logger("ishiki-persona-plugin");
  const personaFile = path.resolve(ctx.baseDir, config.dataPath, "persona.md");
  const personaContent = existsSync(personaFile) ? await fs.readFile(personaFile, "utf-8") : "";
  return {
    name: "ishiki-persona-plugin",
    extendInstructions() {
      return personaContent;
    },
  };
}

async function createFormatMessagePlugin(ctx: Context, config: Ishiki.Config): Promise<AgentPlugin> {
  return {
    name: "ishiki-message-plugin",
    toModelMessages: (message: AgentMessage) => {
      if (message.role === "custom" && message.type === "ishiki.message.created") {
        return [
          {
            role: "user",
            content: `[频道ID: ${message.data.channelId}] [消息ID: ${message.data.messageId}] [用户ID: ${message.data.userId}] [平台消息] ${message.data.content}`,
          },
        ];
      }
    },
  };
}

async function createToolPlugin(config: Ishiki.Config): Promise<AgentPlugin> {
  return {
    name: "ishiki-tool-plugin",
    extendTools() {
      return {
        send_message: createSendMessageTool({ enableInnerThought: config.innerThought }),
      };
    },
    // prepareStep(options) {
    //   return options.stepNumber === 0 ? { ...options, toolChoice: "required" } : options;
    // },
    afterToolCall(result) {
      if (result.toolName !== "send_message") return result;
      if (result.isError) return { ...result, endTurn: true };

      const input = result.args as SendMessageTool.Input;
      const output = result.result as SendMessageTool.Output;
      return { ...result, endTurn: output.ok === true && input.continue !== true };
    },
  };
}

class Ishiki {
  static name = "ishiki";
  static inject = [];

  public ctx: Context;
  public config: Ishiki.Config;
  public logger: Logger;

  private gateway!: Gateway;
  private cortex!: Agent;
  constructor(ctx: Context, config: Ishiki.Config) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("ishiki");
    this.logger.level = config.logLevel ?? Logger.INFO;

    ctx.on("ready", async () => {
      const modelConfigFile = path.resolve(this.ctx.baseDir, this.config.dataPath, "models.yaml");
      if (!existsSync(modelConfigFile)) {
        await fs.mkdir(path.dirname(modelConfigFile), { recursive: true });
        await fs.writeFile(modelConfigFile, "");
      }
      const modelConfigContent = await fs.readFile(modelConfigFile, "utf-8");
      const modelConfig = (parse(modelConfigContent) as GatewayConfig) ?? {};
      this.logger.info(`--- Model Config ---\n${JSON.stringify(modelConfig, null, 2)}`);
      this.gateway = createGateway({
        config: modelConfig,
        fetch: this.config.dumpRequests
          ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.ctx.baseDir, this.config.dataPath, "debug") })
          : undefined,
      });
      for (const model of this.gateway.models()) {
        this.logger.info(model);
      }

      this.cortex = createAgent({
        model: this.gateway.languageModel("deepseek:deepseek-flash"),
        storage: createJsonlStorage(path.resolve(this.ctx.baseDir, this.config.dataPath, "messages.jsonl")),
        toolsContext: {
          send_message: { ctx: this.ctx, selfId: this.config.selfId } satisfies SendMessageTool.ToolContext,
        },
        toolChoiceViolation: "fallback",
        plugins: [
          await createPersonaPlugin(this.ctx, this.config),
          await createFormatMessagePlugin(this.ctx, this.config),
          await createToolPlugin(this.config),
        ],
      });
      await this.cortex.init();

      this.cortex.channel.subscribe("agent", (event: AgentEvent) => {
        this.logger.debug(`--- Agent Event ---\n${JSON.stringify(event, null, 2)}`);
      });

      this.logger.info("Ishiki plugin is ready.");
    });

    ctx.on("internal/session", async (session: Session) => {
      if (session.selfId !== this.config.selfId) return;
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
            quote: session.quote ? { id: session.quote.id!, content: session.quote.content } : undefined,
          });
          if (
            session.isDirect ||
            session.stripped.atSelf ||
            (session.stripped.hasAt && session.elements?.some((el) => el.type === "at" && el.attrs?.id === session.selfId))
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
      const turnId = this.cortex.send(message, { trigger: shouldTrigger, ifBusy: "join" });
      await this.cortex.wait();
    });
  }
}

namespace Ishiki {
  export interface Config {
    dataPath: string;
    selfId: string;
    innerThought: boolean;
    dumpRequests: boolean;
    logLevel: number;
  }
  export const Config: Schema<Ishiki.Config> = Schema.object({
    dataPath: Schema.string().role("path").description("数据存储路径").default("data/ishiki"),
    selfId: Schema.string().description("机器人自身的 ID").default(""),
    innerThought: Schema.boolean().description("是否启用内心活动").default(false),
    dumpRequests: Schema.boolean().description("是否将请求数据保存到本地").default(false),
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default Ishiki;
