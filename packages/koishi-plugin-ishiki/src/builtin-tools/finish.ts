import { jsonSchema, tool, Tool } from "@yesimagent/core";

export namespace FinishTool {
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
    description: "finish the current turn",
    inputSchema: jsonSchema<FinishTool.Input>({
      type: "object",
      properties: {
        reason: { type: "string", description: "finish reason" },
      },
      required: [],
    }),
    execute: async () => {
      return { ok: true as const };
    },
  });
}
