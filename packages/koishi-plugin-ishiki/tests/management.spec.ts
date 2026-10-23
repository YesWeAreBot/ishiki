import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { App } from "koishi";
import { afterEach, describe, expect, it } from "vitest";

import Ishiki from "../src/index.js";

const MODELS = [
  "providers:",
  "  mock:",
  "    api: openai-completions",
  "    baseUrl: https://fixture.invalid/v1",
  "    apiKey: test-only-secret",
  "    models:",
  "      - id: vision",
  "        type: language",
  "        input: [text]",
  "",
].join("\n");

const PROFILE = ["model: mock:vision", "mode: cross", "channels: {}", ""].join("\n");

function usageRecord(id: string) {
  return {
    id,
    timestamp: 10,
    profileId: "demo",
    runtimeId: "demo/onebot:1/2",
    sessionId: "demo/onebot:1/2",
    provider: "mock",
    modelId: "vision",
    reference: "mock:vision",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 2,
    source: "message" as const,
    cacheReported: false,
  };
}

function assistantEntry(id: string, timestamp: number, modelId: string, input: number, output: number) {
  return {
    id,
    type: "message",
    timestamp,
    data: {
      role: "assistant",
      content: [],
      provider: "failover",
      modelId,
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
      },
    },
  };
}

describe("Ishiki management interfaces", () => {
  let app: App | undefined;
  let dataPath: string | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    if (dataPath !== undefined) await rm(dataPath, { recursive: true, force: true });
    dataPath = undefined;
  });

  async function start(): Promise<App> {
    dataPath = await mkdtemp(path.join(tmpdir(), "ishiki-management-"));
    await mkdir(path.join(dataPath, "profiles"), { recursive: true });
    await writeFile(path.join(dataPath, "models.yaml"), MODELS);
    app = new App();
    app.plugin(Ishiki, { dataPath, dumpRequests: false, debugStream: false, logLevel: 0 });
    await app.start();
    return app;
  }

  it("keeps secrets out of reads and rejects stale model revisions", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;

    const first = await management.models.read();
    expect(first.providers[0].apiKey).toEqual({ configured: true });
    expect(JSON.stringify(first)).not.toContain("test-only-secret");

    const saved = await management.models.save(
      {
        providers: {
          mock: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "", models: [{ id: "vision" }] },
        },
        groups: {},
      },
      first.revision,
      "tester",
    );
    expect(saved.revision).not.toBe(first.revision);
    expect(JSON.stringify(saved)).not.toContain("test-only-secret");
    expect(await readFile(path.join(dataPath!, "models.yaml"), "utf8")).toContain("test-only-secret");

    await expect(
      management.models.save(
        {
          providers: { mock: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "other-secret" } },
          groups: {},
        },
        first.revision,
        "tester",
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    const audit = await management.audit.query({ kind: "models.save" });
    expect(audit.records.map((record) => record.result)).toEqual(["failed", "ok"]);
    expect(JSON.stringify(audit)).not.toContain("test-only-secret");
    expect(JSON.stringify(audit)).not.toContain("other-secret");
  });

  it("pages session logs by byte cursor and reports corrupt lines", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;
    const home = path.join(dataPath!, "profiles", "demo", "runtimes", "main");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "runtime.json"), JSON.stringify({ id: "demo/main", profileId: "demo", domain: { mode: "cross" }, createdAt: 1 }));
    const entries = [
      { id: "a", type: "message", timestamp: 10, data: { role: "user", content: [] } },
      { id: "b", type: "event", timestamp: 20, data: { type: "turn.start", turnId: "t1" } },
      {
        id: "c",
        type: "message",
        timestamp: 30,
        turnId: "t1",
        data: {
          role: "assistant",
          content: [],
          provider: "mock",
          modelId: "vision",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 3, reasoningTokens: 2 },
          },
        },
      },
      { id: "d", type: "event", timestamp: 40, turnId: "t1", data: { type: "turn.done", turnId: "t1", totalUsage: 99 } },
    ];
    const text = [JSON.stringify(entries[0]), "{broken", JSON.stringify(entries[1]), JSON.stringify(entries[2]), JSON.stringify(entries[3])].join("\n") + "\n";
    await writeFile(path.join(home, "events.jsonl"), text);

    const sessions = await management.sessions.list();
    expect(sessions).toHaveLength(1);

    const first = await management.sessions.read("demo/main", undefined, 2);
    expect(first.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(first.corrupt).toEqual([{ line: 2, error: expect.any(String) }]);
    expect(first.nextCursor).toBeDefined();

    const second = await management.sessions.read("demo/main", first.nextCursor, 10);
    expect(second.entries.map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(second.corrupt).toEqual([]);
    expect(second.nextCursor).toBeUndefined();

    const filtered = await management.sessions.read("demo/main", undefined, 1, { role: "assistant" });
    expect(filtered.entries.map((entry) => entry.id)).toEqual(["c"]);
    expect(filtered.nextCursor).toBeDefined();

    await Promise.all([management.usage.sync(), management.usage.sync(), management.usage.sync()]);
    const usage = await management.usage.snapshot();
    expect(usage.totals.calls).toBe(1);
    expect(usage.totals.input).toBe(10);
    expect(usage.totals.cacheRead).toBe(2);
    expect(usage.totals.output).toBe(5);
  });

  it("uses the recorded runtime id once and accepts a null cursor", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;
    const home = path.join(dataPath!, "profiles", "demo", "runtimes", "onebot_1_2");
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(home, "runtime.json"),
      JSON.stringify({
        id: "demo/onebot:1/2",
        profileId: "demo",
        domain: { mode: "channel", platform: "onebot", selfId: "1", channelId: "2" },
        createdAt: 1,
      }),
    );
    await writeFile(path.join(home, "events.jsonl"), `${JSON.stringify({ id: "a", type: "message", timestamp: 10, data: { role: "user", content: [] } })}\n`);

    const sessions = await management.sessions.list();
    expect(sessions.map((session) => session.id)).toEqual(["demo/onebot:1/2"]);

    const read = await management.sessions.read("demo/onebot:1/2", null, 10);
    expect(read.entries.map((entry) => entry.id)).toEqual(["a"]);

    await writeFile(
      path.join(dataPath!, "usage.jsonl"),
      [usageRecord("demo/onebot_1_2:entry-1"), usageRecord("demo/onebot:1/2:entry-1")].map((row) => JSON.stringify(row)).join("\n"),
    );
    expect((await management.usage.snapshot()).totals).toMatchObject({ calls: 1, input: 1, output: 1 });
  });

  it("aggregates usage by the assistant model and ignores think levels", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;
    const home = path.join(dataPath!, "profiles", "demo", "runtimes", "main");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "runtime.json"), JSON.stringify({ id: "demo/main", profileId: "demo", domain: { mode: "cross" }, createdAt: 1 }));
    await writeFile(
      path.join(home, "events.jsonl"),
      [assistantEntry("a", 10, "mock:vision:high", 3, 2), assistantEntry("b", 20, "mock:other", 4, 1)].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );

    await management.usage.sync();
    const snapshot = await management.usage.snapshot();
    const vision = snapshot.byModel.find((row) => row.reference === "mock:vision");
    const other = snapshot.byModel.find((row) => row.reference === "mock:other");
    expect(vision).toMatchObject({ calls: 1, input: 3, output: 2 });
    expect(other).toMatchObject({ calls: 1, input: 4, output: 1 });
    expect((await management.usage.snapshot({ model: "mock:vision" })).totals).toMatchObject({ calls: 1, input: 3, output: 2 });
    expect((await management.usage.snapshot({ model: "mock:vision:high" })).totals).toMatchObject({ calls: 1, input: 3, output: 2 });
  });

  it("saves profile files with revisions and preserves audit history after deletion", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;
    const root = path.join(dataPath!, "profiles", "demo");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "profile.yml"), PROFILE);

    const before = await management.profiles.read("demo");
    expect(before.revision).toBeTypeOf("string");

    const saved = await management.profiles.save(
      "demo",
      { config: { model: "mock:vision", mode: "cross", channels: {}, instructions: ["PERSONA.md"] }, persona: "冷静的人格" },
      before.revision,
      "tester",
    );
    expect(saved.persona).toBe("冷静的人格");
    expect(saved.savedAt).toBeGreaterThanOrEqual(before.savedAt);

    await expect(management.profiles.save("demo", { config: { model: "mock:vision" } }, before.revision, "tester")).rejects.toMatchObject({ code: "conflict" });

    await management.profiles.remove("demo", "tester");
    await expect(management.profiles.read("demo")).rejects.toMatchObject({ code: "not-found" });
    const audit = await management.audit.query({ profileId: "demo" });
    expect(audit.records.map((record) => record.kind)).toContain("profile.remove");
    expect(audit.records.some((record) => record.kind === "profile.save" && record.result === "ok")).toBe(true);
  });

  it("reports cache statistics from real resource stores", async () => {
    const instance = await start();
    const management = instance.get("ishiki")!.management;
    const snapshot = await management.cache.read();
    expect(snapshot.status).toBe("empty");
    expect(snapshot.reason).toContain("尚未采集");
    expect(snapshot.resources).toEqual([]);
  });
});
