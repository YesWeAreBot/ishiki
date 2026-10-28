import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveRuntime } from "../src/commands/targets.js";
import { lastOutput, SECRET, startApp, writeProfile, type TestSetup } from "./harness.js";

/** 等待指令把确认提示发出来，再派发确认回复，最后等指令执行完成。 */
async function executeWithReply(setup: TestSetup, userId: string, command: string, reply: string, channelId?: string): Promise<string> {
  const outputsBefore = setup.outputs().length;
  const execution = setup.session(userId, channelId).execute(command);
  await vi.waitFor(() => {
    expect(setup.outputs().length).toBeGreaterThan(outputsBefore);
  });
  await setup.reply(userId, reply, channelId);
  await execution;
  return lastOutput(setup);
}

async function applyProfile(setup: TestSetup, id: string, operator = "alice"): Promise<void> {
  await setup.host.management.profiles.apply(id, `command:test:${operator}`);
}

describe("ishiki commands", () => {
  it("enforces authority levels on commands and the api-key option", async () => {
    const setup = await startApp({
      users: [
        { id: "bob", authority: 1 },
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
        { id: "dave", authority: 4 },
      ],
    });
    try {
      await setup.session("bob").execute("ishiki.model.list");
      expect(lastOutput(setup)).not.toContain("mock");
      await setup.session("alice").execute("ishiki.model.list");
      expect(lastOutput(setup)).toContain("mock");

      await setup.session("carol").execute("ishiki.model.provider.add mock2 openai-completions --base-url https://fixture.invalid/v1 --api-key another-secret");
      expect((await setup.host.management.models.read()).providers.map((provider) => provider.id)).not.toContain("mock2");

      await setup.session("dave").execute("ishiki.model.provider.add mock2 openai-completions --base-url https://fixture.invalid/v1 --api-key another-secret");
      expect((await setup.host.management.models.read()).providers.map((provider) => provider.id)).toContain("mock2");
    } finally {
      await setup.stop();
    }
  });

  it("rejects provider removal while referenced and completes after the reference is cleared", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "demo", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });

      await setup.session("carol").execute("ishiki.model.provider.remove mock");
      expect(lastOutput(setup)).toContain("demo");
      expect(lastOutput(setup)).toContain("被引用");
      expect((await setup.host.management.models.read()).providers.map((provider) => provider.id)).toContain("mock");

      await setup.host.management.profiles.setField("demo", "model", "", "command:test:carol");
      const output = await executeWithReply(setup, "carol", "ishiki.model.provider.remove mock", "确认");
      expect(output).toContain("已删除供应商 mock");
      expect((await setup.host.management.models.read()).providers).toHaveLength(0);
    } finally {
      await setup.stop();
    }
  });

  it("rejects overlapping claims on apply and keeps the earlier routing intact", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["*"] } });
      await writeProfile(setup.dataPath, "nightbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["room2"] } });
      await applyProfile(setup, "mainbot");

      await setup.session("carol").execute("ishiki.profile.apply nightbot");
      const output = lastOutput(setup);
      expect(output).toContain("认领冲突");
      expect(output).toContain("mainbot");
      expect(setup.host.profiles.has("nightbot")).toBe(false);
      expect(setup.host.findClaim({ platform: "test", selfId: "10001", channelId: "room2" })?.profile.id).toBe("mainbot");
    } finally {
      await setup.stop();
    }
  });

  it("moves a channel between profiles and reroutes messages to the new owner only", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["roomA"] } });
      await writeProfile(setup.dataPath, "nightbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["roomB"] } });
      await applyProfile(setup, "mainbot");
      await applyProfile(setup, "nightbot");

      await setup.message("alice", "hello", "roomA");
      await vi.waitFor(() => expect(setup.host.findRuntimeByAddress({ platform: "test", selfId: "10001", channelId: "roomA" })).toBeTruthy());
      expect(setup.host.runtimes.size).toBe(1);

      const output = await executeWithReply(setup, "carol", "ishiki.channel.move nightbot", "确认", "roomA");
      expect(output).toContain("迁移完成");
      expect(setup.host.findClaim({ platform: "test", selfId: "10001", channelId: "roomA" })?.profile.id).toBe("nightbot");
      expect(setup.host.runtimes.size).toBe(0);

      await setup.message("alice", "hello again", "roomA");
      await vi.waitFor(() => expect(setup.host.findRuntimeByAddress({ platform: "test", selfId: "10001", channelId: "roomA" })).toBeTruthy());
      const moved = setup.host.findRuntimeByAddress({ platform: "test", selfId: "10001", channelId: "roomA" });
      expect(moved?.id).toBe("nightbot/test:10001/roomA");
    } finally {
      await setup.stop();
    }
  });

  it("rebuilds a stopped runtime on the next message and detaches it after release", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["room1"] } });
      await applyProfile(setup, "mainbot");

      await setup.message("alice", "hello");
      await vi.waitFor(() => expect(setup.host.runtimes.size).toBe(1));
      const runtimeId = [...setup.host.runtimes.keys()][0];

      await executeWithReply(setup, "carol", `ishiki.runtime.stop ${runtimeId}`, "确认");
      expect(setup.host.runtimes.size).toBe(0);

      await setup.message("alice", "hello again");
      await vi.waitFor(() => {
        expect(setup.host.runtimes.has(runtimeId)).toBe(true);
      });
      expect(setup.host.runtimes.size).toBe(1);

      await executeWithReply(setup, "carol", "ishiki.channel.release", "确认");
      expect(setup.host.findClaim({ platform: "test", selfId: "10001", channelId: "room1" })).toBeUndefined();
      expect(setup.host.runtimes.size).toBe(0);

      await setup.message("alice", "anyone there");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(setup.host.runtimes.size).toBe(0);
    } finally {
      await setup.stop();
    }
  });

  it("keeps runtime behaviour on save and applies the new model only after apply", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });
      await applyProfile(setup, "mainbot");
      const runtime = setup.host.ensureRuntime("mainbot", { mode: "cross", channels: setup.host.findProfile("mainbot")!.channels });
      expect(setup.host.management.runtimes.read(runtime.id).model).toBe("mock:vision");

      await setup.session("carol").execute("ishiki.model.decl.add mock text --type language");
      await setup.session("carol").execute("ishiki.profile.set mainbot model mock:text");
      expect(lastOutput(setup)).toContain("已保存未应用");
      expect(setup.host.management.runtimes.read(runtime.id).model).toBe("mock:vision");

      await setup.session("carol").execute("ishiki.profile.apply mainbot");
      expect(setup.host.runtimes.size).toBe(0);
      const rebuilt = setup.host.ensureRuntime("mainbot", { mode: "cross", channels: setup.host.findProfile("mainbot")!.channels });
      expect(setup.host.management.runtimes.read(rebuilt.id).model).toBe("mock:text");
    } finally {
      await setup.stop();
    }
  });

  it("rejects duplicate contributed command names and wrong namespaces at registration", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }] });
    try {
      const commands = setup.host.commands;
      expect(commands.enabled).toBe(true);
      commands.register({ name: "ishiki.probe.echo", description: "探针", target: { kind: "none" }, action: () => "ok" }, "probe");
      await expect(async () =>
        commands!.register({ name: "ishiki.probe.echo", description: "重复", target: { kind: "none" }, action: () => "dup" }, "probe"),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(async () =>
        commands!.register({ name: "ishiki.other.thing", description: "越权命名", target: { kind: "none" }, action: () => "" }, "probe"),
      ).rejects.toMatchObject({ code: "invalid" });
      const execution = await setup.session("alice").execute("ishiki.probe.echo");
      expect(execution).toEqual([]);
      expect(lastOutput(setup)).toBe("ok");
    } finally {
      await setup.stop();
    }
  });

  it("keeps the registration submodule dormant while commands are disabled", async () => {
    const setup = await startApp({ commands: { enable: false, authority: 3 } });
    try {
      expect(setup.host.commands.enabled).toBe(false);
      expect(setup.app.$commander.get("ishiki")).toBeUndefined();
      expect(setup.app.$commander.get("ishiki.standard.usage")).toBeUndefined();
      await expect(async () =>
        setup.host.commands.register({ name: "ishiki.probe.echo", description: "探针", target: { kind: "none" }, action: () => "ok" }, "probe"),
      ).rejects.toMatchObject({ code: "rejected" });
    } finally {
      await setup.stop();
    }
  });

  it("leaves state untouched when the confirmation reply is not given", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "demo", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });

      const output = await executeWithReply(setup, "carol", "ishiki.profile.remove demo", "不");
      expect(output).toContain("操作已取消");
      expect(existsSync(path.join(setup.dataPath, "profiles", "demo", "profile.yml"))).toBe(true);
      const audit = await setup.host.management.audit.query({ kind: "profile.remove" });
      expect(audit.records).toHaveLength(0);
    } finally {
      await setup.stop();
    }
  });

  it("archives a stopped session's log and resources after confirmation", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });
      await applyProfile(setup, "mainbot");
      await setup.message("alice", "hello");
      await vi.waitFor(() => expect(setup.host.runtimes.size).toBe(1));
      const runtime = [...setup.host.runtimes.values()][0];
      const sessionId = runtime.id;
      const home = runtime.home;
      await vi.waitFor(() => expect(existsSync(path.join(home, "events.jsonl"))).toBe(true));
      mkdirSync(path.join(home, "resources", "assets"), { recursive: true });
      writeFileSync(path.join(home, "resources", "assets", "note.json"), "{}", "utf8");

      await setup.session("carol").execute(`ishiki.session.archive ${sessionId}`);
      expect(lastOutput(setup)).toContain("仍在运行");
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(true);

      await executeWithReply(setup, "carol", `ishiki.runtime.stop ${sessionId}`, "确认");
      expect(setup.host.runtimes.size).toBe(0);

      const cancelled = await executeWithReply(setup, "carol", `ishiki.session.archive ${sessionId}`, "不");
      expect(cancelled).toContain("操作已取消");
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(true);
      expect(existsSync(path.join(home, "resources"))).toBe(true);

      const output = await executeWithReply(setup, "carol", `ishiki.session.archive ${sessionId}`, "确认");
      expect(output).toContain(`已归档会话 ${sessionId}`);
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(false);
      expect(existsSync(path.join(home, "resources"))).toBe(false);

      const [archiveName] = readdirSync(path.join(home, "archives"));
      expect(archiveName).toMatch(/^\d{8}-\d{6}_[0-9a-f-]{36}$/);
      const archived = path.join(home, "archives", archiveName);
      expect(readdirSync(archived).sort()).toEqual(["events.jsonl", "resources"]);
      expect(existsSync(path.join(archived, "resources", "assets", "note.json"))).toBe(true);
      expect((await setup.host.management.sessions.list()).some((session) => session.id === sessionId)).toBe(false);
      expect((await setup.host.management.audit.query({ kind: "session.archive" })).records).toHaveLength(1);
    } finally {
      await setup.stop();
    }
  });

  it("archives the current channel's stopped session when the id is omitted", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });
      await applyProfile(setup, "mainbot");
      await setup.message("alice", "hello");
      await vi.waitFor(() => expect(setup.host.runtimes.size).toBe(1));
      const runtime = [...setup.host.runtimes.values()][0];
      const sessionId = runtime.id;
      const home = runtime.home;
      await vi.waitFor(() => expect(existsSync(path.join(home, "events.jsonl"))).toBe(true));

      await setup.session("carol").execute("ishiki.session.archive");
      expect(lastOutput(setup)).toContain("仍在运行");
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(true);

      await executeWithReply(setup, "carol", `ishiki.runtime.stop ${sessionId}`, "确认");
      expect(setup.host.runtimes.size).toBe(0);

      const output = await executeWithReply(setup, "carol", "ishiki.session.archive", "确认");
      expect(output).toContain(`已归档会话 ${sessionId}`);
      expect(existsSync(path.join(home, "events.jsonl"))).toBe(false);
      expect(existsSync(path.join(home, "resources"))).toBe(false);
    } finally {
      await setup.stop();
    }
  });

  it("never prints plaintext secrets in command output or audit logs", async () => {
    const setup = await startApp({
      users: [
        { id: "alice", authority: 2 },
        { id: "carol", authority: 3 },
      ],
    });
    try {
      await writeProfile(setup.dataPath, "demo", { model: "mock:vision", mode: "cross", channels: { "test:10001": ["*"] } });
      await setup.session("alice").execute("ishiki.model.show mock");
      expect(lastOutput(setup)).toContain("已配置");
      await setup.session("alice").execute("ishiki.model.list");
      await setup.session("alice").execute("ishiki.status");
      await setup.session("carol").execute("ishiki.model.provider.remove mock");
      expect(lastOutput(setup)).toContain("被引用");
      const audit = await setup.host.management.audit.query({});
      const outputs = setup.outputs().join("\n");
      expect(outputs).not.toContain(SECRET);
      expect(JSON.stringify(audit)).not.toContain(SECRET);
      expect(readFileSync(path.join(setup.dataPath, "models.yaml"), "utf8")).toContain(SECRET);
    } finally {
      await setup.stop();
    }
  });

  it("keeps command invocations out of the message routing", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }] });
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["room1"] } });
      await applyProfile(setup, "mainbot");

      await setup.message("alice", "ishiki.status");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(setup.host.runtimes.size).toBe(0);
      expect(setup.outputs().some((output) => output.includes("激活 Profile"))).toBe(true);

      await setup.message("alice", "hello");
      await vi.waitFor(() => expect(setup.host.runtimes.size).toBe(1));
      const runtime = [...setup.host.runtimes.values()][0];
      await runtime.storage.read().then((entries) => {
        expect(entries.some((entry) => entry.type === "message" && JSON.stringify(entry).includes("ishiki.status"))).toBe(false);
      });
    } finally {
      await setup.stop();
    }
  });

  it("reports ambiguity when a profile filter matches multiple runtimes", async () => {
    const setup = await startApp();
    try {
      await writeProfile(setup.dataPath, "mainbot", { model: "mock:vision", mode: "channel", channels: { "test:10001": ["roomA", "roomB"] } });
      await applyProfile(setup, "mainbot");
      setup.host.ensureRuntime("mainbot", { mode: "channel", platform: "test", selfId: "10001", channelId: "roomA" });
      setup.host.ensureRuntime("mainbot", { mode: "channel", platform: "test", selfId: "10001", channelId: "roomB" });

      await expect(resolveRuntime(setup.host, undefined, { profile: "mainbot" }, undefined)).rejects.toMatchObject({ code: "ambiguous" });
      const single = await resolveRuntime(setup.host, undefined, {}, setup.session("alice", "roomA"));
      expect(single.view.id).toBe("mainbot/test:10001/roomA");
    } finally {
      await setup.stop();
    }
  });

  it("keeps descriptions resolvable for the root and contributed command groups", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }] });
    try {
      expect(setup.app.i18n.get("commands.ishiki.description")).toMatchObject({ "": "ishiki 管理指令" });
      expect(setup.app.i18n.get("commands.ishiki.chat.description")).toMatchObject({ "": "聊天上下文管理" });
      expect(setup.app.i18n.get("commands.ishiki.standard.description")).toMatchObject({ "": "上下文管理" });
    } finally {
      await setup.stop();
    }
  });
});
