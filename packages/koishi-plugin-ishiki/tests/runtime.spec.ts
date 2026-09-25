import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SceneAddress } from "../src/profiles.js";
import { cleanup, contextDefaults, createHarness, DEFAULT_SCENE, promptText, temporaryDirectory, textStep, toolCallStep, waitFor } from "./helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

const NINE: SceneAddress = { sid: "onebot:1", channelId: "group:9" };

/** A stored fact, for tests that need history before the first turn. */
function storedFact(messageId: string, scene: SceneAddress = DEFAULT_SCENE): string {
  const timestamp = Date.now();
  return JSON.stringify({
    id: messageId,
    type: "message",
    timestamp,
    data: {
      id: messageId,
      timestamp,
      role: "custom",
      type: "ishiki.message.created",
      data: {
        content: messageId,
        user: { id: "42", name: "Miaow" },
        sid: scene.sid,
        channelId: scene.channelId,
        sceneType: "group",
        messageId,
        timestamp,
        platform: "onebot",
        selfId: scene.sid.slice(scene.sid.indexOf(":") + 1),
      },
    },
  });
}

function sendMessageTool(id: string, input: Record<string, unknown>) {
  return toolCallStep({ toolCallId: id, toolName: "send_message", input });
}

describe("ending the turn", () => {
  it("sends to the scene's own channel when nothing was addressed", async () => {
    const harness = await createHarness([sendMessageTool("c1", { messages: ["在吗"] }), textStep("unreached")]);

    await harness.send();

    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "在吗" }]);
  });

  it("stops after a send that was not told to continue", async () => {
    const harness = await createHarness([sendMessageTool("c1", { channel: "group:1", messages: ["hi"] }), textStep("unreached")]);

    await harness.send();

    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "hi" }]);
    expect(harness.calls()).toBe(1);
  });

  it("stops on finish without sending anything", async () => {
    const harness = await createHarness([toolCallStep({ toolCallId: "c1", toolName: "finish", input: { reason: "不需要回复" } }), textStep("unreached")]);

    await harness.send();

    expect(harness.calls()).toBe(1);
    expect(harness.bubbles["onebot:1"]).toEqual([]);
  });

  it("keeps generating when the send asked to continue", async () => {
    const harness = await createHarness([
      sendMessageTool("c1", { channel: "group:1", messages: ["想想"], continue: true }),
      sendMessageTool("c2", { channel: "group:1", messages: ["再补一句"] }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"].map((bubble) => bubble.content)).toEqual(["想想", "再补一句"]);
  });

  it("keeps generating when the send failed, keeping what already left", async () => {
    const harness = await createHarness(
      [
        sendMessageTool("c1", { channel: "group:1", messages: ["a", "b", "c"] }),
        sendMessageTool("c2", { channel: "group:1", messages: ["retry"] }),
        textStep("unreached"),
      ],
      { failingContents: ["b"] },
    );

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"].map((bubble) => bubble.content)).toEqual(["a", "retry"]);
  });

  it("ends the turn when the model produced no tool call", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    expect(harness.calls()).toBe(1);
    expect(harness.bubbles["onebot:1"]).toEqual([]);
  });
});

