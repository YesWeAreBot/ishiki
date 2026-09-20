import { jsonSchema, tool, Tool } from "@yesimagent/core";

import { Focus, Profile, resolveFocus } from "../profiles.js";

export namespace SwitchFocusTool {
  export interface Options {
    profile: Profile;
    /** The live focus, read at call time: a staged switch has not moved it yet. */
    currentFocus: () => Focus;
    /** Stages the switch. It becomes this mind's position only when the step boundary turns it into a generation. */
    applySwitch: (previous: Focus, next: Focus, reason?: string) => void;
  }
  export interface Input {
    sid?: string;
    channel: string;
    reason?: string;
  }
  export type Output = { ok: true; changed: boolean; target: Focus } | { ok: false; error: { name: string; message: string } };
}

export function createSwitchFocus(options: SwitchFocusTool.Options): Tool<SwitchFocusTool.Input, SwitchFocusTool.Output> {
  return tool({
    description: "切到另一个频道的窗口。切换在本次 step 结束时生效，从下一个 step 起默认寻址新频道；本次 step 内的发送仍旧频道。",
    inputSchema: jsonSchema<SwitchFocusTool.Input>({
      type: "object",
      properties: {
        sid: { type: "string", description: "身体 sid（platform:selfId）；省略即当前 focus 的身体" },
        channel: { type: "string", minLength: 1, description: "目标频道 ID" },
        reason: { type: "string", description: "切换原因" },
      },
      required: ["channel"],
    }),
    execute: async (input) => {
      const current = options.currentFocus();
      const target = resolveFocus(options.profile, current, input);
      if ("error" in target) return { ok: false as const, error: target.error };

      if (target.sid === current.sid && target.channelId === current.channelId) {
        return { ok: true as const, changed: false, target };
      }
      options.applySwitch(current, target, input.reason);
      return { ok: true as const, changed: true, target };
    },
  });
}
