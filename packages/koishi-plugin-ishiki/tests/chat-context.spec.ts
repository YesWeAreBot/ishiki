import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAssistantMessage, createCustomMessage, createEntry, createToolMessage, createUserMessage, type Agent, type AgentEntry } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import {
  boundaryIndex,
  buildCompactPrompt,
  buildShakeBundle,
  ChatContextInstance,
  describePlanRejection,
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
import { collapse, renderLine, visibleSize } from "../src/context/render.js";
import { ResourceCenter } from "../src/resource/center.js";
import type { TaskState } from "../src/types/messages.js";

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

function inbound(id: string, text: string): AgentEntry<"message"> {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.created", {
      timestamp: 1,
      platform: "test",
      selfId: "bot",
      channelId: "channel",
      messageId: id,
      content: text,
      isDirect: true,
      user: { id: "u1", name: "Miaow" },
    }),
    { id, timestamp: 1 },
  );
}

function attachment(id: string): AgentEntry<"message"> {
  return createEntry(
    "message",
    createCustomMessage("ishiki.attachment", { source: "platform", platform: "test", selfId: "bot", channelId: "channel", messageId: id, items: [] }),
    { id, timestamp: 1 },
  );
}

function deleted(id: string): AgentEntry<"message"> {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.deleted", { timestamp: 1, platform: "test", selfId: "bot", channelId: "channel", messageId: id }),
    { id, timestamp: 1 },
  );
}

