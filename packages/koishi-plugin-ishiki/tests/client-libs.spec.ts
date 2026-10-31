import { describe, expect, it } from "vitest";

import { classifyReference } from "../client/src/lib/entities";
import { buildModelDecl, draftsFromDecl, fieldsForType, validateModelDraft } from "../client/src/lib/modelFields";
import { blankProfileDraft, buildProfileConfig, validateProfileDraft } from "../client/src/lib/profileDraft";
import { inspectModelEntry, inspectProfileConfig, parseRaw, serializeRaw } from "../client/src/lib/rawConfig";
import { bucketUsage } from "../client/src/lib/usageSeries";
import type { GroupView, ProviderView, UsageRecord } from "../src/management/types";

const providers: ProviderView[] = [
  {
    id: "openai",
    api: "openai-completions",
    apiKey: { configured: true },
    headers: {},
    settings: {},
    models: [
      { id: "gpt-4o", type: "language", reference: "openai:gpt-4o", provider: "openai", toolCall: true },
      { id: "text-embedding-3", type: "embedding", reference: "openai:text-embedding-3", provider: "openai" },
    ],
  },
];

const groups: GroupView[] = [{ name: "chat", strategy: "failover", models: ["openai:gpt-4o"] }];

const jan1 = new Date(2026, 0, 1).getTime();
const jan3 = new Date(2026, 0, 3).getTime();

describe("usage entity classification", () => {
  it("treats a declared group name as a group, never as a model", () => {
    const entity = classifyReference("chat", providers, groups);
    expect(entity).toEqual({ kind: "group", reference: "chat", name: "chat" });
  });

  it("treats a declared provider:model as a concrete model", () => {
    const entity = classifyReference("openai:gpt-4o", providers, groups);
    expect(entity).toMatchObject({ kind: "model", provider: "openai", modelId: "gpt-4o" });
  });

  it("keeps references without mapping as-is with unmapped status", () => {
    expect(classifyReference("relay:deepseek-v3", providers, groups)).toEqual({ kind: "unmapped", reference: "relay:deepseek-v3" });
    expect(classifyReference("legacy-group", providers, groups)).toEqual({ kind: "unmapped", reference: "legacy-group" });
    expect(classifyReference("openai:removed-model", providers, groups)).toEqual({ kind: "unmapped", reference: "openai:removed-model" });
  });

  it("groups usage series only by concrete records, summing each metric per day", () => {
    const records: UsageRecord[] = [
      { id: "a", timestamp: jan1 + 1000, reference: "openai:gpt-4o", input: 10, output: 5, total: 15, cacheRead: 6, cacheWrite: 1 } as UsageRecord,
      { id: "b", timestamp: jan1 + 2000, reference: "chat", input: 20, output: 0, total: 20, cacheRead: 9, cacheWrite: 2 } as UsageRecord,
      { id: "c", timestamp: jan3 + 1000, reference: "openai:gpt-4o", input: 7, output: 3, total: 10, cacheRead: 7, cacheWrite: 0 } as UsageRecord,
    ];
    const chart = bucketUsage(records, ["calls", "input", "cacheRate"]);
    expect(chart.bucket).toBe("day");
    const input = chart.series.find((entry) => entry.key === "input");
    expect(input?.points).toEqual([
      { t: jan1, v: 30 },
      { t: jan3, v: 7 },
    ]);
    const calls = chart.series.find((entry) => entry.key === "calls");
    expect(calls?.points).toHaveLength(2);
    expect(calls?.points[0]).toEqual({ t: jan1, v: 2 });
    const rate = chart.series.find((entry) => entry.key === "cacheRate");
    expect(rate?.points).toEqual([
      { t: jan1, v: 50 },
      { t: jan3, v: 100 },
    ]);
  });

  it("uses hourly buckets inside a short span", () => {
    const start = new Date(2026, 0, 1, 10).getTime();
    const records: UsageRecord[] = [
      { id: "a", timestamp: start + 60_000, reference: "openai:gpt-4o", input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0 } as UsageRecord,
      { id: "b", timestamp: start + 90 * 60_000, reference: "openai:gpt-4o", input: 20, output: 5, total: 25, cacheRead: 0, cacheWrite: 0 } as UsageRecord,
    ];
    const chart = bucketUsage(records, ["calls"]);
    expect(chart.bucket).toBe("hour");
    expect(chart.series[0]?.points).toEqual([
      { t: start, v: 1 },
      { t: start + 3_600_000, v: 1 },
    ]);
  });
});

