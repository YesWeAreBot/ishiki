import { Awaitable, jsonSchema, tool, Tool } from "@yesimagent/core";

import { Focus, Profile, resolveFocus } from "../profiles.js";

/** How many lines `peek_channel` reads by default, and the most it will read in one call. */
const PEEK_DEFAULT_LIMIT = 20;
const PEEK_MAX_LIMIT = 50;

export namespace PeekChannelTool {
  export interface Options {
    profile: Profile;
    /** The live focus, read at call time. */
    currentFocus: () => Focus;
    /** The rendered lines of a scene, read at call time. */
    lines: (scene: Focus) => Awaitable<readonly string[]>;
  }
  export interface Input {
    sid?: string;
    channel: string;
    limit?: number;
  }
  export type Output = { ok: true; target: Focus; count: number; text: string } | { ok: false; error: { name: string; message: string } };
}

export function createPeekChannel(options: PeekChannelTool.Options): Tool<PeekChannelTool.Input, PeekChannelTool.Output> {
  return tool({
    description: "看一眼某个频道最近的消息，不切过去，不留记录。",
    inputSchema: jsonSchema<PeekChannelTool.Input>({
      type: "object",
      properties: {
        sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
        channel: { type: "string", minLength: 1, description: "要查看的频道 ID" },
        limit: { type: "number", description: `读取条数，默认 ${PEEK_DEFAULT_LIMIT}，上限 ${PEEK_MAX_LIMIT}` },
      },
      required: ["channel"],
    }),
    execute: async (input) => {
      const target = resolveFocus(options.profile, options.currentFocus(), input);
      if ("error" in target) return { ok: false as const, error: target.error };

      const limit = input.limit ?? PEEK_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > PEEK_MAX_LIMIT) {
        return { ok: false as const, error: { name: "LimitTooLarge", message: `limit 必须是 1 到 ${PEEK_MAX_LIMIT} 之间的整数` } };
      }

      const lines = await options.lines(target);
      const recent = lines.slice(-limit);
      const text = [`<peek sid="${target.sid}" channel="${target.channelId}" count=${recent.length}>`, ...recent].join("\n");
      return { ok: true as const, target, count: recent.length, text };
    },
  });
}
