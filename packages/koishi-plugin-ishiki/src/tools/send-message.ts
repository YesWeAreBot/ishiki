import { jsonSchema, tool, Tool } from "@yesimagent/core";
import { Context, h, Logger, sleep } from "koishi";

import type { TypingConfig } from "../profile.js";

export namespace SendMessageTool {
  export interface Options {
    ctx: Context;
    logger: Logger;
    /** 该实例发言所在的账号与频道；工具只发到这里，没有目标参数。 */
    sid: string;
    channelId: string;
    /** 每条消息发出前等待多久，模拟打字节奏。 */
    typing: TypingConfig;
    /** `continue` 未置真时请求结束本轮；是否真的结束由容器的步边界决定。 */
    onEndTurn: () => void;
  }
  export interface Input {
    messages: string[];
    mode?: "element" | "raw";
    continue?: boolean;
  }
  export type Output = { ok: true; count: number } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
}

export function createSendMessage(options: SendMessageTool.Options): Tool<SendMessageTool.Input, SendMessageTool.Output> {
  return tool({
    description: [
      "在当前场景里发言。这是消息到达平台的唯一途径——只有本工具发出的内容会被别人看到。",
      "说给别的场景听要用 dispatch_stimulus：本工具只发到当前频道，没有目标参数。",
      "一轮里可以多次调用。返回 {ok: true, count} 或 {ok: false, error, sent, failedAt}：sent 是已经成功发出的消息 ID，failedAt 是出错的 messages 下标；发送遇错会立即停止，failedAt 及其之后的消息都没有发出。必须检查 ok，不要假设发送成功。",
    ].join("\n"),
    inputSchema: jsonSchema<SendMessageTool.Input>({
      type: "object",
      properties: {
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
      const messages = input.messages;
      if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => typeof message !== "string" || message.length === 0)) {
        return { ok: false as const, error: { name: "InvalidInput", message: "messages 必须是非空字符串数组" }, sent: [], failedAt: 0 };
      }

      const { sid, channelId } = options;
      const bot = options.ctx.bots[sid];
      if (bot === undefined) {
        return { ok: false as const, error: { name: "BotNotFound", message: `account "${sid}" is not connected` }, sent: [], failedAt: 0 };
      }

      const sent: string[] = [];
      for (let index = 0; index < messages.length; index += 1) {
        try {
          // raw 模式走转义：写下的每个字符原样到达接收方，不需要用户自己处理元素语法。
          const content = input.mode === "raw" ? h.escape(messages[index]) : messages[index];

          // 人不是瞬间打完字的：按可见文本估算等待时间，在发送之前等掉。
          const delay = calculateTypingDelay(content, options.typing);
          if (delay > 0) await sleep(delay);

          const ids = await bot.sendMessage(channelId, content);
          sent.push(...ids);
          if (ids.length === 0) options.logger.warn(`[${sid}/${channelId}] platform returned no message id`);
        } catch (error) {
          // 平台失败带着名字（如 BotNotFound）时保留它：模型据此才知道该改地址还是重试。
          const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
          return { ok: false as const, sent, failedAt: index, error: failure };
        }
      }

      if (input.continue !== true) options.onEndTurn();
      return { ok: true as const, count: sent.length };
    },
  });
}

/**
 * 按可见字符数估算一条消息的打字延迟：CJK 与拉丁字符分别按 `charPerSecond` 与 1.5 倍速计，
 * 乘一个随机系数后夹在 `[minDelay, maxDelay]`，再加上 `baseDelay`。
 */
function calculateTypingDelay(content: string, typing: TypingConfig): number {
  const { baseDelay, charPerSecond, minDelay, maxDelay } = typing;
  if (charPerSecond <= 0) return minDelay;

  // 只算看得见的文字：元素语法不占打字时间。
  const plain = h
    .parse(content)
    .filter((element) => element.type === "text")
    .map((element) => element.attrs?.content ?? String(element))
    .join("");
  if (plain.length === 0) return minDelay;

  const cjk = (plain.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = plain.length - cjk;

  // 拼音输入比拉丁输入慢，所以拉丁按 1.5 倍速折算时间。
  const typed = (cjk / charPerSecond + latin / (charPerSecond * 1.5)) * 1000;

  // 随机波动按字符构成加权：CJK 更不稳定，拉丁更稳定。
  const spread = (cjk * 0.5 + latin * 0.3) / plain.length;
  const delay = baseDelay + typed * (1 + (Math.random() - 0.5) * 2 * spread);
  return Math.max(minDelay, Math.min(delay, maxDelay));
}
