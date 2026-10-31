import { asSchema, jsonSchema, tool } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import { withIntent } from "../src/builtin-tools/index.js";

const options = { toolCallId: "call-1", messages: [] } as const;

describe("withIntent", () => {
  it("adds a required i field and strips it before execute", async () => {
    let seen: unknown;
    const base = tool({
      description: "demo",
      inputSchema: jsonSchema({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
      execute: async (input: { value: string }) => {
        seen = input;
        return "ok";
      },
    });

    const wrapped = withIntent("demo", base);
    const schema = asSchema(wrapped.inputSchema).jsonSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toContain("i");
    expect(schema.properties?.i).toBeDefined();

    await expect(wrapped.execute!({ value: "a", i: "检查参数" }, options)).resolves.toBe("ok");
    expect(seen).toEqual({ value: "a" });
  });

  it("rejects a missing or blank intent", async () => {
    const wrapped = withIntent(
      "demo",
      tool({
        description: "demo",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => "ok",
      }),
    );

    await expect(wrapped.execute!({ i: "" }, options)).rejects.toThrow(/intent/);
    await expect(wrapped.execute!({ i: "   " }, options)).rejects.toThrow(/intent/);
  });
});
