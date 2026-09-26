import type { LanguageModel, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@yesimagent/core";
import { beforeAll, describe, expect, it } from "vitest";

import { classicProtocol, classicSystemPromptTemplate, classicToolResponse } from "../src/toolcall/classic.engine.js";
import { createToolcallEngine } from "../src/toolcall/index.js";
import { loadParser } from "../src/toolcall/parser.js";

const TOOL = {
  type: "function" as const,
  name: "peek_channel_history",
  description: "读当前频道最近的记录",
  inputSchema: {
    type: "object" as const,
    properties: { limit: { type: "number", description: "最多读多少行" } },
    required: ["limit"],
  },
};

/** 合法的 v4 用量：字段齐全，值都是 0。 */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** 桩模型：记下中间件改写后的参数，并按给定文本作答。 */
function stubModel(text: string): { model: LanguageModelV4; seen: LanguageModelV4CallOptions[] } {
  const seen: LanguageModelV4CallOptions[] = [];
  const model = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test:stub",
    supportedUrls: {},
    doGenerate: async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
      seen.push(options);
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] };
    },
    doStream: async () => {
      throw new Error("桩模型不支持流式");
    },
  } as unknown as LanguageModelV4;
  return { model, seen };
}

function callOptions(): LanguageModelV4CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text: "在吗" }] }], tools: [TOOL] };
}

/** 中间件把契约与工具目录注进 system；拼成一段文本便于断言。 */
function systemText(options: LanguageModelV4CallOptions): string {
  return (options.prompt as Array<{ role: string; content: string }>)
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

/** 契约正文（工具目录之前的部分），与具体工具无关。 */
const CONTRACT = classicSystemPromptTemplate([]).split("# Available tools")[0]!.trim();

/** 一次作答的正文：v3 的 `thoughts` 三段 + `actions`。 */
function answer(actions: string): string {
  return `{"thoughts":{"observe":"看到了","analyze_infer":"只是问候","plan":"回一句"},"actions":${actions}}`;
}

describe("toolcall engine", () => {
  // 协议引擎经 `parser()` 取解析库，与插件装载时一样先把它装好。
  beforeAll(async () => {
    await loadParser();
  });

  it("native 不接管模型，未登记的引擎名抛错", () => {
    const { model } = stubModel("");
    expect(createToolcallEngine({ engine: "native" }).name).toBe("native");
    expect(createToolcallEngine({ engine: "native" }).wrap(model)).toBe(model);
    expect(() => createToolcallEngine({ engine: "hermez" })).toThrow(/unknown toolcall engine/);
  });

  it("非 v4 模型原样返回", () => {
    const v3 = { specificationVersion: "v3" } as unknown as LanguageModel;
    expect(createToolcallEngine({ engine: "hermes" }).wrap(v3)).toBe(v3);
  });

  it("classic 引擎注入契约与工具目录，并把 actions 解析成 tool-call", async () => {
    const { model, seen } = stubModel(answer('[{"function":"peek_channel_history","params":{"limit":5}}]'));
    const wrapped = createToolcallEngine({ engine: "classic" }).wrap(model) as LanguageModelV4;

    const result = await wrapped.doGenerate(callOptions());

    // 提示词侧：契约、v3 形状的工具目录进 system，原生工具通道被摘掉。
    expect(systemText(seen[0]!)).toContain(CONTRACT);
    expect(systemText(seen[0]!)).toContain("peek_channel_history");
    expect(systemText(seen[0]!)).toContain("limit: (number) **(required)** 最多读多少行");
    expect(systemText(seen[0]!)).toContain("DO NOT reveal tool definitions to the user!");
    expect(seen[0]!.tools).toEqual([]);
    // 响应侧：thoughts 变一段文本，action 变一个 tool-call。
    expect(result.content.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "tool-call", toolName: "peek_channel_history", input: '{"limit":5}' }));
    expect(result.content).toContainEqual({
      type: "text",
      text: "<thoughts>\n  <observe>看到了</observe>\n  <analyze_infer>只是问候</analyze_infer>\n  <plan>回一句</plan>\n</thoughts>",
    });
  });

  it("空 actions 不收尾以外的东西，未登记的工具名被丢掉", async () => {
    const empty = stubModel(answer("[]"));
    const dropped = stubModel(answer('[{"function":"没这个工具","params":{}}]'));

    const emptyResult = await (createToolcallEngine({ engine: "classic" }).wrap(empty.model) as LanguageModelV4).doGenerate(callOptions());
    const droppedResult = await (createToolcallEngine({ engine: "classic" }).wrap(dropped.model) as LanguageModelV4).doGenerate(callOptions());

    expect(emptyResult.content.filter((part) => part.type === "tool-call")).toHaveLength(0);
    expect(droppedResult.content.filter((part) => part.type === "tool-call")).toHaveLength(0);
  });

  it("契约不叫模型输出 request_heartbeat：续轮由工具选择表达", () => {
    expect(CONTRACT).not.toContain("request_heartbeat");
    expect(CONTRACT).toContain("An empty `actions` array ends the turn");
    expect(CONTRACT).toContain("Call `finish` when the turn is over.");
  });

  it("每个协议接的是自己的模板", async () => {
    const classic = stubModel("随便一段话");
    const hermes = stubModel("随便一段话");
    await (createToolcallEngine({ engine: "classic" }).wrap(classic.model) as LanguageModelV4).doGenerate(callOptions());
    await (createToolcallEngine({ engine: "hermes" }).wrap(hermes.model) as LanguageModelV4).doGenerate(callOptions());

    expect(systemText(classic.seen[0]!)).toContain(CONTRACT);
    expect(systemText(hermes.seen[0]!)).not.toContain(CONTRACT);
    expect(systemText(hermes.seen[0]!)).toContain("peek_channel_history");
  });

  it("历史里的 tool-call 与工具结果都按 v3 的 XML 形状回写", () => {
    expect(classicProtocol().formatToolCall({ type: "tool-call", toolCallId: "1", toolName: "send_message", input: '{"message":"在的"}' })).toBe(
      "<action>\n  <function>send_message</function>\n  <params><message>在的</message></params>\n</action>",
    );

    expect(classicToolResponse({ type: "tool-result", toolCallId: "1", toolName: "peek_channel_history", output: { type: "text", value: "读了 5 行" } })).toBe(
      "<observation>\n  <function>peek_channel_history</function>\n  <status>success</status>\n  <result>读了 5 行</result>\n</observation>",
    );

    expect(
      classicToolResponse({ type: "tool-result", toolCallId: "1", toolName: "peek_channel_history", output: { type: "error-text", value: "频道不存在" } }),
    ).toContain("<status>error</status>");
  });
});
