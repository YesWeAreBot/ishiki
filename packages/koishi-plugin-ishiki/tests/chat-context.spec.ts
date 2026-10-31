import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAssistantMessage, createEntry, createToolMessage, createUserMessage, type Agent, type AgentEntry } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import {
  boundaryIndex,
  buildCompactPrompt,
  buildShakeBundle,
  ChatContextInstance,
  makeToolCallMap,
  planChat,
  planCompact,
  planShake,
  projectChat,
  renderCompactOriginal,
  selectHotStart,
  type ChatBudget,
  type IshikiChatCompact,
  type IshikiChatShake,
} from "../src/context/chat.engine.js";
import { ResourceCenter } from "../src/resource/center.js";

const budget: ChatBudget = {
  maxTokens: 1000,
  highWater: 700,
  target: 500,
  hot: 100,
  hotMinMessages: 2,
  shakeMinTool: 50,
  shakeBatch: 3000,
  minRegion: 0,
  compactTarget: 60,
  compactMinCovered: 200,
};

const rate = 0.5;
const VALID_SUMMARY = "## 人物与关系\n测试\n## 偏好与边界\n无\n## 约定与承诺\n无\n## 未完成话题\n无\n## 已确认事实\n无\n## 工作状态\n无\n## 当前氛围\n平静";

function user(id: string, text: string): AgentEntry<"message"> {
  return createEntry("message", createUserMessage(text), { id, timestamp: 1 });
}

function call(id: string, toolCallId: string, intent: string, text: string): AgentEntry<"message"> {
  return createEntry("message", createAssistantMessage([{ type: "tool-call", toolCallId, toolName: "read", input: { i: intent, url: `local://${text}` } }]), {
    id,
    timestamp: 2,
  });
}

function result(id: string, toolCallId: string, text: string): AgentEntry<"message"> {
  return createEntry("message", createToolMessage([{ type: "tool-result", toolCallId, toolName: "read", output: { type: "text", value: text } }]), {
    id,
    timestamp: 3,
  });
}

function taskStep(prefix: string, payload: string): AgentEntry[] {
  return [call(`${prefix}a`, `${prefix}c`, `读取 ${prefix}`, `${prefix}.txt`), result(`${prefix}t`, `${prefix}c`, payload)];
}

function step(prefix: string, payload: string): AgentEntry[] {
  return [user(`${prefix}u`, `${prefix} 开始`), ...taskStep(prefix, payload)];
}

