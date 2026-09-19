import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, createHarness, type Harness, makeContext, makeProfile, promptText, textStep, toolCallStep, waitFor, type StoredEntry } from "./helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

/**
 * The frame a rebuild wrote: the opening frame is appended before the first turn, so the second checkpoint on
 * the stream is the first one a turn can produce. Rebuilds settle after the turn's own hooks, hence the wait.
 */
async function rebuiltCheckpoint(harness: Harness): Promise<StoredEntry> {
  const checkpoints = await waitFor(async () => {
    const found = (await harness.entries()).filter((entry) => entry.type === "ishiki.checkpoint");
    return found.length > 1 ? found : undefined;
  });
  return checkpoints[checkpoints.length - 1];
}

/** A stored fact, for tests that need history before the first turn. */
function storedFact(messageId: string, channelId: string, direct: boolean): string {
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
        channel: { id: channelId, direct },
        messageId,
        timestamp,
        platform: "onebot",
        selfId: "1",
      },
    },
  });
}

function twoSceneProfile(): Partial<ReturnType<typeof makeProfile>> {
  return {
    allowedChannels: [
      { sid: "onebot:1", channels: ["group:1", "group:9"] },
      { sid: "onebot:2", channels: ["group:9"] },
    ],
  };
}

describe("ending the turn", () => {
  it("sends to the open window when nothing was addressed", async () => {
    const harness = await createHarness([toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { messages: ["在吗"] } }), textStep("unreached")]);

    await harness.send();

    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "在吗" }]);
  });

  it("stops after a send that was not told to continue", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["hi"] } }),
      textStep("unreached"),
    ]);

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
      toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["想想"], continue: true } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["再补一句"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"].map((bubble) => bubble.content)).toEqual(["想想", "再补一句"]);
  });

  it("keeps generating when the send failed, keeping what already left", async () => {
    const harness = await createHarness(
      [
        toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["a", "b", "c"] } }),
        toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["retry"] } }),
        textStep("unreached"),
      ],
      { failingContents: ["b"] },
    );

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"].map((bubble) => bubble.content)).toEqual(["a", "retry"]);
  });

  it("keeps generating after a refusal from the whitelist", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:3", messages: ["hi"] } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["fixed"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "fixed" }]);
  });

  it("keeps generating when the addressed body has no live bot", async () => {
    const harness = await createHarness(
      [
        toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { sid: "onebot:3", channel: "group:3", messages: ["hi"] } }),
        toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["fixed"] } }),
        textStep("unreached"),
      ],
      {
        profile: {
          allowedChannels: [
            { sid: "onebot:1", channels: ["group:1"] },
            { sid: "onebot:3", channels: ["group:3"] },
          ],
        },
      },
    );

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(harness.bubbles["onebot:1"]).toEqual([{ channelId: "group:1", content: "fixed" }]);
  });

  it("ends the turn when the model produced no tool call", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    expect(harness.calls()).toBe(1);
    expect(harness.bubbles["onebot:1"]).toEqual([]);
  });
});

describe("switching focus", () => {
  it("addresses the new scene for the rest of the step and starts a new generation", async () => {
    const harness = await createHarness([
      toolCallStep(
        { toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } },
        { toolCallId: "c2", toolName: "send_message", input: { channel: "group:9", messages: ["ping"] } },
      ),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(1);
    expect(harness.bubbles["onebot:2"]).toEqual([{ channelId: "group:9", content: "ping" }]);
    expect(harness.bubbles["onebot:1"]).toEqual([]);

    // The switch is the generation change itself: it lands as a checkpoint, never as a change entry.
    expect((await harness.entries()).filter((entry) => entry.type === "ishiki.focus.changed")).toHaveLength(0);
    const checkpoint = await rebuiltCheckpoint(harness);
    expect(checkpoint.data.frameFocus).toEqual({ sid: "onebot:2", channelId: "group:9" });
  });

  it("lets a second switch in one step end another generation", async () => {
    const harness = await createHarness([
      toolCallStep(
        { toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } },
        { toolCallId: "c2", toolName: "switch_focus", input: { sid: "onebot:1", channel: "group:1" } },
      ),
      textStep("unreached"),
    ]);

    await harness.send();

    // No cooldown: a switch ends the generation, so the frame simply starts where the step finished and the
    // pending hop is the trajectory it came through.
    const checkpoint = await rebuiltCheckpoint(harness);
    expect(checkpoint.data.frameFocus).toEqual({ sid: "onebot:1", channelId: "group:1" });
    expect((await harness.entries()).filter((entry) => entry.type === "ishiki.focus.changed")).toHaveLength(0);
  });

  it("refuses a body the profile does not own", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:9", channel: "group:1" } }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect((await harness.entries()).filter((entry) => entry.type === "ishiki.focus.changed")).toHaveLength(0);
  });
});

