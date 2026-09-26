import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MockLanguageModelV4,
  createAgent,
  createCustomMessage,
  createMemoryStorage,
  jsonSchema,
  simulateReadableStream,
  tool,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import type { Logger } from "koishi";
import { beforeAll, describe, expect, it } from "vitest";

import { ClassicContextEngine } from "../src/context/classic.engine.js";
import { createToolcallEngine } from "../src/toolcall/index.js";
import { loadParser } from "../src/toolcall/parser.js";
import type { IshikiMessageCreated } from "../src/types.js";

const RESOURCES = fileURLToPath(new URL("../resources", import.meta.url));
const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

/** 流式作答：中间件把整段缓冲起来，在流末尾解析。 */
function reply(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

function answer(actions: string): string {
  return `{"thoughts":{"observe":"看到新消息","analyze_infer":"需要先看看记录","plan":"读记录再看"},"actions":${actions}}`;
}

/** 每一步的提示词都记下来，断言模型实际收到了什么。 */
function promptOf(prompt: unknown, role: string): string {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  return messages
    .filter((message) => message.role === role)
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ type: string; text?: string }>).map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join(""),
    )
    .join("\n\n");
}

function incoming(content: string) {
  const data: IshikiMessageCreated = {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "bot",
    channelId: "room",
    messageId: "m1",
    content,
    isDirect: false,
    user: { id: "u1", name: "Neko" },
  };
  return createCustomMessage("ishiki.message.created", data);
}

describe("classic 三件套跑一轮真实轮次", () => {
  beforeAll(async () => {
    await loadParser();
  });

  it("system 里是契约、工具目录与 classic 的世界观说明；world_state 每步重建", async () => {
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const answers = [answer('[{"function":"peek_channel_history","params":{"limit":5}}]'), answer("[]")];

    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        prompts.push(request.prompt as Array<{ role: string; content: unknown }>);
        const text = answers[Math.min(prompts.length - 1, answers.length - 1)]!;
        return { stream: simulateReadableStream({ chunks: reply(text) }) };
      },
    });

    const tools = {
      peek_channel_history: tool({
        description: "读当前频道最近的记录",
        inputSchema: jsonSchema<{ limit?: number }>({ type: "object", properties: { limit: { type: "number" } }, required: [] }),
        execute: async () => "读了 5 行",
      }),
    };

    const context = new ClassicContextEngine({ logger, resources: RESOURCES, directory: path.join(tmpdir(), "ishiki-classic-absent") });
    const agent = createAgent({
      id: "classic-trio",
      model: createToolcallEngine({ engine: "classic" }).wrap(model),
      instructions: "You are Ishiki.",
      storage: createMemoryStorage(),
      plugins: [context],
      tools,
    });

    agent.send(incoming("在吗"), { trigger: true });
    await agent.wait();

    expect(prompts).toHaveLength(2);

    // 第一步：契约、v3 形状的工具目录、classic 的世界观说明都在 system 里
    const first = prompts[0]!;
    expect(promptOf(first, "system")).toContain("You are Ishiki.");
    expect(promptOf(first, "system")).toContain("# Reasoning: think–act cycle");
    expect(promptOf(first, "system")).toContain("limit: (number)");
    expect(promptOf(first, "system")).toContain("# Context: world view");

    // 第一步的 user 侧是一整份 world_state，消息落在 new_events
    expect(promptOf(first, "user")).toContain("<world_state>");
    expect(promptOf(first, "user")).toContain('<channel id="room" type="guild" platform="onebot">');
    expect(promptOf(first, "user").split("<new_events>")[1]).toContain("在吗");

    // 第二步：上一步的思考与动作退到 processed_events，工具结果成为唯一的新到事件
    const second = prompts[1]!;
    const world = promptOf(second, "user");
    const processed = world.split("<processed_events>")[1]!.split("</processed_events>")[0]!;
    const fresh = world.split("<new_events>")[1]!;
    expect(processed).toContain("在吗");
    expect(processed).toContain("<thoughts>");
    expect(processed).toContain("<action>");
    expect(processed).not.toContain("<observation>");
    expect(fresh).toContain("<observation>");
    expect(fresh).toContain("读了 5 行");

    await agent.stop();
  });
});
