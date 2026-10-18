import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import { narrativeOptions } from "../src/narrative.js";
import { NarrativeModel } from "../src/toolcall/narrative.engine.js";

class StageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "test";
  readonly modelId = "narrative-stage";
  readonly supportedUrls = {};
  constructor(private readonly results: LanguageModelV4GenerateResult[]) {}

  async doGenerate(_options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const result = this.results.shift();
    if (result === undefined) throw new Error("unexpected stage invocation");
    return result;
  }

  async doStream(): Promise<LanguageModelV4StreamResult> {
    throw new Error("raw stages must use their own complete-output contract");
  }
}

function result(content: LanguageModelV4Content[]): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified: "stop", raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: undefined }, outputTokens: { total: 5, text: 4, reasoning: 1 } },
    warnings: [],
  };
}

function narration(kind: "action" | "reply" | "stop", extra: Record<string, unknown> = {}): LanguageModelV4GenerateResult {
  return result([
    { type: "reasoning", text: "UNRELATED_PROVIDER_REASONING" },
    { type: "text", text: JSON.stringify({ script: "She decides what to do next.", next: { kind, ...extra } }) },
  ]);
}

function options(): LanguageModelV4CallOptions {
  return {
    prompt: [
      { role: "system", content: "Respect the character's permissions. Do not create new commitments." },
      {
        role: "user",
        content: [
          { type: "text", text: "<new_events>Check the time.</new_events>", providerOptions: narrativeOptions({ kind: "input", inputEntryIds: ["source-1"] }) },
        ],
      },
    ],
    tools: [
      { type: "function", name: "clock", inputSchema: { type: "object", properties: {} } },
      {
        type: "function",
        name: "send_message",
        inputSchema: { type: "object", properties: { messages: { type: "array", items: { type: "string" } } }, required: ["messages"] },
      },
      { type: "function", name: "finish", inputSchema: { type: "object", properties: {} } },
    ],
  };
}

describe("narrative model contracts", () => {
  it("cannot bypass the reply stage by decoding send_message as an action", async () => {
    const model = new NarrativeModel({
      narrator: new StageModel([narration("action")]),
      decoder: new StageModel([result([{ type: "tool-call", toolCallId: "unauthorized-send", toolName: "send_message", input: '{"messages":["bypassed"]}' }])]),
    });
    await expect(model.doGenerate(options())).rejects.toThrow("outside this step's executable tools");
  });

  it("enforces a named tool choice instead of accepting another available action", async () => {
    const input = options();
    input.tools!.push({ type: "function", name: "weather", inputSchema: { type: "object", properties: {} } });
    input.toolChoice = { type: "tool", toolName: "clock" };
    const model = new NarrativeModel({
      narrator: new StageModel([narration("action")]),
      decoder: new StageModel([result([{ type: "tool-call", toolCallId: "wrong-tool", toolName: "weather", input: "{}" }])]),
    });
    await expect(model.doGenerate(input)).rejects.toThrow("outside this step's executable tools");
  });

  it("rejects a reply without the required cross-channel destination", async () => {
    const input = options();
    input.tools = [{ type: "function", name: "send_message", inputSchema: { type: "object", required: ["messages", "target"] } }];
    const model = new NarrativeModel({
      narrator: new StageModel([narration("reply")]),
      reply: new StageModel([result([{ type: "text", text: '{"messages":["hello"]}' }])]),
    });
    await expect(model.doGenerate(input)).rejects.toThrow('requires "target"');
  });

  it("cannot emit an action if cancellation arrives during its decoding", async () => {
    const abort = new AbortController();
    const decoder = new StageModel([result([{ type: "tool-call", toolCallId: "clock-call", toolName: "clock", input: "{}" }])]);
    const decode = decoder.doGenerate.bind(decoder);
    decoder.doGenerate = async (input) => {
      const decoded = await decode(input);
      abort.abort();
      return decoded;
    };
    const model = new NarrativeModel({ narrator: new StageModel([narration("action")]), decoder });
    await expect(model.doGenerate({ ...options(), abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("publishes only explicit narration and aggregates all stage usage", async () => {
    const narrator = new StageModel([narration("action")]);
    const decoder = new StageModel([result([{ type: "tool-call", toolCallId: "clock-call", toolName: "clock", input: "{}" }])]);
    const model = new NarrativeModel({ narrator, decoder });
    const generated = await model.doGenerate(options());
    expect(generated.content.filter((part) => part.type === "reasoning").map((part) => part.text)).toEqual(["She decides what to do next."]);
    expect(generated.usage.inputTokens).toMatchObject({ total: 20, noCache: 16, cacheRead: 4 });
    expect(generated.usage.outputTokens).toMatchObject({ total: 10, text: 8, reasoning: 2 });
  });

  it("rejects a reply when this step forbids all tool calls", async () => {
    const model = new NarrativeModel({ narrator: new StageModel([narration("reply")]) });
    await expect(model.doGenerate({ ...options(), toolChoice: { type: "none" } })).rejects.toThrow("not available");
  });
});
