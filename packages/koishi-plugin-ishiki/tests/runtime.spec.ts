import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, createHarness, type Harness, makeContext, makeProfile, promptText, textStep, toolCallStep, waitFor, type StoredEntry } from "./helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

/** A rebuild runs after the turn's own hooks settle, so the assertions wait for the checkpoint instead of racing it. */
async function checkpointOf(harness: Harness): Promise<StoredEntry> {
  return await waitFor(async () => (await harness.entries()).find((entry) => entry.type === "ishiki.checkpoint"));
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
  it("addresses the new scene for the rest of the step and records the switch", async () => {
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

    const focusEntries = (await harness.entries()).filter((entry) => entry.type === "ishiki.focus.changed");
    expect(focusEntries).toHaveLength(1);
    expect(focusEntries[0].data.next).toEqual({ sid: "onebot:2", channelId: "group:9" });
  });

  it("records only the first of two switches in one turn", async () => {
    const harness = await createHarness([
      toolCallStep(
        { toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } },
        { toolCallId: "c2", toolName: "switch_focus", input: { sid: "onebot:1", channel: "group:1" } },
      ),
      textStep("unreached"),
    ]);

    await harness.send();

    const focusEntries = (await harness.entries()).filter((entry) => entry.type === "ishiki.focus.changed");
    expect(focusEntries).toHaveLength(1);
    expect(focusEntries[0].data.next).toEqual({ sid: "onebot:2", channelId: "group:9" });
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
});

describe("three zones", () => {
  it("starts with no frame and renders the fact as a focus block", async () => {
    const harness = await createHarness([textStep("nothing to do")]);

    await harness.send();

    const text = promptText(harness.prompts(), 0);
    expect(text).not.toContain("<frame");
    expect(text).toContain('<focus sid="onebot:1" channel="group:1" name="开发组">');
    expect(text).toContain("Miaow(42) #m1: hello");
    expect(text).toContain("</focus>");
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

  it("shows another scene's fact as awareness only when it reaches the mind", async () => {
    const direct = await createHarness([textStep("nothing")], { profile: twoSceneProfile() });
    await direct.send({ channelId: "group:9", content: "在吗" });
    const directText = promptText(direct.prompts(), 0);
    expect(directText).toContain('<awareness sid="onebot:1" channel="group:9"');
    expect(directText).toContain('trigger="direct"');

    const keyword = await createHarness([textStep("nothing")], { profile: { ...twoSceneProfile(), keywords: ["上线"] } });
    await keyword.send({ channelId: "group:9", isDirect: false, content: "我们上线了" });
    expect(promptText(keyword.prompts(), 0)).toContain('trigger="keyword"');

    const quiet = await createHarness([textStep("nothing")], { profile: twoSceneProfile() });
    await quiet.send({ channelId: "group:9", isDirect: false, content: "随便说说" });
    await quiet.send();
    expect(quiet.calls()).toBe(1);
    expect(promptText(quiet.prompts(), 0)).not.toContain("随便说说");
  });

  it("renders the switch as state the model reads and moves the cursor with it", async () => {
    const harness = await createHarness([
      toolCallStep({ toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } }),
      toolCallStep({ toolCallId: "c2", toolName: "send_message", input: { channel: "group:9", messages: ["ping"] } }),
      textStep("unreached"),
    ]);

    await harness.send();

    // The switch is recorded at the step boundary, so the step after it is the first one that can see it.
    const messages = harness.prompts()[1] as Array<{ role: string; content: unknown }>;
    const stated = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
    expect(stated.some((content) => content.includes("focus change") && content.includes("onebot:2:group:9"))).toBe(true);
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
    expect(text).toContain('<focus sid="onebot:1" channel="group:1">');
  });
});

describe("frame rebuild", () => {
  it("writes a checkpoint once the workspace outgrows its budget", async () => {
    const harness = await createHarness([textStep("nothing")], { profile: { context: makeContext({ workspaceTokenLimit: 1, historyEntries: 1 }) } });

    await harness.send();

    const checkpoint = await checkpointOf(harness);
    expect(checkpoint.data.frameFocus).toEqual({ sid: "onebot:1", channelId: "group:1" });
    expect(checkpoint.data.prevFocus).toBeUndefined();
    expect(String(checkpoint.data.text)).toContain("<frame");
    expect(String(checkpoint.data.text)).toContain("条已折叠");
  });

  it("starts the next turn from the materialized frame", async () => {
    const harness = await createHarness([textStep("nothing"), textStep("nothing")], {
      profile: { context: makeContext({ workspaceTokenLimit: 1 }) },
    });

    await harness.send();
    await checkpointOf(harness);
    await harness.send();

    const text = promptText(harness.prompts(), 1);
    expect(text).toContain("<frame");
    expect(text.indexOf("<frame")).toBeLessThan(text.indexOf("Miaow(42) #m1: hello"));
  });

  it("derives the budget from the window the model declares", async () => {
    const roomy = await createHarness([textStep("nothing")], {
      profile: { context: makeContext({ workspaceTokenLimit: undefined }) },
      contextWindow: 1_000_000,
    });
    await roomy.send();
    expect((await roomy.entries()).some((entry) => entry.type === "ishiki.checkpoint")).toBe(false);

    const tight = await createHarness([textStep("nothing")], {
      profile: { context: makeContext({ workspaceTokenLimit: undefined }) },
      contextWindow: 8,
    });
    await tight.send();
    await checkpointOf(tight);
  });

  it("splits the switched generation into a trajectory and a fresh window", async () => {
    const harness = await createHarness([
      toolCallStep(
        { toolCallId: "c1", toolName: "switch_focus", input: { sid: "onebot:2", channel: "group:9" } },
        { toolCallId: "c2", toolName: "send_message", input: { channel: "group:9", messages: ["ping"] } },
      ),
      textStep("unreached"),
    ]);

    await harness.send();

    const checkpoint = await checkpointOf(harness);
    const text = String(checkpoint.data.text);
    expect(checkpoint.data.frameFocus).toEqual({ sid: "onebot:2", channelId: "group:9" });
    expect(checkpoint.data.prevFocus).toEqual({ sid: "onebot:1", channelId: "group:1" });
    expect(text).toContain('<last_focus_history sid="onebot:1"');
    expect(text).toContain("[focus change] onebot:1:group:1 → onebot:2:group:9");
    expect(text.indexOf("<last_focus_history")).toBeLessThan(text.indexOf("<history>"));
  });

  it("keeps the mind's own words out of the frame and truncates its tool results", async () => {
    const harness = await createHarness(
      [toolCallStep({ toolCallId: "c1", toolName: "peek_channel", input: { channel: "group:1" } }), textStep("这段文字不该进帧")],
      { profile: { context: makeContext({ workspaceTokenLimit: 1, toolResultChars: 20 }) } },
    );

    await harness.send();

    const text = String((await checkpointOf(harness)).data.text);
    expect(text).toContain("[工具结果] peek_channel:");
    expect(text).toContain("[已截断");
    expect(text).not.toContain("这段文字不该进帧");
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
    expect((await harness.entries()).some((entry) => entry.type === "ishiki.checkpoint")).toBe(false);

    vi.advanceTimersByTime(60_000);
    await checkpointOf(harness);
  });
});
