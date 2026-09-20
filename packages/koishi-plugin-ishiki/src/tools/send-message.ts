import { jsonSchema, tool, Tool } from "@yesimagent/core";
import { Context, h, Logger, sleep } from "koishi";

import { Focus, Profile, resolveFocus } from "../profiles.js";
import type { IshikiEvent, IshikiMessageCreated } from "../types.js";

export namespace SendMessageTool {
  export interface Options {
    ctx: Context;
    profile: Profile;
    logger: Logger;
    /** The live focus, read at call time: a switch made mid-step already applies to the rest of that step. */
    currentFocus: () => Focus;
    /** A message that actually left is the mind's own fact; the runtime records it at the step boundary. */
    onSent: (sent: IshikiMessageCreated) => void;
    /** `continue` was falsy: this send ends the turn unless a non-trivial tool ran in the same step. */
    onSendEndsTurn: () => void;
  }
  export interface Input {
    sid?: string;
    channel?: string;
    messages: string[];
    mode?: "element" | "raw";
    continue?: boolean;
  }
  export type Output = { ok: true; count: number } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
}

export function createSendMessage(options: SendMessageTool.Options): Tool<SendMessageTool.Input, SendMessageTool.Output> {
  return tool({
    description: [
      "向指定频道发送消息。这是消息到达平台的唯一途径——只有本工具发出的内容会被别人看到。",
      "省略 sid 和 channel 就发到当前窗口，也可以显式发往其他允许的场景。一轮里可以多次调用。",
      "返回 {ok: true, count} 或 {ok: false, error, sent, failedAt}：sent 是已经成功发出的消息 ID，failedAt 是出错的 messages 下标；发送遇错会立即停止，failedAt 及其之后的消息都没有发出。必须检查 ok，不要假设发送成功。",
    ].join("\n"),
    inputSchema: jsonSchema<SendMessageTool.Input>({
      type: "object",
      properties: {
        sid: { type: "string", description: "账号 sid（platform:selfId）。只有要用另一个账号发送时才写；省略即 focus 所在的账号。" },
        channel: { type: "string", minLength: 1, description: "目标频道 ID。省略即 focus 的频道；填写其他频道 ID 可以发往该频道。" },
        messages: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description:
            "要发送的消息列表，每一项作为一条独立消息按顺序发出。\n让分条跟随对话节奏：快速反应和深思熟虑的解释各有恰当的时刻，不要固守习惯性的条数或长度。读者逐条看到消息，每次分条都会让半截回复单独停留片刻，只在不伤害这种「半截状态」的地方分条。事实、指令、代码、链接、结构化内容、修正，以及任何后果重大的内容，都应保持在同一条消息内。\n不要用空行分段；需要分开就分成多条消息。",
        },
        mode: {
          type: "string",
          enum: ["element", "raw"],
          description:
            'element（默认）：正文按元素语法解析，<at id="…"/> 等元素会被平台解析成真实内容。\nraw：正文作为字面量原样发送，不解析任何元素。尖括号、& 和引号都不需要转义，你写下的每个字符原样到达接收方。发送代码、日志、命令行输出、含大量特殊字符的文本，或需要精确控制每个字符时用它。',
        },
        continue: {
          type: "boolean",
          description:
            "默认 false。设为 true 时，发送后继续生成下一步，可以再调用工具或再次发送消息。需要「先回应再去做事」或「分几次发送并在中间查资料」时用它。",
        },
      },
      required: ["messages"],
    }),
    execute: async (input) => {
      const target = resolveFocus(options.profile, options.currentFocus(), input);
      if ("error" in target) return { ok: false as const, error: target.error, sent: [], failedAt: 0 };

      const messages = input.messages;
      if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => typeof message !== "string" || message.length === 0)) {
        return { ok: false as const, error: { name: "InvalidInput", message: "messages 必须是非空字符串数组" }, sent: [], failedAt: 0 };
      }
      const bot = options.ctx.bots[target.sid];
      if (!bot) return { ok: false as const, error: { name: "BotNotFound", message: `Bot with sid ${target.sid} not found` }, sent: [], failedAt: 0 };

      const platform = bot.platform!;
      const sent: string[] = [];

      for (let index = 0; index < messages.length; index += 1) {
        try {
          const content = input.mode === "raw" ? h.escape(messages[index]) : messages[index];

          // Human-like typing delay: computed from the message text, applied before sending.
          const delay = calculateTypingDelay(content, options);
          if (delay > 0) await sleep(delay);

          const ids = await bot.sendMessage(target.channelId, content);
          sent.push(...ids);
          if (ids.length === 0) {
            options.logger.warn(`平台没有返回消息 id，这条自消息不进记录：${target.sid}/${target.channelId}`);
          } else {
            options.onSent({
              platform,
              sid: target.sid,
              channelId: target.channelId,
              content: content,
              messageId: ids[0],
              timestamp: Date.now(),
              selfId: bot.selfId,
              user: { id: bot.selfId, name: bot.user?.name ?? options.profile.name },
            });
          }
        } catch (error) {
          // A platform failure carries a name worth keeping: `BotNotFound` tells the model to fix the address.
          const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
          return { ok: false as const, sent, failedAt: index, error: failure };
        }
      }

      if (input.continue !== true) options.onSendEndsTurn();
      return { ok: true as const, count: sent.length };
    },
  });
}

/**
 * Computes a human-like typing delay for `text`, based on character count with separate CJK / latin rates,
 * randomized around the configured `charPerSecond`, clamped to `[minDelay, maxDelay]`.
 */
function calculateTypingDelay(content: string, options: SendMessageTool.Options): number {
  const { baseDelay, charPerSecond, minDelay, maxDelay } = options.profile.typing;
  if (charPerSecond <= 0) return minDelay;

  // Strip markup so only visible text contributes to the delay.
  const plain = h
    .parse(content)
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
