import { afterEach, describe, expect, it } from "vitest";

import { cleanupTemporaryDirectories, createHarness, textStep, toolCallStep } from "./helpers.js";

afterEach(cleanupTemporaryDirectories);

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
