import {
  MockLanguageModelV4,
  createAgent,
  createCustomMessage,
  createEntry,
  createMemoryStorage,
  createToolMessage,
  simulateReadableStream,
  type Agent,
  type AgentEntry,
  type AgentMessage,
  type AgentStorage,
  type LanguageModelV4StreamPart,
} from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import { StandardContextEngine, collapse } from "../src/context-engine.js";

const USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
const calls = { count: 0 };

function mockModel(text: string, fails = false): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls.count += 1;
      if (fails) throw new Error("boom");
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] };
    },
  });
}

function fakeAgent(storage: AgentStorage<AgentEntry>, model: MockLanguageModelV4): Agent {
  return { storage, getModel: () => model } as unknown as Agent;
}

/** A message line long enough that a handful of them exceeds a small budget. */
function message(id: string): AgentMessage {
  return createCustomMessage("ishiki.message.created", {
    timestamp: 1,
    platform: "onebot",
    selfId: "1",
    channelId: "group:2",
    isDirect: false,
    messageId: `m-${id}`,
    content: `${id} `.padEnd(80, "x"),
    user: { id: "42", name: "Miaow" },
  });
}

/** One streamed text answer, the shape the SDK's mock model expects. */
function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

function entry(id: string, data: AgentMessage): AgentEntry {
  return createEntry("message", data, { id });
}

function compacts(entries: readonly AgentEntry[]): Array<AgentEntry<"ishiki.compact">> {
  return entries.filter((item): item is AgentEntry<"ishiki.compact"> => item.type === "ishiki.compact");
}

function lines(entries: readonly AgentEntry[]): string[] {
  return entries.filter((item) => item.type === "message").map((item) => (item.type === "message" ? String(item.data.role) : ""));
}

describe("collapse", () => {
  it("folds consecutive lines into one user message and lets tool traces cut the run", () => {
    const tool = createToolMessage([{ type: "tool-result", toolCallId: "call-1", toolName: "peek", output: { type: "text", value: "ok" } }]);
    const collapsed = collapse([message("a"), message("b"), tool, message("c")]);

    expect(collapsed).toHaveLength(3);
    expect(collapsed[0].role).toBe("user");
    expect(String(collapsed[0].content)).toContain("m-a");
    expect(String(collapsed[0].content)).toContain("m-b");
    expect(collapsed[1].role).toBe("tool");
    expect(collapsed[2].role).toBe("user");
  });
});

