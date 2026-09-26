import { FlexibleSchema, jsonSchema, JSONSchema7, tool, Tool } from "@yesimagent/core";
import { Logger } from "koishi";

export namespace ThinkTool {
  export interface Options {
    logger: Logger;
  }
  export interface Input {
    content: string;
  }
  export interface Output {
    ok: true;
  }
}

export function createThink(options: ThinkTool.Options): Tool<ThinkTool.Input, ThinkTool.Output> {
  return tool({
    description: "在行动前或行动间歇输出特定内容，只有你自己看得到。按 think_guide 的格式书写，可以独立成步，也可以与行动交替调用。",
    inputSchema: jsonSchema<ThinkTool.Input>({
      type: "object",
      properties: {
        content: { type: "string", description: "按 think_guide 指定的格式与要求书写内容" },
      },
    }),
    execute: async ({ content }) => {
      options.logger.debug(`--- 幕后流 ---\n${content}`);
      return { ok: true as const };
    },
  });
}

// function withInnerThought<T = any>(schema: JSONSchema7): FlexibleSchema<T & { inner_thought: string }> {
//   return jsonSchema<T & { inner_thought: string }>({
//     type: "object",
//     properties: {
//       ...schema.properties,
//       inner_thought: { type: "string", description: "按 think_guide 指定的格式与要求书写内容" },
//     },
//   });
// }
