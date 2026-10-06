import { jsonSchema, type JSONSchema7, type Tool, type ToolSet } from "@yesimagent/core";
import type { Logger } from "koishi";

function readSchema(name: string, tool: Tool): JSONSchema7 {
  const schema = (tool.inputSchema as { jsonSchema?: JSONSchema7 | PromiseLike<JSONSchema7> }).jsonSchema;
  if (schema === undefined || typeof (schema as PromiseLike<JSONSchema7>).then === "function") {
    throw new Error(`tool "${name}" does not carry a synchronous JSON Schema; withInnerThoughts only supports jsonSchema() tools`);
  }
  return schema;
}

function withInnerThought(name: string, tool: Tool, logger: Logger): Tool {
  const schema = readSchema(name, tool);
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