async function maintenanceHarness(
  entries: AgentEntry[],
  options: { compactModel?: string; gateway?: Record<string, unknown>; onGenerate?: (options: Record<string, unknown>) => void } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-chat-maintenance-"));
  let calls = 0;
  const model = {
    specificationVersion: "v2",
    provider: "provider",
    modelId: "base",
    supportedUrls: {},
    doGenerate: async (input: unknown) => {
      calls += 1;
      options.onGenerate?.(input as Record<string, unknown>);
      return {
        content: [{ type: "text", text: VALID_SUMMARY }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  };
  const agent = {
    channel: { subscribe: () => () => {} },
    storage: {
      read: async () => entries,
      append: async (...batch: readonly AgentEntry[]) => {
        entries.push(...batch);
      },
    },
    isIdle: () => true,
    getModel: () => model,
  } as unknown as Agent;
  const resources = new ResourceCenter("chat-maintenance", home);
  const instance = new ChatContextInstance(
    {
      maxTokens: 10_000,
      hotRatio: 0.001,
      hotMinMessages: 1,
      shakeMinToolRatio: 0.0001,
      shakeBatchRatio: 1,
      compactMinCoveredRatio: 0.01,
      minRegionTokens: 0,
      compactModel: options.compactModel,
    },
    {
      runtimeId: "chat-maintenance",
      domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
      home,
      root: home,
      fiber: {} as never,
      logger: { level: 1, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
      resources,
      gateway: options.gateway,
    } as never,
  );
  instance.attach(agent);
  return {
    entries,
    instance,
    calls: () => calls,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

describe("chat planner", () => {
  it("keeps the latest assistant step inside the hot zone and pins the latest user before it", () => {
    const entries = [user("root", "开始"), ...taskStep("one", "x".repeat(4000)), ...taskStep("two", "y".repeat(4000))];
    const start = selectHotStart(entries, budget, rate);
    expect(entries[start]?.id).toBe("twoa");
    expect(entries.slice(start).some((entry) => entry.id === "twot")).toBe(true);
    expect(entries.slice(start).some((entry) => entry.id === "onet")).toBe(false);
    expect(entries.slice(0, start).some((entry) => entry.id === "root")).toBe(true);
  });

  it("plans a shake only when the tool payload is worth folding", () => {
    const entries = [user("root", "开始"), ...taskStep("one", "x".repeat(4000)), ...taskStep("two", "y".repeat(4000))];
    const start = selectHotStart(entries, budget, rate);
    const shake = planShake(entries, start, budget, rate, undefined, 0, 1);
    expect(shake).toBeDefined();
    expect(shake?.range).toEqual({ start: "onea", end: "onet" });
    expect(shake?.toolTokens).toBeGreaterThan(budget.shakeMinTool);

    const small = planShake(entries, start, { ...budget, shakeMinTool: 5000 }, rate, undefined, 0, 1);
    expect(small).toBeUndefined();
  });

  it("projects the compact head and active shake digest in order", () => {
    const compact: AgentEntry<"ishiki.chat.compact"> = createEntry(
      "ishiki.chat.compact",
      { summary: "旧摘要", lastEntryId: "onet", artifact: "artifact://compact/c.log" } satisfies IshikiChatCompact,
      { id: "compact", timestamp: 4 },
    );
    const shake: AgentEntry<"ishiki.chat.shake"> = createEntry(
      "ishiki.chat.shake",
      {
        range: { start: "twou", end: "twot" },
        digest: "折叠摘要",
        artifact: "artifact://shake/s.log",
        regions: [],
        stats: { coveredMessages: 3, coveredTokens: 100, freedTokens: 80, digestTokens: 20 },
      } satisfies IshikiChatShake,
      { id: "shake", timestamp: 5 },
    );
    const entries = [...step("one", "x".repeat(100)), compact, ...step("two", "y".repeat(100)), shake, user("three", "three")];
    const projection = projectChat(entries, budget, rate);
    expect(projection.entries.map((entry) => entry.id)).toHaveLength(3);
    const text = projection.entries.map((entry) => (entry.type === "message" && typeof entry.data.content === "string" ? entry.data.content : "")).join("\n");
    expect(text).toContain("旧摘要");
    expect(text).toContain("折叠摘要");
    expect(text).toContain("three");
    expect(projection.chars).toBeGreaterThan(0);
  });

  it("composes the whole plan", () => {
    const entries = [user("root", "开始"), ...taskStep("one", "x".repeat(4000)), ...taskStep("two", "y".repeat(4000))];
    const plan = planChat(entries, budget, rate);
    expect(plan.boundary).toBe(0);
    expect(plan.hotStart).toBeGreaterThan(0);
    expect(plan.shake).toBeDefined();
    expect(plan.projection.entries.length).toBeGreaterThan(0);
  });

  it("starts planning from the previous compact anchor when later messages precede the compact entry", () => {
    const compact: AgentEntry<"ishiki.chat.compact"> = createEntry(
      "ishiki.chat.compact",
      { summary: "旧摘要", lastEntryId: "root", artifact: "artifact://compact/c.log" } satisfies IshikiChatCompact,
      { id: "compact", timestamp: 4 },
    );
    const entries = [user("root", "开始"), user("joined", "后".repeat(1000)), compact, user("later", "续".repeat(1000))];

    expect(boundaryIndex(entries)).toBe(1);
    const plan = planCompact(entries, budget, rate, 4, undefined, 3);
    expect(plan?.start).toBe(1);
    expect(plan?.end).toBe(3);
    expect(plan?.throughEntryId).toBe("later");
  });

  it("removes reasoning from compact source and exposes the summary target", () => {
    const entries = [
      createEntry(
        "message",
        createAssistantMessage([
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "visible answer" },
        ]),
        { id: "assistant" },
      ),
    ];
    const original = renderCompactOriginal(entries, 0, 0);
    expect(original).toContain("visible answer");
    expect(original).not.toContain("private reasoning");
    expect(JSON.parse(buildCompactPrompt({ shakes: [], records: [], targetTokens: 2_400 }))).toEqual({
      previousSummary: null,
      foldedBlocks: [],
      records: [],
      targetTokens: 2_400,
    });
  });
});

describe("shake rendering", () => {
  it("writes a self-describing artifact with exact result line ranges", () => {
    const entries = [user("u1", "开始"), call("a1", "c1", "读取配置", "x"), result("t1", "c1", "line one\nline two")];
    const calls = makeToolCallMap(entries);
    const bundle = buildShakeBundle(entries, {
      artifact: "artifact://shake/s.log",
      namespace: "shake",
      name: "s.log",
      minRegion: 0,
      rate,
      calls,
    });

    expect(bundle.digest).toContain("用户: 开始");
    expect(bundle.digest).toContain("- read(i: 读取配置) · 成功 · lines");
    expect(bundle.artifactText).toContain("@@@ishiki-region 1 tool=read entry=t1");
    expect(bundle.artifactText).toContain("@@@ishiki-index");
    expect(bundle.artifactText).toContain("@@@ishiki-end");

    const region = bundle.regions[0]!;
    const lines = bundle.artifactText.split("\n");
    expect(lines[region.lines.start - 1]).toBe("line one");
    expect(lines[region.lines.start]).toBe("line two");
    expect(region.intent).toBe("读取配置");
  });
});

describe("chat engine maintenance", () => {
  it("folds a tool payload and then compacts the covered prefix", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-chat-"));
    try {
      const entries: AgentEntry[] = [
        user("u1", "开始"),
        createEntry(
          "message",
          createAssistantMessage([
            { type: "reasoning", text: "private reasoning" },
            { type: "tool-call", toolCallId: "c1", toolName: "read", input: { i: "取大块", url: "local://x" } },
          ]),
          { id: "a1", timestamp: 2 },
        ),
        result("t1", "c1", "x".repeat(4000)),
        createEntry("message", createAssistantMessage([{ type: "text", text: "done" }]), { id: "a2" }),
      ];
      let compactAttempts = 0;
      let compactOptions: Record<string, unknown> | undefined;
      const model = {
        specificationVersion: "v2",
        provider: "test",
        modelId: "test",
        supportedUrls: {},
        doGenerate: async (options: unknown) => {
          compactAttempts += 1;
          compactOptions = options as Record<string, unknown>;
          return {
            content:
              compactAttempts === 1
                ? []
                : [
                    {
                      type: "text",
                      text: VALID_SUMMARY,
                    },
                  ],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        },
      };
      const agent = {
        channel: { subscribe: () => () => {} },
        storage: {
          read: async () => entries,
          append: async (...batch: readonly AgentEntry[]) => {
            entries.push(...batch);
          },
        },
        isIdle: () => true,
        getModel: () => model,
      } as unknown as Agent;
      const resources = new ResourceCenter("chat-test", home);
      const instance = new ChatContextInstance(
        {
          maxTokens: 10_000,
          hotRatio: 0.001,
          hotMinMessages: 1,
          shakeMinToolRatio: 0.0001,
          shakeBatchRatio: 1,
          compactMinCoveredRatio: 0.01,
          minRegionTokens: 0,
        },
        {
          runtimeId: "chat-test",
          domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
          home,
          root: home,
          fiber: {} as never,
          logger: { level: 1, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
          resources,
        },
      );
      instance.attach(agent);

      const shake = await instance.forceShake();
      expect(shake.appended).toBe(true);
      expect(shake.artifact).toMatch(/^artifact:\/\/shake\//);
      const shakeEntry = entries.find((entry): entry is AgentEntry<"ishiki.chat.shake"> => entry.type === "ishiki.chat.shake");
      expect(shakeEntry?.data.regions.length).toBeGreaterThan(0);
      const shakeText = await fs.readFile(path.join(home, "resources", "artifacts", "shake", path.basename(shake.artifact!)), "utf8");
      expect(shakeText).toContain("@@@ishiki-shake v1");
      expect(shakeText).toContain("@@@ishiki-region 1");

      for (let index = 0; index < 40; index += 1) entries.push(user(`u${index + 10}`, "聊".repeat(200)));

      const compact = await instance.forceCompact();
      expect(compact.appended).toBe(true);
      expect(compact.throughEntryId).toBe("t1");
      const compactEntry = entries.find((entry): entry is AgentEntry<"ishiki.chat.compact"> => entry.type === "ishiki.chat.compact");
      expect(compactEntry?.data.summary).toContain("人物与关系");
      expect(compactEntry?.data.coveredShakeIds).toContain(shakeEntry!.id);
      expect(compactEntry?.data.stats?.coveredTokens).toBeGreaterThan(0);
      expect(compactEntry?.data.stats?.summaryTokens).toBeGreaterThan(0);
      expect(compactEntry?.data.stats?.freedTokens).toBeGreaterThanOrEqual(0);
      expect(compactEntry?.data.attempts).toHaveLength(2);
      expect(compactOptions).toMatchObject({ reasoning: "none", maxOutputTokens: 3_500 });
      expect(JSON.stringify(compactOptions?.prompt)).toContain('\\"targetTokens\\":500');
      expect(JSON.stringify(compactOptions?.prompt)).not.toContain("private reasoning");
      for (const [index, attempt] of compactEntry!.data.attempts!.entries()) {
        expect(attempt).toMatchObject({
          attempt: index + 1,
          provider: "test",
          modelId: "test",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      }
      const compactText = await fs.readFile(path.join(home, "resources", "artifacts", "compact", path.basename(compactEntry!.data.artifact!)), "utf8");
      expect(compactText).not.toContain("private reasoning");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("maintains the context automatically when a long task turn exceeds the budget", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-chat-auto-"));
    try {
      const entries: AgentEntry[] = [
        user("root", "开始"),
        ...taskStep("one", "x".repeat(4000)),
        ...taskStep("two", "y".repeat(4000)),
        ...taskStep("three", "z".repeat(4000)),
        ...taskStep("four", "w".repeat(4000)),
      ];
      const model = {
        specificationVersion: "v2",
        provider: "test",
        modelId: "test",
        supportedUrls: {},
        doGenerate: async () => ({
          content: [
            {
              type: "text",
              text: VALID_SUMMARY,
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
      };
      const agent = {
        channel: { subscribe: () => () => {} },
        storage: {
          read: async () => entries,
          append: async (...batch: readonly AgentEntry[]) => {
            entries.push(...batch);
          },
        },
        isIdle: () => true,
        getModel: () => model,
      } as unknown as Agent;
      const resources = new ResourceCenter("chat-test-auto", home);
      const instance = new ChatContextInstance(
        {
          maxTokens: 10_000,
          hotRatio: 0.001,
          hotMinMessages: 1,
          shakeMinToolRatio: 0.0001,
          shakeBatchRatio: 1,
          compactMinCoveredRatio: 0.01,
          minRegionTokens: 0,
        },
        {
          runtimeId: "chat-test-auto",
          domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
          home,
          root: home,
          fiber: {} as never,
          logger: { level: 1, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
          resources,
        },
      );
      instance.attach(agent);

      const projected = await instance.prepareEntries(entries, { turnId: "turn", signal: new AbortController().signal });

      expect(entries.some((entry) => entry.type === "ishiki.chat.shake")).toBe(true);
      expect(projected.some((entry) => entry.type === "message" && JSON.stringify(entry.data).includes("上下文折叠"))).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("limits a long turn to one automatic compact below the emergency threshold", async () => {
    const entries: AgentEntry[] = [
      user("root", "开始"),
      ...taskStep("one", "x".repeat(4000)),
      ...taskStep("two", "y".repeat(4000)),
      ...taskStep("three", "z".repeat(4000)),
      ...taskStep("four", "w".repeat(4000)),
      user("current", "继续"),
    ];
    const harness = await maintenanceHarness(entries);
    try {
      const request = { turnId: "turn", signal: new AbortController().signal };
      await harness.instance.prepareEntries(entries, request);
      expect(harness.calls()).toBe(1);
      expect(harness.entries.filter((entry) => entry.type === "ishiki.chat.compact")).toHaveLength(1);

      harness.entries.push(
        user("filler", "q".repeat(13_800)),
        createEntry("message", createAssistantMessage([{ type: "text", text: "filler answer" }]), { id: "filler-a" }),
        user("next", "继续"),
      );
      const before = await harness.instance.stats();
      expect(before.over).toBe(true);
      expect(before.messageTokens).toBeGreaterThan(before.highWaterTokens);
      expect(before.messageTokens).toBeLessThan(9_500);
      const internalPlan = (harness.instance as unknown as { plan: (entries: readonly AgentEntry[]) => { compact?: unknown } }).plan(harness.entries);
      expect(internalPlan.compact).toBeDefined();

      await harness.instance.prepareEntries(harness.entries, request);
      expect(harness.calls()).toBe(1);
      expect(harness.entries.filter((entry) => entry.type === "ishiki.chat.compact")).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the agent model when no compact model is configured", async () => {
    const entries: AgentEntry[] = [
      user("root", "开始"),
      ...taskStep("one", "x".repeat(4000)),
      ...taskStep("two", "y".repeat(4000)),
      ...taskStep("three", "z".repeat(4000)),
      user("current", "继续"),
    ];
    const generated: Array<Record<string, unknown>> = [];
    const harness = await maintenanceHarness(entries, { onGenerate: (options) => generated.push(options) });
    try {
      const result = await harness.instance.forceCompact();
      expect(result.appended).toBe(true);
      expect(harness.calls()).toBe(1);
      expect(generated[0]).toMatchObject({ reasoning: "none", maxOutputTokens: 3_500 });
    } finally {
      await harness.cleanup();
    }
  });

  it("derives a reasoning-free model from the configured compact model", async () => {
    const entries: AgentEntry[] = [
      user("root", "开始"),
      ...taskStep("one", "x".repeat(4000)),
      ...taskStep("two", "y".repeat(4000)),
      ...taskStep("three", "z".repeat(4000)),
      user("current", "继续"),
    ];
    const references: string[] = [];
    let compactOptions: Record<string, unknown> | undefined;
    const compactModel = {
      specificationVersion: "v2",
      provider: "provider",
      modelId: "base",
      supportedUrls: {},
      doGenerate: async (options: unknown) => {
        compactOptions = options as Record<string, unknown>;
        return {
          content: [{ type: "text", text: VALID_SUMMARY }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    };
    const gateway = {
      groups: () => [],
      languageModel: (reference: string) => {
        references.push(reference);
        return compactModel;
      },
    };
    const harness = await maintenanceHarness(entries, { compactModel: "provider:base:high", gateway });
    try {
      const result = await harness.instance.forceCompact();
      expect(result.appended).toBe(true);
      expect(references).toEqual(["provider:base:high", "provider:base:none"]);
      expect(harness.calls()).toBe(0);
      expect(compactOptions).toMatchObject({ reasoning: "none", maxOutputTokens: 3_500 });
    } finally {
      await harness.cleanup();
    }
  });

  it("allows a second automatic compact when the projection reaches the emergency threshold", async () => {
    const entries: AgentEntry[] = [
      user("root", "开始"),
      ...taskStep("one", "x".repeat(4000)),
      ...taskStep("two", "y".repeat(4000)),
      ...taskStep("three", "z".repeat(4000)),
      ...taskStep("four", "w".repeat(4000)),
      user("current", "继续"),
    ];
    const harness = await maintenanceHarness(entries);
    try {
      const request = { turnId: "turn", signal: new AbortController().signal };
      await harness.instance.prepareEntries(entries, request);
      expect(harness.calls()).toBe(1);

      harness.entries.push(
        user("filler", "q".repeat(19_400)),
        createEntry("message", createAssistantMessage([{ type: "text", text: "filler answer" }]), { id: "filler-a" }),
        user("next", "继续"),
      );
      const before = await harness.instance.stats();
      expect(before.over).toBe(true);
      expect(before.messageTokens).toBeGreaterThanOrEqual(9_500);
      const internalPlan = (harness.instance as unknown as { plan: (entries: readonly AgentEntry[]) => { compact?: unknown } }).plan(harness.entries);
      expect(internalPlan.compact).toBeDefined();

      await harness.instance.prepareEntries(harness.entries, request);
      expect(harness.calls()).toBe(2);
      expect(harness.entries.filter((entry) => entry.type === "ishiki.chat.compact")).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});
