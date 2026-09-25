import { jsonSchema, tool, Tool } from "@yesimagent/core";

/** 默认读取行数与单次上限。 */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

export namespace PeekChannelHistoryTool {
  export interface Options {
    /** 提问的实例：`sid` 省略时以它为默认目标账号。 */
    self: { sid: string; channelId: string };
    /** 读取目标频道的记录行；该频道不属于本 profile 时返回 undefined。 */
    peek: (target: { sid: string; channelId: string; limit: number }) => Promise<readonly string[] | undefined>;
  }
  export interface Input {
    sid?: string;
    channelId: string;
    limit?: number;
  }
  export type Output = { ok: true; target: string; count: number; text: string } | { ok: false; error: { name: string; message: string } };
}

export function createPeekChannelHistory(options: PeekChannelHistoryTool.Options): Tool<PeekChannelHistoryTool.Input, PeekChannelHistoryTool.Output> {
  return tool({
    description: [
      "跨场景的只读通道。读取另一个场景的近期事实行，不切换场景、不写入、不触发对方的轮次。",
      "仅用于其他场景。本场景的消息已由上下文提供，不要用它读取本场景。",
      "可达范围限于本 profile 名下的场景；返回行的格式与上下文中的事实行一致。",
    ].join("\n"),
    inputSchema: jsonSchema<PeekChannelHistoryTool.Input>({
      type: "object",
      properties: {
        sid: { type: "string", description: "账号 sid（platform:selfId）；省略即当前场景的账号" },
        channelId: { type: "string", minLength: 1, description: "要查看的频道 ID" },
        limit: { type: "number", description: `读取条数，默认 ${PEEK_DEFAULT_LIMIT}，上限 ${PEEK_MAX_LIMIT}` },
      },
      required: ["channelId"],
    }),
    execute: async (input) => {
      const channelId = input.channelId;
      if (typeof channelId !== "string" || channelId.length === 0) {
        return { ok: false as const, error: { name: "InvalidInput", message: "channelId 必须是非空字符串" } };
      }

      const limit = input.limit ?? PEEK_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > PEEK_MAX_LIMIT) {
        return { ok: false as const, error: { name: "InvalidLimit", message: `limit 必须是 1 到 ${PEEK_MAX_LIMIT} 之间的整数` } };
      }

      const sid = input.sid ?? options.self.sid;
      const lines = await options.peek({ sid, channelId, limit });
      if (lines === undefined) {
        return { ok: false as const, error: { name: "TargetNotAllowed", message: `"${sid} / ${channelId}" 不在本 profile 名下，看不到那边` } };
      }

      const recent = lines.slice(-limit);
      const text = [`<peek sid="${sid}" channel="${channelId}" count=${recent.length}>`, ...recent].join("\n");
      return { ok: true as const, target: `${sid}/${channelId}`, count: recent.length, text };
    },
  });
}