describe("peeking", () => {
  it("hands the target scene's recent facts to the next step", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1", limit: 5 } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["after peek"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(JSON.stringify(harness.prompts()[1])).toContain("#m1: hello");
  });

  it("refuses a limit beyond the ceiling without breaking the turn", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1", limit: 51 } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["still here"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    expect(harness.calls()).toBe(2);
    expect(JSON.stringify(harness.prompts()[1])).toContain("LimitTooLarge");
  });
});

describe("send mode", () => {
  it("escapes raw content and passes element content through", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ['<at id="1"/>'], mode: "raw", continue: true } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ['<at id="1"/>'] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    const [raw, element] = harness.bubbles["onebot:1"];
    expect(String(raw.content)).not.toContain("<");
    expect(element.content).toBe('<at id="1"/>');
  });
});

describe("ingestion", () => {
  it("ignores a channel outside the whitelist", async () => {
    const harness = await createHarness([textStep("unreached")]);

    await harness.send({ channelId: "group:3" });

    expect(harness.calls()).toBe(0);
  });

  it("does not wake on an unrelated message", async () => {
    const harness = await createHarness([textStep("unreached")]);

    await harness.send({ isDirect: false });

    expect(harness.calls()).toBe(0);
  });

  it("wakes on a keyword", async () => {
    const harness = await createHarness([textStep("unreached")], { profile: { keywords: ["上线"] } });

    await harness.send({ isDirect: false, content: "我们上线了" });

    expect(harness.calls()).toBe(1);
  });

  it("ignores a message sent by one of its own bodies", async () => {
    const harness = await createHarness([textStep("unreached")]);

    // `onebot:1` is the profile's own body: its own words must not come back as somebody else's input.
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
    // agent.send with trigger:false persists asynchronously (fire-and-forget); wait for it to land.
    const deletion = await waitFor(async () => {
      const entries = await harness.entries();
      return entries.find((e) => String(e.data["type"]) === "ishiki.message.deleted");
    });
    expect(deletion).toBeDefined();
    expect((deletion!.data["data"] as { messageId: string }).messageId).toBe("m1");
  });
});