describe("scene isolation", () => {
  it("gives each scene its own agent, stream and history", async () => {
    const harness = await createHarness([
      sendMessageTool("c1", { channel: "group:1", messages: ["先说这边"] }),
      sendMessageTool("c2", { channel: "group:9", messages: ["再说那边"] }),
      textStep("unreached"),
    ]);

    await harness.send();
    await harness.send({ channelId: "group:9", messageId: "m2" });

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"]).toEqual([
      { channelId: "group:1", content: "先说这边" },
      { channelId: "group:9", content: "再说那边" },
    ]);

    // Each scene keeps its own file, and each file holds only its own facts.
    const here = await harness.entries();
    const there = await harness.entries(NINE);
    expect(JSON.stringify(here)).toContain('"messageId":"m1"');
    expect(JSON.stringify(here)).not.toContain('"messageId":"m2"');
    expect(JSON.stringify(there)).toContain('"messageId":"m2"');
    expect(JSON.stringify(there)).not.toContain('"messageId":"m1"');

    // The second turn was assembled from the second scene's own history only.
    expect(promptText(harness.prompts(), 1)).toContain("Miaow(42) #m2: hello");
    expect(promptText(harness.prompts(), 1)).not.toContain("Miaow(42) #m1: hello");
  });

  it("mounts nothing for a scene the profile does not claim", async () => {
    const harness = await createHarness([textStep("unreached")]);

    await harness.send({ channelId: "group:3" });

    expect(harness.calls()).toBe(0);
    expect(existsSync(harness.sceneFile({ sid: "onebot:1", channelId: "group:3" }))).toBe(false);
  });

  it("records a fact that wakes nobody, without a turn", async () => {
    const harness = await createHarness([textStep("unreached")]);

    await harness.send({ isDirect: false, content: "随便说说" });

    expect(harness.calls()).toBe(0);
    // A wakeup that decides "wait" still records the fact, so the scene's history stays complete.
    const stored = await waitFor(async () => {
      const entries = await harness.entries();
      return JSON.stringify(entries).includes("随便说说") ? entries : undefined;
    });
    expect(stored).toHaveLength(1);
  });

  it("keeps a recorded fact for the turn that does wake the scene", async () => {
    const harness = await createHarness([textStep("nothing")]);

    await harness.send({ isDirect: false, content: "刚才在说别的事" });
    await harness.send({ isDirect: false, content: '现在 <at id="1"/> 在吗', messageId: "m2" });

    expect(harness.calls()).toBe(1);
    // The scene mounted on the second message reads the earlier fact back out of its own stream.
    const text = promptText(harness.prompts(), 0);
    expect(text).toContain("刚才在说别的事");
    expect(text).toContain("#m2: 现在");
  });

  it("restores a scene's history after a restart", async () => {
    const baseDir = await temporaryDirectory();

    const first = await createHarness([sendMessageTool("c1", { messages: ["第一次"] })], { baseDir });
    await first.send();
    await first.close();

    const second = await createHarness([sendMessageTool("c1", { messages: ["第二次"] })], { baseDir });
    await second.send();

    const prompt = promptText(second.prompts(), 0);
    expect(prompt).toContain("Miaow(42) #m1: hello");
    expect(second.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "第二次" }]);
  });
});

describe("send mode", () => {
  it("escapes raw content and passes element content through", async () => {
    const harness = await createHarness([
      sendMessageTool("c1", { channel: "group:1", messages: ['<at id="1"/>'], mode: "raw", continue: true }),
      sendMessageTool("c2", { channel: "group:1", messages: ['<at id="1"/>'] }),
      textStep("unreached"),
    ]);

    await harness.send();

    const [raw, element] = harness.bubbles["onebot:1"];
    expect(String(raw.content)).not.toContain("<");
    expect(element.content).toBe('<at id="1"/>');
  });
});

describe("ingestion", () => {
  it("does not wake on an unrelated message", async () => {
    const harness = await createHarness([textStep("unreached")]);

    await harness.send({ isDirect: false });

    expect(harness.calls()).toBe(0);
  });

  it("wakes on a keyword", async () => {
    const harness = await createHarness([textStep("unreached")], { profile: { presets: { default: { wakeup: { keywords: ["上线"] } } } } });

    await harness.send({ isDirect: false, content: "我们上线了" });

    expect(harness.calls()).toBe(1);
  });

  it("reads a mention of its own account out of the content", async () => {
    // The fabricated session carries no element list, so only the content can answer this question.
    const other = await createHarness([textStep("unreached")]);
    await other.send({ isDirect: false, content: '在吗 <at id="9"/>' });
    expect(other.calls()).toBe(0);

    const mine = await createHarness([textStep("nothing")]);
    await mine.send({ isDirect: false, content: '在吗 <at id="1"/>' });
    expect(mine.calls()).toBe(1);
  });

  it("ignores a message sent by one of its own bodies", async () => {
    const harness = await createHarness([textStep("unreached")]);

    // `onebot:1` is one of the profile's own bodies: its own words must not come back as somebody else's input.
    await harness.send({ userId: "1", author: { name: "NekoChan" } });

    expect(harness.calls()).toBe(0);
    expect(JSON.stringify(await harness.entries())).not.toContain("NekoChan");
  });

  it("still ingests a message from anyone else", async () => {
    const harness = await createHarness([textStep("nothing")]);

    await harness.send({ userId: "42", author: { name: "Miaow" } });

    expect(harness.calls()).toBe(1);
    expect(promptText(harness.prompts(), 0)).toContain("Miaow(42) #m1: hello");
  });

  it("ingests a message-deleted event into storage without triggering", async () => {
    const harness = await createHarness([textStep("ack"), textStep("unreached")]);

    // First: a normal message to trigger a turn and populate storage.
    await harness.send();
    // Then: a deletion event for that message — should be ingested but not trigger a new turn.
    await harness.send({ type: "message-deleted", messageId: "m1", channelId: "group:1", userId: "42", content: undefined });

    expect(harness.calls()).toBe(1);
    const deletion = await waitFor(async () => (await harness.entries()).find((entry) => String(entry.data["type"]) === "ishiki.message.deleted"));
    expect(deletion).toBeDefined();
    expect((deletion!.data["data"] as { messageId: string }).messageId).toBe("m1");
  });
});

