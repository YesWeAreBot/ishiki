import { asSchema, jsonSchema, type Tool, type ToolExecutionOptions } from "@yesimagent/core";

const INTENT_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "One-line intent for this call. It survives context folding; parameters and results do not. State the purpose, not the arguments.",
} as const;

interface ObjectSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * 给工具输入加上必填的 `i`，执行前剥掉。
 *
 * 直接工具调用必须声明意图；codemode 内部的 host tool 不经过这个包装。
 * 意图随 assistant tool-call 的 input 留在会话里，折叠时只读 `input.i`。
 */
export function withIntent<I, O>(name: string, original: Tool<I, O>): Tool<I & { i: string }, O> {
  if (original.execute === undefined) return original as unknown as Tool<I & { i: string }, O>;

  const schema = asSchema(original.inputSchema);
  const source = schema.jsonSchema;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`tool "${name}" has no JSON Schema input; cannot require an intent`);
  }
  const document = source as ObjectSchema;
  if (document.type !== undefined && document.type !== "object") {
    throw new Error(`tool "${name}" input schema is ${document.type}, not an object; cannot require an intent`);
  }

  const properties = { ...document.properties, i: INTENT_SCHEMA };
  const required = [...new Set([...(document.required ?? []), "i"])];
  const inputSchema = jsonSchema({ ...document, type: "object", properties, required });

  const descriptors = Object.getOwnPropertyDescriptors(original) as Record<string, PropertyDescriptor>;
  descriptors.inputSchema = {
    enumerable: true,
    configurable: true,
    writable: true,
    value: inputSchema as unknown as Tool<I & { i: string }, O>["inputSchema"],
  };
  descriptors.execute = {
    enumerable: true,
    configurable: true,
    writable: true,
    value: (async (input: unknown, options: ToolExecutionOptions<unknown>) => {
      if (input === null || typeof input !== "object" || !("i" in input) || typeof input.i !== "string" || input.i.trim().length === 0) {
        throw new Error(`tool "${name}" requires a non-empty i intent`);
      }
      const { i: _intent, ...rest } = input as Record<string, unknown>;
      return original.execute!.call(original, rest as I, options as never);
    }) as unknown,
  };

  return Object.defineProperties({}, descriptors) as unknown as Tool<I & { i: string }, O>;
}
