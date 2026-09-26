import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAssistantMessage, createCustomMessage, createEntry, createToolMessage, type AgentEntry, type AgentMessage } from "@yesimagent/core";
import type { Logger } from "koishi";
import { describe, expect, it } from "vitest";

import { ClassicContextEngine, type ClassicContextConfig } from "../src/context/classic.engine.js";
import type { ContextEngineOptions } from "../src/context/engine.js";
import type { IshikiMessageCreated } from "../src/types.js";

const RESOURCES = fileURLToPath(new URL("../resources", import.meta.url));
const logger = { debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** 一个不存在的目录：多数用例不需要记忆块，读不到就是空。 */
const NOWHERE = path.join(tmpdir(), "ishiki-classic-absent");

function engineWith(config: Partial<ClassicContextConfig> = {}, options: Partial<ContextEngineOptions> = {}): ClassicContextEngine {
  return new ClassicContextEngine({ logger, resources: RESOURCES, directory: NOWHERE, ...options }, config);
}

/** 一条频道消息：进事件流、不带轮次号。 */
function incoming(messageId: string, content: string): AgentMessage {
  const data: IshikiMessageCreated = {
    timestamp: Date.now(),
    platform: "onebot",
    selfId: "bot",
    channelId: "room",
    messageId,
    content,
    isDirect: false,
    user: { id: "u1", name: "Neko" },
  };
  return createCustomMessage("ishiki.message.created", data);
}

/** 一次 agent 轮次里的两条：想与做，以及做出来的结果。 */
function turn(turnId: string): AgentEntry[] {
  return [
    createEntry("message", createAssistantMessage([{ type: "text", text: `<thoughts>\n  <observe>${turnId}</observe>\n</thoughts>` }]), { turnId }),
    createEntry("message", createAssistantMessage([{ type: "tool-call", toolCallId: `${turnId}-c`, toolName: "peek_channel_history", input: '{"limit":5}' }]), {
      turnId,
    }),
    createEntry(
      "message",
      createToolMessage([
        { type: "tool-result", toolCallId: `${turnId}-c`, toolName: "peek_channel_history", output: { type: "text", value: `结果 ${turnId}` } },
      ]),
      {
        turnId,
      },
    ),
  ];
}

/** 跑到模型能看到的那条 user 消息为止。 */
function worldOf(engine: ClassicContextEngine, entries: readonly AgentEntry[]): string {
  const windowed = engine.transformEntries(entries);
  const messages = windowed.filter((entry) => entry.type === "message").map((entry) => entry.data);
  const rendered = engine.transformMessages([...messages]);
  const first = rendered[0];
  return first !== undefined && typeof first.content === "string" ? first.content : "";
}

/** 取出一节的内容。 */
function section(world: string, name: string): string {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(world)?.[1] ?? "";
}

/** 造一个带记忆块文件的 profile 目录；调用方负责删掉它。 */
function withMemory(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ishiki-classic-"));
  mkdirSync(path.join(directory, "memory"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, "memory", name), content);
  return directory;
}

describe("classic context: 工作记忆切分", () => {
  it("最后一条 assistant 之后算新到：工具结果与新消息都落在 new_events", () => {
    const entries = [createEntry("message", incoming("m1", "在吗")), ...turn("t1"), createEntry("message", incoming("m2", "还在吗"))];

    const world = worldOf(engineWith(), entries);

    expect(section(world, "processed_events")).toContain("Neko(u1)] 在吗");
    expect(section(world, "processed_events")).toContain("<observe>t1</observe>");
    expect(section(world, "processed_events")).not.toContain("m2");

    // 观察与新消息都在「新到」里，模型每一步都能先看到上一步的结果。
    expect(section(world, "new_events")).toContain("结果 t1");
    expect(section(world, "new_events")).toContain("Neko(u1)] 还在吗");
    expect(section(world, "new_events")).not.toContain("<observe>t1</observe>");
  });

  it("冷启动没有 assistant 时，全部算新到", () => {
    const world = worldOf(engineWith(), [createEntry("message", incoming("m1", "在吗"))]);

    expect(section(world, "processed_events")).toContain("There are no processed events");
    expect(section(world, "new_events")).toContain("在吗");
  });

  it("频道与成员只来自事件流", () => {
    const world = worldOf(engineWith(), [createEntry("message", incoming("m1", "在吗"))]);

    expect(world).toContain('<channel id="room" type="guild" platform="onebot">');
    expect(world).toContain('<user id="u1"><name>Neko</name></user>');
  });

  it("空窗口给出空节提示而不是空标签", () => {
    const world = worldOf(engineWith(), []);

    expect(world).toContain("No user profiles available in the current context.");
    expect(world).toContain("There are no processed events in the current context.");
    expect(world).toContain("There are no new events since the last time you responded.");
  });
});

describe("classic context: 窗口与优雅降级", () => {
  it("只留窗口内的最后几条消息", () => {
    const entries = ["m1", "m2", "m3", "m4"].map((id) => createEntry("message", incoming(id, `内容 ${id}`)));

    const world = worldOf(engineWith({ maxMessages: 2 }), entries);

    expect(world).not.toContain("内容 m1");
    expect(world).not.toContain("内容 m2");
    expect(world).toContain("内容 m3");
    expect(world).toContain("内容 m4");
  });

  it("更早轮次的 agent 轨迹整段剔除，消息一律保留", () => {
    const entries = [createEntry("message", incoming("m1", "第一条")), ...turn("t1"), createEntry("message", incoming("m2", "第二条")), ...turn("t2")];

    const world = worldOf(engineWith({ keepFullTurnCount: 1 }), entries);

    expect(world).toContain("第一条");
    expect(world).toContain("第二条");
    expect(world).not.toContain("t1");
    expect(world).toContain("t2");
  });

  it("keepFullTurnCount 为 0 表示不降级", () => {
    const entries = [createEntry("message", incoming("m1", "第一条")), ...turn("t1"), ...turn("t2")];

    const world = worldOf(engineWith({ keepFullTurnCount: 0 }), entries);

    expect(world).toContain("t1");
    expect(world).toContain("t2");
  });

  it("越界的参数回落到默认值", () => {
    const engine = engineWith({ maxMessages: 0, keepFullTurnCount: Number.NaN });

    expect(engine.config.maxMessages).toBe(50);
    expect(engine.config.keepFullTurnCount).toBe(2);
  });
});

describe("classic context: 核心记忆块", () => {
  it("读到 frontmatter 并渲染进 system", () => {
    const directory = withMemory({ "persona.md": "---\nlabel: persona\ntitle: 核心人设\ndescription: 我是谁\n---\n\n你是 Neko。\n" });
    try {
      const instructions = engineWith({}, { directory }).extendInstructions();

      expect(instructions).toContain("<core_memory>");
      expect(instructions).toContain("<persona>");
      expect(instructions).toContain("<title>核心人设</title>");
      expect(instructions).toContain("你是 Neko。");
      expect(instructions).toContain("<new_events>");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("关掉开关就不读文件", () => {
    const directory = withMemory({ "persona.md": "---\nlabel: persona\n---\n你是 Neko。\n" });
    try {
      expect(engineWith({ memoryBlocks: false }, { directory }).extendInstructions()).not.toContain("core_memory");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("没有 label、label 不合规、标签重复的文件都被跳过", () => {
    const directory = withMemory({
      "a.md": "---\ntitle: 无标签\n---\n正文\n",
      "b.md": "---\nlabel: bad label!\n---\n正文\n",
      "c.md": "---\nlabel: persona\n---\n先来的\n",
      "d.txt": "---\nlabel: persona\n---\n后来的\n",
    });
    try {
      const instructions = engineWith({}, { directory }).extendInstructions();

      expect(instructions).toContain("先来的");
      expect(instructions).not.toContain("后来的");
      expect(instructions).not.toContain("无标签");
      expect(instructions).not.toContain("bad label!");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("classic context: 装配前提", () => {
  it("缺目录或资源路径时直接抛错，不静默降级", () => {
    expect(() => new ClassicContextEngine({ logger })).toThrow(/needs ContextEngineOptions/);
    expect(() => new ClassicContextEngine({ logger, resources: RESOURCES })).toThrow(/needs ContextEngineOptions/);
  });
});