describe("three zones", () => {
  it("opens a fresh profile with its position and the window's first line", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).toContain('<frame at="');
    expect(text).toContain('sid="onebot:1" channel="group:1"');
    expect(text).toContain("（在此之前没有发生过任何事。）");
    expect(text).toContain('<focus sid="onebot:1" channel="group:1">');
    expect(text).toContain("Miaow(42) #m1: hello");
  });

  it("tells the mind which lines are its own", async () => {
    const harness = await createHarness([textStep("nothing")]);

    await harness.send();

    // Nothing marks a sent line any more, so the prompt has to say how to recognise it.
    expect(promptText(harness.prompts(), 0)).toContain("行里括号中的 id 等于你的 uid 时");
  });

  it("opens a run header once per stretch of lines from the window", async () => {
    const harness = await createHarness([textStep("nothing")], {
      profile: twoSceneProfile(),
      seed: [storedFact("m1", "group:1", false), storedFact("m2", "group:1", false), storedFact("m3", "group:9", true), storedFact("m4", "group:1", false)],
    });

    await harness.send({ messageId: "m5" });

    const text = promptText(harness.prompts(), 0);
    // m1 opens a run, m2 shares it, the line from elsewhere closes it, m4 and m5 open the next one.
    expect(text.match(/<focus sid="onebot:1" channel="group:1">/g)).toHaveLength(2);
    expect(text.indexOf("Miaow(42) #m1: m1")).toBeLessThan(text.indexOf("Miaow(42) #m2: m2"));
  });

  it("states the position of a generation whose stream has no checkpoint", async () => {
    const fact = {
      content: "hello",
      user: { id: "42", name: "Miaow" },
      channel: { id: "group:1", name: "开发组", direct: false },
      messageId: "m0",
      timestamp: 1_700_000_000_000,
      platform: "onebot",
      selfId: "1",
    };
    const harness = await createHarness([textStep("nothing"), textStep("nothing")], {
      seed: [
        JSON.stringify({
          id: "f0",
          type: "message",
          timestamp: fact.timestamp,
          data: { id: "f0", timestamp: fact.timestamp, role: "custom", type: "ishiki.message.created", data: fact },
        }),
      ],
    });

    await harness.send();
    await harness.send();

    const first = promptText(harness.prompts(), 0);
    const head = /<frame at="\d{2}:\d{2}" focus_sid="onebot:1" focus_channel="group:1"\/>/;
    expect(first).toMatch(head);
    expect(first).toContain("Miaow(42) #m0: hello");
    // Derived, not stored: the head is the same string on the next turn.
    expect(promptText(harness.prompts(), 1)).toMatch(head);
  });

  it("keeps the model-visible prefix stable between steps of one turn", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1" } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["done"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    const [first, second] = harness.prompts() as unknown[][];
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("shows another scene's fact as a notification only when it reaches the mind", async () => {
    const direct = await createHarness([textStep("nothing")], { profile: twoSceneProfile() });
    await direct.send({ channelId: "group:9", content: "在吗" });
    const directText = promptText(direct.prompts(), 0);
    expect(directText).toContain('<notification sid="onebot:1" channel="group:9"');
    expect(directText).toContain("在吗");

    const keyword = await createHarness([textStep("nothing")], { profile: { ...twoSceneProfile(), keywords: ["上线"] } });
    await keyword.send({ channelId: "group:9", isDirect: false, content: "我们上线了" });
    const keywordText = promptText(keyword.prompts(), 0);
    expect(keywordText).toContain('<notification sid="onebot:1" channel="group:9"');
    expect(keywordText).toContain("我们上线了");

    const quiet = await createHarness([textStep("nothing")], { profile: twoSceneProfile() });
    await quiet.send({ channelId: "group:9", isDirect: false, content: "随便说说" });
    await quiet.send();
    expect(quiet.calls()).toBe(1);
    expect(promptText(quiet.prompts(), 0)).not.toContain("随便说说");
  });

  it("hands the step after a switch the new frame, with the scene it left still in it", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:9", messages: ["ping"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    // The switch rebuilt the generation at the step boundary, so the next step already reads the new frame.
    const text = promptText(harness.prompts(), 1);
    expect(text).toContain("<frame at=");
    expect(text).toContain('focus_sid="onebot:2" focus_channel="group:9"');
    expect(text).toContain('<history sid="onebot:2" channel="group:9" focus>');
    // The scene it came from keeps a segment of its own, read back out of storage.
    expect(text).toContain('<history sid="onebot:1" channel="group:1">');
    expect(text).toContain("Miaow(42) #m1: hello");
    expect(text).not.toContain("<last_focus_history");
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

describe("state slot", () => {
  const slotPattern = /<state>[^<]*<\/state>/;

  it("opens between the frame and the workspace", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).toMatch(/当前时间:\d{4}年\d{1,2}月\d{1,2}日 (凌晨|上午|下午|晚上)/);
    expect(text.indexOf("<state>")).toBeGreaterThan(text.indexOf("<frame at="));
    expect(text.indexOf("</state>")).toBeLessThan(text.indexOf("Miaow(42) #m1: hello"));
    // Derived, never stored: nothing on the stream carries the slot.
    expect(JSON.stringify(await harness.entries())).not.toContain("<state>");
  });

  it("reports the wall clock rather than the time of the last fact", async () => {
    // The seeded fact is from 2023; the slot still has to say what day it is now.
    const harness = await createHarness([textStep("nothing")], { seed: [storedFact("m1", "group:1", false)] });

    await harness.send();

    const now = new Date();
    const hour = now.getHours();
    const part = hour < 6 ? "凌晨" : hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
    const text = promptText(harness.prompts(), 0);
    expect(text).toContain(`当前时间:${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${part}`);
    expect(text).not.toContain("2023年");
  });

  it("renders the same slot on every step of a turn", async () => {
    const harness = await createHarness([toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1" } }), textStep("unreached")]);

    await harness.send();

    const slots = harness.prompts().map((_, index) => promptText(harness.prompts(), index).match(slotPattern)?.[0]);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toBeDefined();
    expect(slots[1]).toBe(slots[0]);
  });

  it("opens after the position statement when the stream has no checkpoint", async () => {
    const harness = await createHarness([textStep("nothing")], { seed: [storedFact("m1", "group:1", false)] });

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).toMatch(/<frame at="\d{2}:\d{2}" focus_sid="onebot:1" focus_channel="group:1"\/>/);
    expect(text.indexOf("<state>")).toBeGreaterThan(text.indexOf("<frame at="));
  });
});

describe("frame rebuild", () => {
  it("writes a checkpoint once the workspace outgrows its budget", async () => {
    const harness = await createHarness([textStep("nothing")], { profile: { context: makeContext({ workspaceTokenLimit: 1 }) } });

    await harness.send();

    const checkpoint = await rebuiltCheckpoint(harness);
    expect(checkpoint.data.frameFocus).toEqual({ sid: "onebot:1", channelId: "group:1" });
    expect(String(checkpoint.data.text)).toContain("<frame");
    // The focus segment is the generation's own record, so the line that filled the budget is right there.
    expect(String(checkpoint.data.text)).toContain("Miaow(42) #m1: hello");
  });

  it("starts the next turn from the materialized frame", async () => {
    const harness = await createHarness([textStep("nothing"), textStep("nothing")], {
      profile: { context: makeContext({ workspaceTokenLimit: 1 }) },
    });

    await harness.send();
    await rebuiltCheckpoint(harness);
    await harness.send();

    const text = promptText(harness.prompts(), 1);
    expect(text).toContain("<frame");
    expect(text.indexOf("<frame")).toBeLessThan(text.indexOf("Miaow(42) #m1: hello"));
  });

  it("keeps the assistant's prose out of the frame and prints tool traffic in full", async () => {
    const harness = await createHarness(
      [toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1" } }), textStep("这段文字不该进帧")],
      { profile: { context: makeContext({ workspaceTokenLimit: 1 }) } },
    );

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // Frame contains only message facts — no tool traces, no assistant prose.
    expect(text).not.toContain("[工具调用]");
    expect(text).not.toContain("[工具结果]");
    expect(text).not.toContain("这段文字不该进帧");
  });

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
      { profile: { innerThought: true, context: makeContext({ workspaceTokenLimit: 1 }) } },
    );

    await harness.send();

    // The step after the send reads the monologue as the mind's own text: the tool call carries it whole.
    expect(promptText(harness.prompts(), 1)).toContain("先看看反应");
    // The frame only stores message facts, not tool arguments; the monologue does not survive into the frame.
    expect(String((await rebuiltCheckpoint(harness)).data.text)).not.toContain("先看看反应");
  });

  it("hands the mind only the outcome of a send", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["hi"], continue: true } }),
      textStep("done"),
    ]);

    await harness.send();

    const afterSend = promptText(harness.prompts(), 1);
    expect(afterSend).toContain('"ok":true');
    expect(afterSend).toContain('"count":1');
    expect(afterSend).not.toContain("messageIds");
    // The sent line is a fact for the frame and for `peek_channel`; the live view shows only the call that sent it.
    expect(afterSend).not.toContain("#id-1");
  });

  it("records one fact per sent bubble, and the frame reads it back like any other line", async () => {
    const harness = await createHarness(
      [
        toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["在的", "刚睡醒"], continue: true } }),
        textStep("done"),
      ],
      { profile: { context: makeContext({ workspaceTokenLimit: 1 }) } },
    );

    await harness.send();

    // Two bubbles left, so two ordinary facts landed, carrying the ids the platform handed back and the account
    // that said them.
    const facts = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => entry.data["data"] as { messageId: string; user: { id: string } });
    expect(facts.map((fact) => fact.messageId)).toEqual(["id-1", "id-2"]);
    expect(facts.map((fact) => fact.user.id)).toEqual(["1", "1"]);

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    expect(text).toContain("NekoChan(1) #id-1: 在的");
    expect(text).toContain("NekoChan(1) #id-2: 刚睡醒");
  });

  it("sends to another scene by plain addressing, with no wrapper of its own", async () => {
    const harness = await createHarness(
      [
        toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { sid: "onebot:2", channel: "group:9", messages: ["那边好"], continue: true } }),
        textStep("done"),
      ],
      { profile: { ...twoSceneProfile(), context: makeContext({ workspaceTokenLimit: 1 }) } },
    );

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // The words become an ordinary fact of the target scene's history segment.
    expect(text).toContain("NekoChan(2) #id-1: 那边好");

    const mine = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => entry.data["data"] as { content: string; user: { id: string } })
      .filter((fact) => fact.user.id === "2");
    expect(mine.map((fact) => fact.content)).toEqual(["那边好"]);
  });

  it("records every bubble sent to another scene, wherever it went", async () => {
    const harness = await createHarness(
      [
        toolCallStep(
          { toolCallId: "c1", toolName: "send_message", input: { sid: "onebot:2", channel: "group:9", messages: ["一", "二"], continue: true } },
          { toolCallId: "c2", toolName: "send_message", input: { sid: "onebot:2", channel: "group:9", messages: ["三"], continue: true } },
        ),
        textStep("done"),
      ],
      { profile: { ...twoSceneProfile(), context: makeContext({ workspaceTokenLimit: 1 }) } },
    );

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // Three bubbles become ordinary facts of the target scene.
    expect(text).toContain("NekoChan(2)");

    const mine = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => entry.data["data"] as { content: string; user: { id: string } })
      .filter((fact) => fact.user.id === "2");
    expect(mine.map((fact) => fact.content)).toHaveLength(3);
    expect(mine.map((fact) => fact.content)).toEqual(expect.arrayContaining(["一", "二", "三"]));
    // Bubbles of one send keep their order. Two calls in one step run concurrently, so how the two calls
    // interleave is not fixed — the facts land in the order the platform actually took them.
    expect(mine.map((fact) => fact.content).filter((content) => content !== "三")).toEqual(["一", "二"]);
  });

  it("hands a switch's own trajectory to the scene it is leaving", async () => {
    const harness = await createHarness([
      toolCallStep(
        { toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } },
        { toolCallId: "c2", toolName: "send_message", input: { channel: "group:1", messages: ["先说一句"] } },
      ),
      textStep("unreached"),
    ]);

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // Focus switched to group:9; both scenes appear as history segments (all from storage).
    expect(text).toContain('<history sid="onebot:2" channel="group:9" focus>');
    expect(text).toContain('<history sid="onebot:1" channel="group:1">');
    // The original message that triggered the turn is in group:1's history.
    expect(text).toContain("Miaow(42) #m1: hello");
    // Frames no longer contain tool traces — only message facts.
    expect(text).not.toContain("[工具调用]");
  });

  it("reads the mind's own words back inside the window they were said in", async () => {
    const harness = await createHarness(
      [
        toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { sid: "onebot:2", channel: "group:9", messages: ["那边好"], continue: true } }),
        toolCallStep({ toolCallId: "c2", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } }),
        textStep("unreached"),
      ],
      { profile: twoSceneProfile() },
    );

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // Said in the window the switch opens, so it is the window's own line, read back like anybody else's.
    const head = text.indexOf('<history sid="onebot:2" channel="group:9"');
    expect(head).toBeGreaterThan(-1);
    expect(text.indexOf("NekoChan(2) #id-1: 那边好")).toBeGreaterThan(head);
  });

  it("keeps a failed send's call and its result, and records no message", async () => {
    const harness = await createHarness(
      [toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["发不出去"], continue: true } }), textStep("done")],
      { profile: { context: makeContext({ workspaceTokenLimit: 1 }) }, failingContents: ["发不出去"] },
    );

    await harness.send();

    const text = String((await rebuiltCheckpoint(harness)).data.text);
    // Frame only contains message facts; tool traces are not folded into frames.
    expect(text).not.toContain("[工具调用]");
    // Nothing left the machine, so no self message was recorded either.
    const mine = (await harness.entries()).filter((entry) => String(entry.data["type"]) === "ishiki.self.message");
    expect(mine).toHaveLength(0);
  });

  it("keeps the monologue in the trace of a failed send", async () => {
    const harness = await createHarness(
      [
        toolCallStep({
          toolCallId: "c1",
          toolName: "send_message",
          input: { channel: "group:1", messages: ["发不出去"], continue: true, inner_thought: "这句进帧" },
        }),
        textStep("done"),
      ],
      { profile: { innerThought: true, context: makeContext({ workspaceTokenLimit: 1 }) }, failingContents: ["发不出去"] },
    );

    await harness.send();

    // The send failed so no self-message fact was recorded; frame has no trace of the attempt.
    const text = String((await rebuiltCheckpoint(harness)).data.text);
    expect(text).not.toContain("[工具调用]");
    expect(text).not.toContain("发不出去");
    expect(text).not.toContain("这句进帧");
  });

  it("restores the frame and the live focus from the last checkpoint", async () => {
    const frame = ['<frame at="00:00" sid="onebot:1" channel="group:1">', "<history>", "SEEDED", "</history>", "</frame>"].join("\n");
    const harness = await createHarness(
      [toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:9", messages: ["ping"] } }), textStep("unreached")],
      {
        seed: [
          JSON.stringify({
            id: "cp",
            type: "ishiki.checkpoint",
            timestamp: 1000,
            data: { frameFocus: { sid: "onebot:1", channelId: "group:1" }, text: frame, createdAt: 1000 },
          }),
          JSON.stringify({
            id: "sw",
            type: "ishiki.focus.changed",
            timestamp: 1001,
            data: { previous: { sid: "onebot:1", channelId: "group:1" }, next: { sid: "onebot:2", channelId: "group:9" } },
          }),
        ],
      },
    );

    await harness.send();

    expect(promptText(harness.prompts(), 0)).toContain("SEEDED");
    expect(harness.bubbles["onebot:2"]).toEqual([{ channelId: "group:9", content: "ping" }]);
    expect(harness.bubbles["onebot:1"]).toEqual([]);
  });

  it("folds a quiet generation without a turn", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = await createHarness([textStep("nothing")], { profile: { context: makeContext({ idleMs: 0, workspaceTokenLimit: 1_000_000 }) } });

    await harness.send();
    expect((await harness.entries()).filter((entry) => entry.type === "ishiki.checkpoint")).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await rebuiltCheckpoint(harness);
  });

  it("cuts a scene read back out of storage to the tail it is given", async () => {
    const harness = await createHarness([textStep("nothing")], {
      profile: { ...twoSceneProfile(), context: makeContext({ workspaceTokenLimit: 1, historyEntries: 1 }) },
      seed: [storedFact("g1", "group:9", true), storedFact("g2", "group:9", true)],
    });

    await harness.send();

    const checkpoint = await waitFor(async () => {
      const found = (await harness.entries()).filter((entry) => entry.type === "ishiki.checkpoint");
      return found.length > 0 ? found[found.length - 1] : undefined;
    });
    const text = String(checkpoint.data.text);
    // All scenes are read from storage with the same tail rule; group:9 has 2 facts, limit is 1.
    expect(text).toContain("<!-- 更早 1 条已折叠 -->");
    expect(text).toContain("g2");
    expect(text).not.toContain("#g1");
    // The focus scene (group:1) only has 1 fact, so the limit doesn't cut it.
    expect(text).toContain("Miaow(42) #m1: hello");
  });

  it("falls back to the profile's own name when the platform reports none", async () => {
    const harness = await createHarness(
      [toolCallStep({ toolCallId: "c1", toolName: "send_message", input: { channel: "group:1", messages: ["在"] } }), textStep("done")],
      { profile: { name: "小喵", context: makeContext({ workspaceTokenLimit: 1 }) }, botName: "" },
    );

    await harness.send();

    const names = (await harness.entries())
      .filter((entry) => String(entry.data["type"]) === "ishiki.self.message")
      .map((entry) => (entry.data["data"] as { user: { name?: string } }).user.name);
    expect(names).toEqual(["小喵"]);
    expect(String((await rebuiltCheckpoint(harness)).data.text)).toContain("小喵(1) #id-1: 在");
  });
});
