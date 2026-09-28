import { jsonSchema, tool, Tool } from "@yesimagent/core";

export namespace FinishTool {
  /** 无参数：本工具的语义全在消息流里，停轮判定由 onStepFinish 读 tool-call 位完成。 */
  export type Options = Record<string, never>;
  export interface Input {
    reason?: string;
  }
  export interface Output {
    ok: true;
  }
}

export function createFinish(): Tool<FinishTool.Input, FinishTool.Output> {
  return tool({
    description: "结束本轮而不发言。看过消息但决定不回复时用它。",
    inputSchema: jsonSchema<FinishTool.Input>({
      type: "object",
      properties: {
        reason: { type: "string", description: "结束原因" },
      },
      required: [],
    }),
    execute: async () => {
      return { ok: true as const };
    },
  });
}