describe("what the model reads", () => {
  it("shows the waking line and nothing that was never stored", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).not.toContain("<frame");
    expect(text).not.toContain("<focus");
    expect(text).toContain("Miaow(42) #m1: hello");
    expect(JSON.stringify(await harness.entries())).not.toContain("ishiki.checkpoint");
  });

  it("tells the mind which lines are its own", async () => {
    const harness = await createHarness([textStep("nothing")]);

    await harness.send();

    // Nothing marks a sent line any more, so the prompt has to say how to recognise it.
    expect(promptText(harness.prompts(), 0)).toContain("括号里的 id 如果等于你的 uid");
  });

  it("shows earlier lines in the order they were stored", async () => {
    const harness = await createHarness([textStep("nothing")], { seed: [storedFact("m1"), storedFact("m2")] });

    await harness.send({ messageId: "m3" });

    const text = promptText(harness.prompts(), 0);
    expect(text.indexOf("Miaow(42) #m1: m1")).toBeLessThan(text.indexOf("Miaow(42) #m2: m2"));
    expect(text).toContain("Miaow(42) #m3: hello");
  });

  it("keeps a seeded line on the next turn without writing a frame", async () => {
    const harness = await createHarness([textStep("nothing"), textStep("nothing")], {
      seed: [
        JSON.stringify({
          id: "f0",
          type: "message",
          timestamp: 1_700_000_000_000,
          data: {
            id: "f0",
            timestamp: 1_700_000_000_000,
            role: "custom",
            type: "ishiki.message.created",
            data: {
              content: "hello",
              user: { id: "42", name: "Miaow" },
              sid: "onebot:1",
              channelId: "group:1",
              sceneType: "group",
              messageId: "m0",
              timestamp: 1_700_000_000_000,
              platform: "onebot",
              selfId: "1",
            },
          },
        }),
      ],
    });

    await harness.send();
    await harness.send();

    const first = promptText(harness.prompts(), 0);
    expect(first).toContain("Miaow(42) #m0: hello");
    expect(promptText(harness.prompts(), 1)).toContain("Miaow(42) #m0: hello");
    expect(first).not.toContain("<frame");
  });

  it("keeps the model-visible prefix stable between steps of one turn", async () => {
    const harness = await createHarness([
      sendMessageTool("c1", { messages: ["first"], continue: true }),
      sendMessageTool("c2", { messages: ["second"] }),
      textStep("unreached"),
    ]);

    await harness.send();

    const [first, second] = harness.prompts() as unknown[][];
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("keeps earlier lines under the name they arrived with", async () => {
    const harness = await createHarness([textStep("nothing"), textStep("nothing")]);

    await harness.send({ author: { name: "Miaow" } });
    await harness.send({ author: { name: "MiaowFISH" }, messageId: "m2" });

    const text = promptText(harness.prompts(), 1);
    expect(text).toContain("Miaow(42) #m1: hello");
    expect(text).toContain("MiaowFISH(42) #m2: hello");
  });

  it("falls back to ids when the event carried no names", async () => {
    const harness = await createHarness([textStep("nothing")]);

    await harness.send({ author: undefined, event: {} });

    const text = promptText(harness.prompts(), 0);
    expect(text).toContain("] 42 #m1: hello");
    expect(text).not.toContain("Miaow");
  });
});

