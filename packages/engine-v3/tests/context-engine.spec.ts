import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCustomMessage, createUserMessage, type AgentMessage, type ToolResultOutput } from "@yesimagent/core";
import type { ExtensionContext } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { V3ContextInstance } from "../src/context-engine.js";

const logger = { warn() {}, error() {}, info() {}, debug() {} } as never;
const homes: string[] = [];
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-v3-context-"));
  homes.push(home);
});

afterEach(async () => {
  for (const directory of homes.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function context(directory = home): ExtensionContext {
  return { root: directory, logger } as never;
}

function toolMessage(toolName = "probe", toolCallId = "call-1", output: ToolResultOutput = { type: "text", value: "ok" }): AgentMessage {
  return {
    id: toolCallId,
    timestamp: 0,
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  };
}

function attachmentMessage() {
  return createCustomMessage("ishiki.attachment", { source: "tool", toolName: "probe", toolCallId: "call-1", items: [] });
}

/** The text a request would carry for one rendered message. */
function textOf(message: AgentMessage): string {
  if (message.role === "custom") return JSON.stringify(message);
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

describe("v3 context attachments", () => {
  it("passes attachment messages through untouched", () => {
    const instance = new V3ContextInstance({}, context());
    const attachment = attachmentMessage();
    const rendered = instance.renderMessages([toolMessage(), attachment]);
    expect(rendered).toContain(attachment);
  });
});

describe("v3 context instructions", () => {
  it("renders the packaged templates instead of failing on a missing resource", () => {
    const instance = new V3ContextInstance({}, context());
    const text = instance.instructions();
    expect(text).toContain("<working_memory>");
    expect(text).toContain("<new_events>");
  });

  it("injects memory blocks from the profile directory", async () => {
    await fs.mkdir(path.join(home, "memory"), { recursive: true });
    await fs.writeFile(path.join(home, "memory", "persona.md"), "---\nlabel: persona\ntitle: 人格\ndescription: 说话方式\n---\n\n猫娘。\n");
    const instance = new V3ContextInstance({}, context());
    const text = instance.instructions();
    expect(text).toContain("<persona>");
    expect(text).toContain("猫娘。");
  });

  it("skips memory blocks when the profile disables them", async () => {
    await fs.mkdir(path.join(home, "memory"), { recursive: true });
    await fs.writeFile(path.join(home, "memory", "persona.md"), "---\nlabel: persona\n---\n\n猫娘。\n");
    const instance = new V3ContextInstance({ memoryBlocks: false }, context());
    expect(instance.instructions()).not.toContain("猫娘。");
  });
});

describe("v3 context rendering", () => {
  it("renders tool results as observation blocks", () => {
    const instance = new V3ContextInstance({}, context());
    const rendered = instance.renderMessages([toolMessage("probe", "call-1", { type: "json", value: { ok: true } })]);
    const text = rendered.map(textOf).join("\n");

    expect(text).toContain("<observation>");
    expect(text).toContain("<function>probe</function>");
    expect(text).toContain("<status>success</status>");
    expect(text).toContain('{"ok":true}');
  });

  it("marks failed tool results as errors", () => {
    const instance = new V3ContextInstance({}, context());
    const rendered = instance.renderMessages([toolMessage("probe", "call-1", { type: "error-text", value: "boom" })]);
    const text = rendered.map(textOf).join("\n");

    expect(text).toContain("<status>error</status>");
    expect(text).toContain("boom");
  });

  it("folds history into a world state and keeps new input after the last assistant turn", () => {
    const instance = new V3ContextInstance({}, context());
    const source = createCustomMessage("ishiki.message.created", {
      platform: "test",
      selfId: "bot",
      channelId: "channel",
      messageId: "m1",
      timestamp: 0,
      content: "hello",
      isDirect: true,
      user: { id: "u" },
    });
    const rendered = instance.renderMessages([source, createUserMessage("follow-up")]);
    expect(rendered).toHaveLength(1);
    const [world] = rendered;
    if (world?.role !== "user" || typeof world.content !== "string") throw new Error("expected a rendered world state");
    expect(world.content).toContain("<world_state>");
    expect(world.content).toContain("<processed_events>");
    expect(world.content).toContain("<new_events>");
    expect(world.content).toContain("hello");
    expect(world.content).toContain("follow-up");
  });
});
