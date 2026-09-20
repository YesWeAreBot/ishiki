import { jsonSchema, tool, Tool } from "@yesimagent/core";

export namespace FinishTool {
  export interface Options {
    /** Ends the turn without speaking. */
    onStop: () => void;
  }
  export interface Input {
    reason?: string;
  }
  export interface Output {
    ok: true;
  }
}

export function createFinish(options: FinishTool.Options): Tool<FinishTool.Input, FinishTool.Output> {
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
      options.onStop();
      return { ok: true as const };
    },
  });
}