describe("what a turn leaves behind", () => {
  it("reads its own monologue back, and lets it ride along in the call arguments", async () => {
    const harness = await createHarness(
      [
        toolCallStep({
          toolCallId: "c1",
          toolName: "send_message",
          input: { channel: "group:1", messages: ["hi"], continue: true, inner_thought: "先看看反应" },
        }),
        textStep("done"),
      ],
      { profile: { innerThought: true } },
    );

    await harness.send();

    // The step after the send reads the monologue as the mind's own text: the tool call carries it whole.
    expect(promptText(harness.prompts(), 1)).toContain("先看看反应");
  });

  it("hands the mind only the outcome of a send", async () => {
    const harness = await createHarness([sendMessageTool("c1", { channel: "group:1", messages: ["hi"], continue: true }), textStep("done")]);

    await harness.send();

    const afterSend = promptText(harness.prompts(), 1);
    expect(afterSend).toContain('"ok":true');
    expect(afterSend).toContain('"count":1');
    expect(afterSend).not.toContain("messageIds");
    expect(afterSend).toContain("#id-1: hi");
  });

  it("records one fact per sent bubble and reads it back as a line", async () => {
    const harness = await createHarness([sendMessageTool("c1", { messages: ["在的", "刚睡醒"], continue: true }), textStep("done")]);

    await harness.send();

    const facts = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => entry.data["data"] as { messageId: string; user: { id: string } });
    expect(facts.map((fact) => fact.messageId)).toEqual(["id-1", "id-2"]);
    expect(facts.map((fact) => fact.user.id)).toEqual(["1", "1"]);
    const text = promptText(harness.prompts(), 1);
    expect(text).toContain("NekoChan(1) #id-1: 在的");
    expect(text).toContain("NekoChan(1) #id-2: 刚睡醒");
  });

  it("keeps a failed send's call and its result, and records no message", async () => {
    const harness = await createHarness([sendMessageTool("c1", { messages: ["发不出去"], continue: true }), textStep("done")], {
      failingContents: ["发不出去"],
    });

    await harness.send();

    const mine = (await harness.entries()).filter((entry) => String(entry.data["type"]) === "ishiki.self.message");
    expect(mine).toHaveLength(0);
  });

  it("keeps the monologue in the trace of a failed send", async () => {
    const harness = await createHarness(
      [
        toolCallStep({
          toolCallId: "c1",
          toolName: "send_message",
          input: { messages: ["发不出去"], continue: true, inner_thought: "这句进帧" },
        }),
        textStep("done"),
      ],
      { profile: { innerThought: true }, failingContents: ["发不出去"] },
    );

    await harness.send();

    expect(promptText(harness.prompts(), 1)).toContain("这句进帧");
  });

  it("does not replay a checkpoint an older log left behind", async () => {
    const frame = ["<frame>", "SEEDED", "</frame>"].join("\n");
    const harness = await createHarness([sendMessageTool("c1", { messages: ["ping"] }), textStep("unreached")], {
      seed: [
        JSON.stringify({
          id: "cp",
          type: "ishiki.checkpoint",
          timestamp: 1000,
          data: { frameFocus: { sid: "onebot:1", channelId: "group:1" }, text: frame, createdAt: 1000 },
        }),
      ],
    });

    await harness.send();

    expect(promptText(harness.prompts(), 0)).not.toContain("SEEDED");
    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "ping" }]);
  });

  it("shows only the last maxMessages facts", async () => {
    const harness = await createHarness([textStep("nothing")], { profile: contextDefaults({ maxMessages: 1 }), seed: [storedFact("g1"), storedFact("g2")] });

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).toContain("Miaow(42) #m1: hello");
    expect(text).not.toContain("#g1");
    expect(text).not.toContain("#g2");
  });

  it("falls back to the profile's own name when the platform reports none", async () => {
    const harness = await createHarness([sendMessageTool("c1", { messages: ["在"] }), textStep("done")], { profile: { name: "小喵" }, botName: "" });

    await harness.send();

    const names = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => (entry.data["data"] as { user: { name?: string } }).user.name);
    expect(names).toEqual(["小喵"]);
  });
});

describe("scene types", () => {
  it("routes a private chat and a guild channel by their own rules", async () => {
    const profile = {
      channelRules: [
        { match: { type: "direct" as const }, preset: "default" },
        { match: { type: "guild" as const }, preset: "default" },
        { match: { sid: "onebot:1", channelId: "group:1" }, preset: "default" },
      ],
    };
    const harness = await createHarness([textStep("nothing"), textStep("nothing")], { profile });

    await harness.send({ isDirect: true, channelId: "private:7", messageId: "m7" });
    await harness.send({ isDirect: false, guildId: "guild:1", channelId: "channel:8", messageId: "m8" });
    await harness.send({ messageId: "m9" });

    // A private chat wakes its scene; a guild line that addresses nobody is recorded without a turn.
    expect(harness.calls()).toBe(2);
    expect(existsSync(harness.sceneFile({ sid: "onebot:1", channelId: "private:7" }))).toBe(true);
    expect(existsSync(harness.sceneFile({ sid: "onebot:1", channelId: "channel:8" }))).toBe(true);
    const guild = await waitFor(async () => {
      const entries = await harness.entries({ sid: "onebot:1", channelId: "channel:8" });
      return JSON.stringify(entries).includes('"messageId":"m8"') ? entries : undefined;
    });
    // Nothing mounted the guild scene, so its stream holds the one fact that woke nobody.
    expect(guild).toHaveLength(1);
  });
});