function notice(id: string, state: TaskState, summary: string, startedAt: number, finishedAt: number): AgentEntry<"message"> {
  return createEntry("message", createCustomMessage("ishiki.task", { taskId: id, toolName: "read", state, startedAt, finishedAt, summary }), {
    id: `notice-${id}`,
    timestamp: finishedAt,
  });
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
    expect(shake.plan?.range).toEqual({ start: "onea", end: "onet" });
    expect(shake.plan?.toolTokens).toBeGreaterThan(budget.shakeMinTool);

    const small = planShake(entries, start, { ...budget, shakeMinTool: 5000 }, rate, undefined, 0, 1);
    expect(small.plan).toBeUndefined();
    expect(small.rejection).toMatchObject({ reason: "shakeMinTool", threshold: 5000 });
  });

  it("counts fold release as the projection difference when the digest outgrows the remaining tool bodies", () => {
    // 线上形态：一段很长的 send_message 失败输出不进入摘要，摘要因此比"仍可折叠的工具正文"更长。
    const calls = createEntry(
      "message",
      createAssistantMessage([
        { type: "tool-call", toolCallId: "s1", toolName: "send_message", input: { messages: ["早上好"] } },
        { type: "tool-call", toolCallId: "r1", toolName: "read", input: { i: "读取偏好", url: "local://p.txt" } },
      ]),
      { id: "calls", timestamp: 2 },
    );
    const outputs = createEntry(
      "message",
      createToolMessage([
        { type: "tool-result", toolCallId: "s1", toolName: "send_message", output: { type: "error", value: "发送失败：连接中断。".repeat(300) } },
        { type: "tool-result", toolCallId: "r1", toolName: "read", output: { type: "text", value: "ok" } },
      ]),
      { id: "outputs", timestamp: 3 },
    );
    const entries = [user("root", "开始"), calls, outputs];

    const decision = planShake(entries, entries.length, budget, rate, undefined, 0, 0);
    const plan = decision.plan!;
    expect(plan.digestChars).toBeGreaterThan("ok".length);
    expect(plan.freedTokens).toBeGreaterThan(0);

    const folded: AgentEntry<"ishiki.chat.shake"> = createEntry(
      "ishiki.chat.shake",
      {
        range: plan.range,
        digest: "摘".repeat(plan.digestChars),
        artifact: plan.artifact,
        regions: [],
        stats: {
          coveredMessages: plan.coveredMessages,
          coveredTokens: plan.coveredTokens,
          freedTokens: plan.freedTokens,
          digestTokens: Math.round(plan.digestChars * rate),
        },
      } satisfies IshikiChatShake,
      { id: "folded", timestamp: 4 },
    );

    const before = projectChat(entries, budget, rate).chars;
    const after = projectChat([...entries, folded], budget, rate).chars;
    expect(Math.round((before - after) * rate)).toBe(plan.freedTokens);
  });

  it("explains a rejection with its threshold instead of an empty plan", () => {
    expect(planShake([user("root", "开始")], 0, budget, rate, undefined, 0).rejection).toEqual({ reason: "noRange" });
    expect(planShake([user("root", "开始"), user("two", "再说")], 2, budget, rate, undefined, 0).rejection).toEqual({ reason: "covered" });

    const thin = planShake([user("root", "开始"), ...taskStep("one", "x".repeat(20))], 3, { ...budget, shakeMinTool: 5000 }, rate, undefined, 0);
    const thinRejection = thin.rejection as { actual: number; threshold: number };
    expect(thin.rejection).toMatchObject({ reason: "shakeMinTool", threshold: 5000 });
    expect(thinRejection.actual).toBeGreaterThan(0);
    expect(thinRejection.actual).toBeLessThan(5000);
    expect(describePlanRejection("shake", thin.rejection!)).toBe(
      `当前没有可折叠的工具内容：候选工具正文约 ${Math.round(thinRejection.actual)} tokens，低于阈值 5000 tokens`,
    );

    const small = planCompact([user("root", "开始")], { ...budget, compactMinCovered: 5000 }, rate, 1, undefined, 0);
    const smallRejection = small.rejection as { actual: number; threshold: number };
    expect(small.rejection).toMatchObject({ reason: "compactMinCovered", threshold: 5000 });
    expect(smallRejection.actual).toBe(1);
    expect(describePlanRejection("compact", small.rejection!)).toBe(`当前没有可压缩的内容：候选内容约 1 tokens，低于阈值 5000 tokens`);

    expect(describePlanRejection("shake", { reason: "noRange" })).toBe("当前没有可折叠的工具内容：热区之外没有候选条目");
    expect(describePlanRejection("compact", { reason: "covered" })).toBe("当前没有可压缩的内容：候选区已无未覆盖内容");
  });

  it("records the release that the projection actually loses", async () => {
    const harness = await maintenanceHarness([
      user("u1", "开始"),
      createEntry("message", createAssistantMessage([{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { i: "取大块", url: "local://x" } }]), {
        id: "a1",
        timestamp: 2,
      }),
      result("t1", "c1", "x".repeat(4000)),
      createEntry("message", createAssistantMessage([{ type: "text", text: "done" }]), { id: "a2" }),
    ]);
    try {
      const before = (await harness.instance.stats()).assembledChars;
      expect(await harness.instance.forceShake()).toMatchObject({ appended: true });
      const after = (await harness.instance.stats()).assembledChars;
      const shake = harness.entries.find((entry): entry is AgentEntry<"ishiki.chat.shake"> => entry.type === "ishiki.chat.shake");
      expect(after).toBeLessThan(before);
      expect(shake?.data.stats?.freedTokens).toBe(Math.round((before - after) * 0.5));
      expect((await harness.instance.stats()).lastShake?.freedTokens).toBe(shake?.data.stats?.freedTokens);
    } finally {
      await harness.cleanup();
    }
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

  it("compacts the whole cold zone when the last entry is an inbound message", () => {
    const entries = [
      ...taskStep("one", "x".repeat(2000)),
      user("prompt", "回复Miaow"),
      ...taskStep("two", "y".repeat(2000)),
      ...taskStep("three", "z".repeat(2000)),
      inbound("incoming", "在吗"),
    ];
    const plan = planChat(entries, { ...budget, compactMinCovered: 1500 }, rate);
    expect(plan.compact).toBeDefined();
    expect(plan.compact?.start).toBe(0);
    expect(plan.compact?.end).toBe(plan.hotStart - 1);
    expect(plan.compact?.throughEntryId).toBe(entries[plan.hotStart - 1].id);

    const attached = [
      ...taskStep("one", "x".repeat(2000)),
      user("prompt", "回复Miaow"),
      ...taskStep("two", "y".repeat(2000)),
      ...taskStep("three", "z".repeat(2000)),
      attachment("picture"),
    ];
    const attachedPlan = planChat(attached, { ...budget, compactMinCovered: 1500 }, rate);
    expect(attachedPlan.compact?.end).toBe(attachedPlan.hotStart - 1);
    expect(attachedPlan.compact?.throughEntryId).toBe(attached[attachedPlan.hotStart - 1].id);
  });

  it("keeps an injected user prompt at the end of the history out of the compact region", () => {
    const entries = [
      ...taskStep("one", "x".repeat(2000)),
      user("prompt", "Continue."),
      ...taskStep("two", "y".repeat(2000)),
      ...taskStep("three", "z".repeat(2000)),
    ];
    const plan = planChat(entries, budget, rate);
    expect(plan.compact?.start).toBe(0);
    expect(plan.compact?.end).toBe(1);
    expect(plan.compact?.throughEntryId).toBe("onet");
    expect(plan.compact?.end).toBeLessThan(2);
  });

  it("falls back to the hot boundary when the history holds no inbound message", () => {
    const entries = [...taskStep("one", "x".repeat(2000)), ...taskStep("two", "y".repeat(2000)), deleted("gone")];
    const plan = planChat(entries, budget, rate);
    expect(plan.compact).toBeDefined();
    expect(plan.compact?.end).toBe(plan.hotStart - 1);
    expect(plan.compact?.throughEntryId).toBe(entries[plan.hotStart - 1].id);
  });

  it("prefers the last inbound message over a later injected prompt", () => {
    const entries = [
      ...taskStep("one", "x".repeat(2000)),
      inbound("incoming", "开始任务"),
      ...taskStep("two", "y".repeat(2000)),
      ...taskStep("three", "z".repeat(2000)),
      user("prompt", "Continue."),
    ];
    const plan = planChat(entries, budget, rate);
    expect(plan.compact?.end).toBe(1);
    expect(plan.compact?.throughEntryId).toBe("onet");
    expect(plan.compact?.end).toBeLessThan(2);
  });

  it("starts planning from the previous compact anchor when later messages precede the compact entry", () => {
    const compact: AgentEntry<"ishiki.chat.compact"> = createEntry(
      "ishiki.chat.compact",
      { summary: "旧摘要", lastEntryId: "root", artifact: "artifact://compact/c.log" } satisfies IshikiChatCompact,
      { id: "compact", timestamp: 4 },
    );
    const entries = [user("root", "开始"), user("joined", "后".repeat(1000)), compact, user("later", "续".repeat(1000))];

    expect(boundaryIndex(entries)).toBe(1);
    const plan = planCompact(entries, budget, rate, 4, undefined, 3).plan;
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

describe("task notices", () => {
  it("renders a compact success line with tool, id, duration, and summary", () => {
    const entry = notice("t1", "succeeded", "输出 3 行", 1_000, 2_500);
    expect(renderLine(entry.data as never)).toMatch(/^\[\d\d-\d\d \d\d:\d\d\] 后台任务 read #t1 成功（1\.5s）：输出 3 行$/);
  });

  it("renders failures with their error summary and cancellations without one", () => {
    expect(renderLine(notice("t2", "failed", "连接超时", 0, 0).data)).toMatch(/后台任务 read #t2 失败（0ms）：连接超时$/);
    expect(renderLine(notice("t3", "cancelled", "", 0, 400).data)).toMatch(/后台任务 read #t3 已取消（400ms）$/);
    expect(renderLine(notice("t4", "interrupted", "运行时关闭", 0, 1_200).data)).toMatch(/后台任务 read #t4 已中断（1\.2s）：运行时关闭$/);
  });

  it("keeps notices addressable through folding", () => {
    const entries = [inbound("m1", "你好"), notice("t5", "succeeded", "", 0, 10)];
    const folded = collapse(entries.map((entry) => entry.data));
    expect(folded).toHaveLength(1);
    expect(folded[0]?.role).toBe("user");
    expect(folded[0]?.role === "user" ? folded[0].content : "").toMatch(/你好\n\[\d\d-\d\d \d\d:\d\d\] 后台任务 read #t5 成功（10ms）$/);
  });
});

describe("chat engine token calibration", () => {
  const renderOverhead = JSON.stringify([{ type: "text", text: "" }]).length;

  type ChannelEvent = { type: string; usage?: { inputTokens?: number } };

  async function calibrationHarness() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-chat-calibration-"));
    let entries: AgentEntry[] = [];
    const listeners: Array<(event: ChannelEvent) => void> = [];
    const agent = {
      channel: {
        subscribe: (_scope: string, listener: (event: ChannelEvent) => void) => {
          listeners.push(listener);
          return () => {
            listeners.splice(listeners.indexOf(listener), 1);
          };
        },
      },
      storage: {
        read: async () => entries,
        append: async (...batch: readonly AgentEntry[]) => {
          entries.push(...batch);
        },
      },
      isIdle: () => true,
      getModel: () => {
        throw new Error("chat calibration test does not generate");
      },
    } as unknown as Agent;
    const instance = new ChatContextInstance({ maxTokens: 1_000_000 }, {
      runtimeId: "chat-calibration",
      domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "channel" },
      home,
      root: home,
      fiber: {} as never,
      logger: { level: 1, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      resources: new ResourceCenter("chat-calibration", home),
    } as never);
    instance.attach(agent);

    /** 补齐投影字符数：新增一条 assistant 文本，长度按渲染开销反推。 */
    const pad = (target: number): void => {
      const length = target - visibleSize(entries) - renderOverhead;
      if (length < 0) throw new Error(`target ${target} is below the current projection`);
      entries.push(createEntry("message", createAssistantMessage([{ type: "text", text: "x".repeat(length) }]), { id: `pad-${entries.length}`, timestamp: 1 }));
    };

    return {
      instance,
      reset: (next: AgentEntry[]) => {
        entries = next;
      },
      attachImage: (): void => {
        entries.push(attachment(`image-${entries.length}`));
      },
      sample: async (chars: number, tokens: number): Promise<void> => {
        pad(chars);
        expect(visibleSize(entries)).toBe(chars);
        await instance.prepareEntries(entries, { signal: new AbortController().signal });
        expect((await instance.stats()).assembledChars).toBe(chars);
        for (const listener of listeners) listener({ type: "turn.step", usage: { inputTokens: tokens } });
      },
      state: () => instance as unknown as { rate?: number; fixed?: number },
      cleanup: () => fs.rm(home, { recursive: true, force: true }),
    };
  }

  it("keeps the adopted calibration when a pair yields a negative intercept", async () => {
    const harness = await calibrationHarness();
    try {
      await harness.sample(1_000, 500);
      await harness.sample(2_000, 900);
      expect(harness.state().rate).toBeCloseTo(0.4, 9);
      expect(harness.state().fixed).toBeCloseTo(100, 9);
      let stats = await harness.instance.stats();
      expect(stats.rateCalibrated).toBe(true);
      expect(stats.messageTokens).toBe(800);
      expect(stats.estimatedTokens).toBe(900);

      // Δchars 500、Δtokens 500：rate 1.0 在区间内，截距 900 - 1.0 × 2000 = -1100 为负。
      await harness.sample(2_500, 1_400);
      expect(harness.state().rate).toBeCloseTo(0.4, 9);
      expect(harness.state().fixed).toBeCloseTo(100, 9);
      stats = await harness.instance.stats();
      expect(stats.messageTokens).toBe(1_000);
      expect(stats.estimatedTokens).toBe(1_100);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not let a step crossing an image attachment enter the sample pair", async () => {
    const harness = await calibrationHarness();
    try {
      await harness.sample(1_000, 450);
      await harness.sample(2_000, 900);
      expect(harness.state().rate).toBeCloseTo(0.45, 9);
      expect(harness.state().fixed).toBeCloseTo(0, 9);

      // 图片步进：Δchars 400、Δtokens 80 → rate 0.2、截距 500，单看这对样本会被采纳。
      harness.attachImage();
      await harness.sample(2_400, 980);
      expect(harness.state().rate).toBeCloseTo(0.45, 9);
      expect(harness.state().fixed).toBeCloseTo(0, 9);
      expect((await harness.instance.stats()).messageTokens).toBe(1_080);
    } finally {
      await harness.cleanup();
    }
  });

  it("lands on the production prefix after rejecting the four inflated pairs", async () => {
    const harness = await calibrationHarness();
    try {
      // 生产的四对样本（字符数与 token 取自 ISHI-3 的 usage.jsonl 复算）。
      await harness.sample(244_015, 81_539);
      await harness.sample(246_231, 84_400); // rate 1.291
      await harness.sample(248_361, 85_143); // rate 0.3488
      await harness.sample(250_685, 86_645); // rate 0.6463，中间夹着图片步进
      await harness.sample(252_018, 87_212); // rate 0.4254
      expect(harness.state().rate).toBeUndefined();
      expect((await harness.instance.stats()).rateCalibrated).toBe(false);

      // 压缩后字符回落，下一对样本的截距非负：rate 0.14395、fixed 48910。
      harness.reset([]);
      await harness.sample(220_000, 80_579);
      await harness.sample(240_000, 83_458);
      expect(harness.state().rate).toBeCloseTo(0.14395, 6);
      expect(harness.state().fixed).toBeCloseTo(48_910, 6);

      harness.reset([
        createEntry("message", createAssistantMessage([{ type: "text", text: "x".repeat(252_018 - renderOverhead) }]), { id: "prefix", timestamp: 1 }),
      ]);
      const stats = await harness.instance.stats();
      expect(stats.assembledChars).toBe(252_018);
      expect(stats.rateCalibrated).toBe(true);
      expect(stats.messageTokens).toBe(36_278);
      expect(stats.estimatedTokens).toBe(85_188);
    } finally {
      await harness.cleanup();
    }
  });
});