describe("standard context engine", () => {
  it("passes the entries through while they fit, and writes nothing", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 10_000 });
    engine.init(fakeAgent(storage, mockModel("记忆")));

    const entries = ["a", "b"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    calls.count = 0;
    const out = await engine.transformEntries([...entries]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("e-a");
    expect(calls.count).toBe(0);

    // 没超预算就没什么可压的：轮次结束也不调模型
    engine.onTurnFinish();
    await engine.settle();
    expect(calls.count).toBe(0);
    expect(compacts(await storage.read())).toHaveLength(0);
  });

  it("trims the oldest lines in the foreground, then folds them into a memory line once the turn ends", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 300, refillRatio: 0.8 });
    engine.init(fakeAgent(storage, mockModel("记住：她在准备搬家")));

    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    // 前台：裁剪是同步的，不问模型，也不写流
    calls.count = 0;
    const out = await engine.transformEntries([...(await storage.read())]);
    expect(calls.count).toBe(0);
    expect(out.length).toBeLessThan(entries.length);
    expect(compacts(await storage.read())).toHaveLength(0);

    // 后台：一轮结束后并入摘要
    engine.onTurnFinish();
    await engine.settle();

    const written = compacts(await storage.read());
    expect(written).toHaveLength(1);
    expect(written[0].data.summary).toBe("记住：她在准备搬家");
    expect(calls.count).toBe(1);

    const kept = out.filter((item) => item.type === "message" && item.id.startsWith("e-")).map((item) => item.id);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(entries.slice(entries.length - kept.length).map((item) => item.id));

    // 水位停在被裁掉的最后一条；切点落在行上，不落在工具轨迹中间
    const anchor = entries.findIndex((item) => item.id === kept[0]);
    expect(written[0].data.lastEntryId).toBe(entries[anchor - 1].id);
    const first = out.find((item) => item.id === kept[0]);
    expect(first?.type === "message" && ["user", "custom"]).toContain(first?.type === "message" ? first.data.role : "");

    // 第二次装配：水位生效，记忆开在最前，且不再压缩
    const again = await engine.transformEntries([...(await storage.read())]);
    expect(String(again[0].type === "message" ? again[0].data.content : "")).toContain("记住：她在准备搬家");
    expect(again.filter((item) => item.type === "message" && item.id.startsWith("e-")).map((item) => item.id)).toEqual(kept);

    engine.onTurnFinish();
    await engine.settle();
    expect(compacts(await storage.read())).toHaveLength(1);
    expect(calls.count).toBe(1);
  });

  it("keeps trimming while the summary call fails, and retries on the next turn", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 300 });
    engine.init(fakeAgent(storage, mockModel("", true)));

    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    calls.count = 0;
    const first = await engine.transformEntries([...(await storage.read())]);
    expect(first.length).toBeLessThan(entries.length);
    expect(calls.count).toBe(0);

    // 压缩失败：不留水位，也不影响这一轮
    engine.onTurnFinish();
    await engine.settle();
    expect(calls.count).toBe(1);
    expect(compacts(await storage.read())).toHaveLength(0);

    // 下一轮照常裁剪，轮次结束再试一次
    const second = await engine.transformEntries([...(await storage.read())]);
    expect(second.length).toBeLessThan(entries.length);
    engine.onTurnFinish();
    await engine.settle();
    expect(calls.count).toBe(2);
    expect(compacts(await storage.read())).toHaveLength(0);
  });

  it("compresses once even when two turns end back to back", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 300 });
    engine.init(fakeAgent(storage, mockModel("记忆")));

    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    calls.count = 0;
    await engine.transformEntries([...(await storage.read())]);
    engine.onTurnFinish();
    engine.onTurnFinish();
    await engine.settle();

    expect(calls.count).toBe(1);
    expect(compacts(await storage.read())).toHaveLength(1);
  });

  it("passes everything through when no line boundary is available", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 80 });
    engine.init(fakeAgent(storage, mockModel("记忆")));

    const tools = ["a", "b", "c", "d"].map((id) =>
      entry(`t-${id}`, createToolMessage([{ type: "tool-result", toolCallId: id, toolName: "peek", output: { type: "text", value: "y".repeat(80) } }])),
    );
    storage.append(...tools);

    const out = await engine.transformEntries([...(await storage.read())]);
    expect(out).toHaveLength(tools.length);
    expect(lines(out)).toEqual(["tool", "tool", "tool", "tool"]);

    // 没有可切的点：轮次结束也不去问模型
    calls.count = 0;
    engine.onTurnFinish();
    await engine.settle();
    expect(calls.count).toBe(0);
    expect(compacts(await storage.read())).toHaveLength(0);
  });

  it("grows linearly when no budget is configured", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 0 });
    engine.init(fakeAgent(storage, mockModel("记忆")));

    const entries = ["a", "b"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    calls.count = 0;
    const out = await engine.transformEntries(entries);
    expect(out).toBe(entries);

    engine.onTurnFinish();
    await engine.settle();
    expect(calls.count).toBe(0);
  });

  it("ignores a memory whose anchor left the stream", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 10_000 });
    engine.init(fakeAgent(storage, mockModel("记忆")));

    storage.append(createEntry("ishiki.compact", { summary: "旧记忆", lastEntryId: "gone" }));
    const out = await engine.transformEntries([...(await storage.read())]);

    expect(out.filter((item) => item.type === "message")).toHaveLength(0);
  });

  it("drops an in-flight summary when the scene is unloaded", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 300 });
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resolveHeld: (() => void) | undefined;
    const held = new MockLanguageModelV4({
      doGenerate: async () => {
        calls.count += 1;
        started?.();
        await new Promise<void>((resolve) => {
          resolveHeld = resolve;
        });
        return { content: [{ type: "text", text: "记忆" }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] };
      },
    });
    engine.init(fakeAgent(storage, held));

    const entries = ["a", "b", "c", "d", "e", "f"].map((id) => entry(`e-${id}`, message(id)));
    storage.append(...entries);

    calls.count = 0;
    await engine.transformEntries([...(await storage.read())]);
    engine.onTurnFinish();
    await began;
    engine.stop();
    resolveHeld?.();
    await engine.settle();

    expect(calls.count).toBe(1);
    expect(compacts(await storage.read())).toHaveLength(0);
  });

  it("runs a real turn past the budget while the summary is still in flight", async () => {
    const storage = createMemoryStorage();
    const engine = new StandardContextEngine({ maxChars: 300 });
    const prompts: string[] = [];
    let resolveHeld: (() => void) | undefined;
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async (request) => {
        prompts.push(JSON.stringify(request.prompt));
        return { stream: simulateReadableStream({ chunks: textStep("知道了") }) };
      },
      // 摘要那一路故意挂着：它什么时候回来，不关这一轮的事
      doGenerate: async () => {
        began?.();
        await new Promise<void>((resolve) => {
          resolveHeld = resolve;
        });
        return { content: [{ type: "text", text: "记住：她在准备搬家" }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] };
      },
    });
    const agent = createAgent({ id: "fold", model, storage, plugins: [engine] });
    storage.append(...["a", "b", "c", "d", "e", "f"].map((id) => entry(`e-${id}`, message(id))));
    await agent.init();

    agent.send(message("g"), { trigger: true });
    await agent.wait();

    // 一轮走完：模型看到的是裁过的窗口，老行不在了
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("m-a");
    expect(prompts[0]).toContain("m-g");
    // 摘要还没回来，轮次也没有等它
    expect(compacts(await storage.read())).toHaveLength(0);

    await started;
    resolveHeld?.();
    await engine.settle();
    expect(compacts(await storage.read())).toHaveLength(1);
  });
});
