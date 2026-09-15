import { existsSync, promises as fs, mkdirSync } from "fs";
import path from "path";

import { AgentEvent, AgentMessage, AgentPlugin, createAgent, createCustomMessage, createJsonlStorage, jsonSchema, tool } from "@yesimagent/core";
import { Gateway } from "@yesimagent/gateway";
import { Context, Logger, Session } from "koishi";

import { isChannelAllowed, Profile } from "./profiles.js";
import { createSendMessageTool, SendMessageTool } from "./tools.js";

export class ProfileRuntime {
  private readonly ctx: Context;
  private readonly logger: Logger;

  private readonly profile: Profile;
  private readonly gateway: Gateway;
  private readonly profileDataPath: string;

  constructor(ctx: Context, options: { profile: Profile; gateway: Gateway; profilesPath: string }) {
    this.ctx = ctx;
    this.profile = options.profile;
    this.gateway = options.gateway;
    this.logger = ctx.logger("ishiki-profile-runtime");
    const profileDataPath = path.resolve(this.ctx.baseDir, this.profile.dataPath);
    if (!existsSync(profileDataPath)) {
      mkdirSync(profileDataPath, { recursive: true });
    }
    this.profileDataPath = profileDataPath;
  }

  async start() {
    const agent = createAgent({
      model: this.gateway.languageModel(this.profile.model),
      storage: createJsonlStorage(path.resolve(this.profileDataPath, "messages.jsonl")),
      toolsContext: {
        send_message: { ctx: this.ctx, selfId: this.profile.id } satisfies SendMessageTool.ToolContext,
      },
      toolChoiceViolation: "fallback",
      plugins: [
        {
          name: "ishiki-agent-plugin",
          extendInstructions: async () => {
            const personaFile = path.resolve(this.profileDataPath, "persona.md");
            const personaContent = existsSync(personaFile) ? await fs.readFile(personaFile, "utf-8") : "";
            return `${personaContent}`;
          },
          transformEntries: (entries, options) => {
            // find and transform checkpoint entry, focus change entry
            // return plain messages for previous hook to transform into model messages
            return entries;
          },
          transformMessages: (messages, options) => {
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
          extendTools: () => {
            return {
              send_message: createSendMessageTool({ enableInnerThought: this.profile.innerThought }),
              finish: tool({
                description: "结束本轮响应",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: {
                    reason: { type: "string", description: "结束原因" },
                  },
                  required: [],
                }),
                execute: async (args, context) => {
                  return { success: true };
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
                execute: async (args, context) => {
                  await fs.appendFile(
                    path.resolve(this.profileDataPath, "tool_issues.log"),
                    `[${new Date().toISOString()}] Tool: ${args.tool}, Issue: ${args.issue}\n`,
                  );
                  return { success: true, message: "Noted, thanks" };
                },
              }),
            };
          },
          onStepFinish: (step) => {
            let continueTurn = true;
            if (step.result.finishReason === "stop") {
              continueTurn = false;
            }
            const hasToolCall = step.result.messages.some(
              (msg) => msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((c) => c.type === "tool-call"),
            );
            if (!hasToolCall) {
              continueTurn = false;
            }
            for (const msg of step.result.messages) {
              if (msg.role === "assistant" && Array.isArray(msg.content)) {
                for (const c of msg.content) {
                  if (c.type === "tool-call" && c.toolName === "send_message") {
                    // const input = c.input as SendMessageTool.Input;
                    // if (input.continue !== true) {
                    //   continueTurn = false;
                    // }
                  } else if (c.type === "tool-call" && c.toolName === "finish") {
                    continueTurn = false;
                  }
                }
              }
              if (msg.role === "tool" && Array.isArray(msg.content)) {
                for (const c of msg.content) {
                  if (c.type === "tool-result" && c.toolName === "send_message") {
                    // TODO: handle send_message tool result
                  }
                }
              }
            }
            return { continue: continueTurn };
          },
        } satisfies AgentPlugin,
      ],
    });
    await agent.init();

    this.logger.info(`Agent for profile ${this.profile.id} initialized with model ${this.profile.model}.`);

    agent.channel.subscribe("agent", (event: AgentEvent) => {
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
      if (!agent.isIdle()) {
        shouldTrigger = false;
      }
      const turnId = agent.send(message, { trigger: shouldTrigger, ifBusy: "join" });
      if (turnId) {
        this.logger.info(`Message sent to agent for profile ${this.profile.id} with turn ID ${turnId}.`);
        void (await agent.wait());
      }
    });
  }
}
