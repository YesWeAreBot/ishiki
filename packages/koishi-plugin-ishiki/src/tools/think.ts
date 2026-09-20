import { jsonSchema, tool, Tool } from "@yesimagent/core";
import { Logger } from "koishi";

export namespace ThinkTool {
  export interface Options {
    logger: Logger;
  }
  export interface Input {
    thought: string;
  }
  export interface Output {
    ok: true;
  }
}

export function createThink(options: ThinkTool.Options): Tool<ThinkTool.Input, ThinkTool.Output> {
  return tool({
    description: "写下你的想法，只有你自己看得到。按 think_guide 的格式写，和本步的其他工具一起调用。",
    inputSchema: jsonSchema<ThinkTool.Input>({
      type: "object",
      properties: {
        thought: { type: "string", description: "按 think_guide 的格式写下你此刻的想法" },
      },
    }),
    execute: async ({ thought }) => {
      options.logger.debug(`--- 内心独白 ---\n${thought}`);
      return { ok: true as const };
    },
  });
}
