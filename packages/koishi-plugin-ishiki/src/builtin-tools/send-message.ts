import { jsonSchema, tool, Tool } from "@yesimagent/core";
import { Context, h, Logger, sleep } from "koishi";

import type { InstanceDomain, TypingConfig } from "../profile/index.js";

export namespace SendMessageTool {
  export interface Options {
    ctx: Context;
    logger: Logger;
    domain: InstanceDomain;
    typing: TypingConfig;
  }
  export interface Input {
    messages: string[];
    mode?: "element" | "raw";
    continue?: boolean;
    target?: string;
  }
  export type Output = { ok: true; ids: string[] } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
}

export function createSendMessage(options: SendMessageTool.Options): Tool<SendMessageTool.Input, SendMessageTool.Output> {
  const { ctx, logger, domain, typing } = options;

  return tool({
    description: "send message to the channel",
    inputSchema: jsonSchema<SendMessageTool.Input>({
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "string" }, minItems: 1, description: "messages to send" },
        mode: { type: "string", enum: ["element", "raw"], description: "message mode" },
        continue: { type: "boolean", description: "whether to continue sending messages after a failure" },
        target: { type: "string", description: "target user id for private message" },
      },
      required: ["messages"],
    }),
    execute: async (input) => {
      const sentMessages = [];
      for (const message of input.messages) {
        try {
          const delay = calculateTypingDelay(message, typing);
          await sleep(delay);
          if (input.mode === "element") {
            // await ctx.sendMessage(domain, h.parse(message), { target: input.target });
          } else {
            // await ctx.sendMessage(domain, h.text(message), { target: input.target });
          }
          sentMessages.push(message);
        } catch (error) {
          logger.warn("Failed to send message: %o", error);
          // return { ok: false, error: { name: error.name, message: error.message }, sent: sentMessages, failedAt: sentMessages.length };
        }
      }
      return { ok: true };
    },
  });
}

function calculateTypingDelay(content: string, typing: TypingConfig): number {
  const { baseDelay, charPerSecond, minDelay, maxDelay } = typing;
  if (charPerSecond <= 0) return minDelay;

  const plain = h
    .parse(content)
    .filter((element) => element.type === "text")
    .map((element) => element.attrs?.content ?? String(element))
    .join("");
  if (plain.length === 0) return minDelay;

  const cjk = (plain.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = plain.length - cjk;

  const typed = (cjk / charPerSecond + latin / (charPerSecond * 1.5)) * 1000;

  const spread = (cjk * 0.5 + latin * 0.3) / plain.length;
  const delay = baseDelay + typed * (1 + (Math.random() - 0.5) * 2 * spread);
  return Math.max(minDelay, Math.min(delay, maxDelay));
}
