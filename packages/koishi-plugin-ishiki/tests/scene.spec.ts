import { createAssistantMessage, createCustomMessage, createEntry, createToolMessage } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import "../src/types.js";
import type { Focus, Profile } from "../src/profiles.js";
import { factsOf, formatClock, frameSegments } from "../src/scene.js";
import type { IshikiEntry } from "../src/types.js";
import { makeProfile } from "./helpers.js";

const ONE: Focus = { sid: "onebot:1", channelId: "group:1" };
const NINE: Focus = { sid: "onebot:2", channelId: "group:9" };
/** One timestamp for the whole file, so no assertion below depends on the machine's time zone. */
const AT = 1_700_000_000_000;
const CLOCK = `[${formatClock(AT)}]`;

/** The account id the platform reports for a body, which is what a line prints in parentheses. */
const selfIdOf = (scene: Focus) => scene.sid.slice(scene.sid.indexOf(":") + 1);

function fact(messageId: string, scene: Focus, options: { content?: string; name?: string; direct?: boolean } = {}) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.created", {
      platform: "onebot",
      selfId: selfIdOf(scene),
      content: options.content ?? messageId,
      user: { id: "42", name: "Miaow" },
      channel: { id: scene.channelId, direct: options.direct, ...(options.name === undefined ? {} : { name: options.name }) },
      messageId,
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function own(messageId: string, scene: Focus) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.self.message", {
      platform: "onebot",
      selfId: selfIdOf(scene),
      content: messageId,
      user: { id: selfIdOf(scene), name: "NekoChan" },
      channel: { id: scene.channelId },
      messageId,
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function retraction(messageId: string, scene: Focus) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.deleted", {
      platform: "onebot",
      selfId: selfIdOf(scene),
      channelId: scene.channelId,
      messageId,
      operatorId: "42",
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function switched(previous: Focus, next: Focus) {
  return createEntry("ishiki.focus.changed", { previous, next, reason: "换个窗口" } satisfies IshikiEntry.FocusChanged);
}

function call(toolCallId: string, toolName: string) {
  return createEntry("message", createAssistantMessage([{ type: "tool-call", toolCallId, toolName, input: { channel: "group:9" } }]));
}

function result(toolCallId: string, toolName: string) {
  return createEntry("message", createToolMessage([{ type: "tool-result", toolCallId, toolName, output: { type: "text", value: "ok" } }]));
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return { ...makeProfile(), ...overrides };
}

describe("frame segments", () => {
  it("pins a trail to the scene the cursor was in when it ran", () => {
    const workspace = [fact("m1", ONE), switched(ONE, NINE), call("c1", "switch_focus"), result("c1", "switch_focus")];

    const segments = frameSegments(profile(), workspace, ONE);

    // The scene it left keeps the generation's own slice; the one it opened starts empty and takes what follows.
    expect(segments.map((segment) => segment.scene)).toEqual([ONE, NINE]);
    expect(segments[0].focus).toBe(true);
    expect(segments[0].lines).toEqual([`${CLOCK} Miaow(42) #m1: m1`]);
    expect(segments[1].focus).toBe(true);
    expect(segments[1].lines).toEqual(['[工具调用] switch_focus: {"channel":"group:9"}', "[工具结果] switch_focus: ok"]);
  });

  it("gives a scene one segment, a fact one line, and drops what never reaches the mind", () => {
    const workspace = [
      fact("m1", ONE),
      fact("a1", NINE, { direct: true }),
      fact("m2", ONE),
      retraction("m1", ONE),
      fact("a2", NINE, { direct: true }),
      fact("x1", NINE, { content: "够不着" }),
      own("m3", NINE),
    ];

    const segments = frameSegments(profile(), workspace, ONE);
    const byScene = new Map(segments.map((segment) => [segment.scene.channelId, segment]));

    expect(segments).toHaveLength(2);
    // One fact belongs to one scene, so nothing is ever printed twice inside a frame.
    expect(byScene.get("group:1")).toMatchObject({
      focus: true,
      lines: [`${CLOCK} Miaow(42) #m1: m1`, `${CLOCK} Miaow(42) #m2: m2`, `${CLOCK} #m1: (已撤回)`],
    });
    // A scene the generation only heard from is not one it worked in; the mind's own line reads back like any other.
    expect(byScene.get("group:9")).toMatchObject({
      focus: false,
      lines: [`${CLOCK} Miaow(42) #a1: a1`, `${CLOCK} Miaow(42) #a2: a2`, `${CLOCK} NekoChan(2) #m3: m3`],
    });
  });

  it("only extends the tail when the stream grows", () => {
    const workspace = [fact("m1", ONE), fact("a1", NINE, { direct: true }), fact("m2", ONE)];
    const before = frameSegments(profile(), workspace, ONE);

    const after = frameSegments(profile(), [...workspace, fact("m3", ONE)], ONE);

    expect(after[0].lines.slice(0, before[0].lines.length)).toEqual(before[0].lines);
    expect(after[1]).toEqual(before[1]);
  });
});

describe("scene reads", () => {
  it("reads one scene's facts in stream order, with retractions on demand", () => {
    const entries = [fact("m1", ONE), fact("a1", NINE), own("m2", ONE), retraction("m1", ONE), fact("m3", ONE)];

    // A frame reads a retraction back: it is something that happened in that scene.
    expect(factsOf(entries, ONE).map((read) => read.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} #m1: (已撤回)`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
    // `peek_channel` reads the conversation only.
    expect(factsOf(entries, ONE, { retractions: false }).map((read) => read.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
    expect(factsOf(entries, NINE).map((read) => read.line)).toEqual([`${CLOCK} Miaow(42) #a1: a1`]);
  });
});
