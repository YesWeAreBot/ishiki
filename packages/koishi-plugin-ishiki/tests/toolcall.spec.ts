import type { LanguageModel, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@yesimagent/core";
import { beforeAll, describe, expect, it } from "vitest";

import { createToolcallEngine } from "../src/toolcall/index.js";
import { loadParser } from "../src/toolcall/parser.js";
import { thoughtsSystemPromptTemplate } from "../src/toolcall/thoughts.engine.js";

const TOOL = {
  type: "function" as const,
  name: "peek_channel_history",
  description: "读当前频道最近的记录",
  inputSchema: { type: "object" as const, properties: {} },
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
const CONTRACT = thoughtsSystemPromptTemplate([]).split("# 可用工具")[0]!.trim();

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

  it("thoughts 引擎注入契约与工具目录，并把文本解析成 tool-call", async () => {
    const { model, seen } = stubModel('{"thoughts":"看一眼","calls":[{"name":"peek_channel_history","arguments":{}}]}');
    const wrapped = createToolcallEngine({ engine: "thoughts" }).wrap(model) as LanguageModelV4;

    const result = await wrapped.doGenerate(callOptions());

    // 提示词侧：契约与工具目录进 system，原生工具通道被摘掉。
    expect(systemText(seen[0]!)).toContain(CONTRACT);
    expect(systemText(seen[0]!)).toContain("peek_channel_history");
    expect(seen[0]!.tools).toEqual([]);
    // 响应侧：契约文本被解析成 tool-call。
    expect(result.content.filter((part) => part.type === "tool-call")).toHaveLength(1);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "tool-call", toolName: "peek_channel_history" }));
  });

  it("每个协议接的是自己的模板", async () => {
    const thoughts = stubModel("随便一段话");
    const hermes = stubModel("随便一段话");
    await (createToolcallEngine({ engine: "thoughts" }).wrap(thoughts.model) as LanguageModelV4).doGenerate(callOptions());
    await (createToolcallEngine({ engine: "hermes" }).wrap(hermes.model) as LanguageModelV4).doGenerate(callOptions());

    expect(systemText(thoughts.seen[0]!)).toContain(CONTRACT);
    expect(systemText(hermes.seen[0]!)).not.toContain(CONTRACT);
    expect(systemText(hermes.seen[0]!)).toContain("peek_channel_history");
  });
});