describe("model field registry", () => {
  it("shows thinking only for language models and dimensions only for embeddings", () => {
    const language = fieldsForType("language").map((field) => field.key);
    const embedding = fieldsForType("embedding").map((field) => field.key);
    expect(language).toContain("thinking");
    expect(embedding).not.toContain("thinking");
    expect(embedding).toContain("dimensions");
    expect(language).not.toContain("dimensions");
  });

  it("drops fields that do not apply after switching model type", () => {
    const drafts = draftsFromDecl({ id: "gpt-4o", type: "language", toolCall: true, dimensions: 1024 } as never);
    const decl = buildModelDecl({ ...drafts.language });
    expect(decl).toEqual({ id: "gpt-4o", type: "language", toolCall: true });
    expect("dimensions" in decl).toBe(false);
  });

  it("restores per-type values when switching back", () => {
    const drafts = draftsFromDecl({ id: "e", type: "embedding", dimensions: 768 } as never);
    expect(drafts.embedding.dimensions).toBe(768);
  });

  it("validates thinking cross-field requirements", () => {
    const errors = validateModelDraft({ id: "m", type: "language", thinking: { mode: "", efforts: ["high"] } }, { modelTaken: () => false });
    expect(errors.thinking).toContain("思考模式参数名");
    const other = validateModelDraft({ id: "m", type: "language", thinking: { mode: "reasoning_effort", efforts: [] } }, { modelTaken: () => false });
    expect(other.thinking).toContain("至少选择一个档位");
  });

  it("flags duplicated and malformed ids", () => {
    const errors = validateModelDraft({ id: "exists", type: "language" }, { modelTaken: () => true });
    expect(errors.id).toContain("已存在");
    const colon = validateModelDraft({ id: "a:b", type: "language" }, { modelTaken: () => false });
    expect(colon.id).toContain("冒号");
  });
});

describe("raw config round trip", () => {
  it("serializes and parses a profile config losslessly", () => {
    const value = { model: "chat", mode: "channel", channels: { "qq:1": ["*"] }, context: { engine: "standard" } };
    const parsed = parseRaw(serializeRaw(value));
    expect(parsed).toEqual({ ok: true, value });
  });

  it("reports the line of a YAML syntax error", () => {
    // yaml 把未闭合引号定位到检测处（第 4 行的文件末尾）。
    const parsed = parseRaw('model: chat\nmode: channel\npersona: "unterminated\n');
    if (parsed.ok) {
      throw new Error("未闭合引号应当解析失败");
    }
    expect(parsed.issues[0].line).toBe(4);
    expect(parsed.issues[0].message.length).toBeGreaterThan(0);
  });

  it("inspects profile configs for missing model, bad channels and unknown keys", () => {
    const issues = inspectProfileConfig({ mode: "cross", channels: { qq: "not-array" }, mystery: 1 }, ["model", "mode", "channels"]);
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("model");
    expect(paths).toContain("channels.qq");
    expect(paths).toContain("mystery");
  });

  it("inspects model raw entries with the shared field registry", () => {
    const result = inspectModelEntry({ provider: { api: "" }, model: { id: "m", type: "language", dimensions: 4 } }, { modelTaken: () => false });
    expect(result.entry).toBeUndefined();
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("provider.api");
    expect(paths).toContain("model.dimensions");
  });
});

describe("profile draft", () => {
  it("builds a config compatible with the existing profile form", () => {
    const draft = blankProfileDraft();
    draft.id = "demo";
    draft.model = "chat";
    draft.channels = [{ account: "qq:123", patterns: "* !private:*" }];
    const config = buildProfileConfig(draft);
    expect(config).toEqual({
      model: "chat",
      mode: "channel",
      channels: { "qq:123": ["*", "!private:*"] },
      context: { engine: "standard" },
      wakeup: { engine: "standard" },
      toolcall: { engine: "native" },
    });
  });

  it("validates id, model reference and channel accounts", () => {
    const draft = blankProfileDraft();
    draft.id = "bad id!";
    draft.model = "missing-model";
    draft.channels = [{ account: "no-colon", patterns: "*" }];
    const errors = validateProfileDraft(draft, { idTaken: () => false, modelDeclared: () => false });
    expect(errors.id).toContain("标识");
    expect(errors.model).toContain("不在模型目录");
    expect(errors.channels).toContain("platform:selfId");
  });
});
