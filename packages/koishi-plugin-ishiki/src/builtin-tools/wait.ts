import { jsonSchema, tool, type Tool } from "@yesimagent/core";

import type { WaitConditionMachine } from "../condition.js";

export const WAIT_TOOL = "wait";

export namespace WaitTool {
  export interface Input {
    /** Wake after this many new inbound messages. */
    msgs?: number;
    /** Wake after this many seconds, regardless of new input. */
    secs?: number;
  }
  export interface Output {
    ok: boolean;
    /** The declared windows; absent together with none means nothing was declared. */
    declared?: { msgs?: number; secs?: number };
    /** Set when nothing was declared: only signals and external wakes can open the next turn. */
    none?: boolean;
    error?: string;
  }
}

const MAX_MSGS = 1000;
const MAX_SECS = 86_400;

export function createWaitTool(machine: WaitConditionMachine): Tool<WaitTool.Input, WaitTool.Output> {
  return tool({
    description:
      "declare when to be woken next; last call in a waking wins, effective when it ends. " +
      "{msgs: N} = after N new inputs, {secs: T} = after T seconds, whichever comes first. " +
      "It is a one-off, not a recurring timer: one declaration wakes you once and is then spent. " +
      "See the Pacing section of your instructions for how to choose.",
    inputSchema: jsonSchema<WaitTool.Input>({
      type: "object",
      properties: {
        msgs: { type: "integer", minimum: 0, maximum: MAX_MSGS, description: "new inbound messages before the next waking" },
        secs: { type: "integer", minimum: 1, maximum: MAX_SECS, description: "seconds until the next waking regardless of input" },
      },
      required: [],
    }),
    execute: async (input): Promise<WaitTool.Output> => {
      if (input.msgs !== undefined && (!Number.isInteger(input.msgs) || input.msgs < 0 || input.msgs > MAX_MSGS)) {
        return { ok: false, error: `msgs must be an integer between 0 and ${MAX_MSGS}` };
      }
      if (input.secs !== undefined && (!Number.isInteger(input.secs) || input.secs < 1 || input.secs > MAX_SECS)) {
        return { ok: false, error: `secs must be an integer between 1 and ${MAX_SECS}` };
      }
      // 回显真正生效的条件：未声明时明确告诉模型这一轮之后没有自动唤醒。
      const outcome = machine.declare(input);
      return outcome === undefined ? { ok: true, none: true } : { ok: true, declared: outcome.condition };
    },
  });
}
