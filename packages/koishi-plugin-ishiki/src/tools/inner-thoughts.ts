import { jsonSchema, type JSONSchema7, type Tool, type ToolSet } from "@yesimagent/core";
import type { Logger } from "koishi";

/**
 * 取出工具参数表的 JSON Schema。
 * 本仓库的工具一律由 `jsonSchema()` 构造；别的形态（zod、惰性、异步）在此抛错，
 * 免得工具悄悄少掉一个参数却没人发现。
 */
function schemaOf(name: string, tool: Tool): JSONSchema7 {
  const schema = (tool.inputSchema as { jsonSchema?: JSONSchema7 | PromiseLike<JSONSchema7> }).jsonSchema;
  if (schema === undefined || typeof (schema as PromiseLike<JSONSchema7>).then === "function") {
    throw new Error(`tool "${name}" does not carry a synchronous JSON Schema; withInnerThoughts only supports jsonSchema() tools`);
  }
  return schema;
}

/** 参数表前置 inner_thoughts，并在执行前把它摘下来记进日志。ponytail: 原有的 validate 不搬过来，参数表够用；哪天有工具自带 validate 再透传。 */
function withInnerThought(name: string, tool: Tool, logger: Logger): Tool {
  const schema = schemaOf(name, tool);
  const wrapped: Tool = {
    ...tool,
    inputSchema: jsonSchema({
      ...schema,
      properties: {
        inner_thoughts: {
          type: "string",
          description: "Deep inner monologue private to you only.",
        },
        ...schema.properties,
      },
    }),
  };

  const execute = tool.execute;
  if (execute === undefined) return wrapped;
  return {
    ...wrapped,
    execute: async (input, options) => {
      const { inner_thoughts: thought, ...rest } = input as Record<string, unknown>;
      if (typeof thought === "string" && thought.length > 0) logger.debug(`--- 幕后流 ---\n${thought}`);
      return execute(rest, options);
    },
  };
}

export function withInnerThoughts(tools: ToolSet, logger: Logger): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] = withInnerThought(name, tool, logger);
  }
  return wrapped;
}
