import { createCustomMessage, createEntry, createUserMessage } from "@yesimagent/core";
import { Service } from "koishi";
import { describe, expect, it, vi } from "vitest";

import { ContextEngine, type ContextEngineInstance } from "../src/context/engine.js";
import { StandardContextEngine, StandardContextInstance } from "../src/context/standard.engine.js";
import type { AgentRuntime } from "../src/runtime.js";
import { lastOutput, SECRET, startApp, writeProfile, type TestSetup } from "./harness.js";

declare module "../src/context/engine.js" {
  interface ContextEngines {
    probe: {};
  }
}

/** 第二个真实上下文引擎：条目原样透传，充当能力检查的对照组。 */
class ProbeContextEngine extends ContextEngine<"probe"> {
  constructor(ctx: Context) {
    super(ctx, "probe");
  }

  public [Service.invoke](): ContextEngineInstance {
    return {};
  }
}

function crossRuntime(setup: TestSetup, profileId: string): AgentRuntime {
  const profile = setup.host.findProfile(profileId);
  return setup.host.ensureRuntime(profileId, { mode: "cross", channels: profile!.channels });
}

/** 预置：先投递一条消息让引擎实例 attach 到 agent（wakeup 引擎会触发一次真实轮次并失败落盘），
 * 等事件写入稳定后再写入超长既有摘要与两个空轮次，使手动压缩走锚点追加路径（无摘要生成，离线可复现）。 */
async function seedOversizedSummary(setup: TestSetup, runtime: AgentRuntime): Promise<string> {
  await setup.host.deliver(
    runtime.id,
    createCustomMessage("ishiki.message.created", {
      timestamp: Date.now(),
      platform: "test",
      selfId: "10001",
      channelId: "room1",
      isDirect: true,
      messageId: "m0",
      content: "hi",
      user: { id: "alice", name: "alice" },
    }),
  );
  let previous = -1;
  await vi.waitFor(async () => {
    const size = (await runtime.storage.read()).length;
    const stable = size === previous && size >= 3;
    previous = size;
    expect(stable).toBe(true);
  });
  const marker = createEntry("message", createUserMessage("seed"));
  await runtime.storage.append(marker);
  await runtime.storage.append(createEntry("ishiki.compact", { summary: "s".repeat(3000), lastEntryId: marker.id }));
  await runtime.storage.append(createEntry("event", { type: "turn.start", turnId: "t1" }));
  const last = createEntry("event", { type: "turn.start", turnId: "t2" });
  await runtime.storage.append(last);
  return last.id;
}

describe("contributed standard context commands", () => {
  it("appends the compaction anchor exactly as the plan preview declared", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }] });
    try {
      await writeProfile(setup.dataPath, "tiny", {
        model: "mock:vision",
        mode: "cross",
        channels: { "test:10001": ["*"] },
        context: { engine: "standard", standard: { maxTokens: 1000, refillRatio: 0.8 } },
      });
      await setup.host.management.profiles.apply("tiny");
      const runtime = crossRuntime(setup, "tiny");
      const throughEntryId = await seedOversizedSummary(setup, runtime);

      await setup.session("alice").execute("ishiki.standard.usage tiny/main");
      const usage = lastOutput(setup);
      expect(usage).toContain("tiny/main");
      expect(usage).toContain("可压缩");
      const stats = await (runtime.context as StandardContextInstance).stats();
      expect(stats.plan?.throughEntryId).toBe(throughEntryId);
      expect(stats.plan?.droppedEntries).toBe(0);

      await setup.session("alice").execute("ishiki.standard.compact tiny/main -y");
      const output = lastOutput(setup);
      expect(output).toContain("压缩完成");
      expect(output).not.toContain('回复"确认"继续执行');
      const entries = await runtime.storage.read();
      const anchor = entries.findLast((entry) => entry.type === "ishiki.compact");
      expect(anchor?.data.lastEntryId).toBe(throughEntryId);
      expect(anchor?.data.summary).toBe("s".repeat(3000));

      await setup.session("alice").execute("ishiki.standard.summary tiny/main");
      expect(lastOutput(setup)).toContain("sss");
    } finally {
      await setup.stop();
    }
  });

  it("rejects the commands on a runtime whose context engine is not standard", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }], plugins: [ProbeContextEngine] });
    try {
      await writeProfile(setup.dataPath, "probed", {
        model: "mock:vision",
        mode: "cross",
        channels: { "test:10001": ["*"] },
        context: { engine: "probe" },
      });
      await setup.host.management.profiles.apply("probed");
      crossRuntime(setup, "probed");

      for (const command of ["usage", "summary", "compact"]) {
        await setup.session("alice").execute(`ishiki.standard.${command} probed/main`);
        expect(lastOutput(setup)).toContain("probe");
        expect(lastOutput(setup)).toContain("standard");
      }
    } finally {
      await setup.stop();
    }
  });

  it("unregisters the commands with the engine plugin and restores them on reload", async () => {
    const setup = await startApp();
    try {
      await vi.waitFor(() => {
        expect(setup.app.$commander.get("ishiki.standard.usage")).toBeTruthy();
      });

      const engine = setup.app.registry.get(StandardContextEngine);
      expect(engine).toBeTruthy();
      await engine!.dispose();
      expect(setup.app.$commander.get("ishiki.standard.usage")).toBeUndefined();
      expect(setup.app.$commander.get("ishiki.standard.compact")).toBeUndefined();

      setup.app.plugin(StandardContextEngine);
      await vi.waitFor(() => {
        expect(setup.app.$commander.get("ishiki.standard.usage")).toBeTruthy();
      });
    } finally {
      await setup.stop();
    }
  });

  it("rejects read commands on offline runtimes", async () => {
    const setup = await startApp({ users: [{ id: "alice", authority: 2 }] });
    try {
      await writeProfile(setup.dataPath, "tiny", {
        model: "mock:vision",
        mode: "cross",
        channels: { "test:10001": ["*"] },
        context: { engine: "standard", standard: { maxTokens: 1000 } },
      });
      await setup.host.management.profiles.apply("tiny");
      const runtime = crossRuntime(setup, "tiny");
      await seedOversizedSummary(setup, runtime);

      await setup.session("alice").execute("ishiki.standard.usage tiny/main");
      expect(lastOutput(setup)).toContain("tiny/main");

      await setup.host.deactivateRuntime("tiny/main");
      await setup.session("alice").execute("ishiki.standard.usage tiny/main");
      expect(lastOutput(setup)).toContain("未运行");

      const outputs = setup.outputs().join("\n");
      expect(outputs).not.toContain(SECRET);
    } finally {
      await setup.stop();
    }
  });
});
