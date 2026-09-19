import { createCustomMessage, createEntry } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import "../src/types.js";
import type { Focus } from "../src/profiles.js";
import { collectFacts, formatClock } from "../src/scene.js";

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

describe("scene reads", () => {
  it("reads one scene's facts in stream order, with retractions on demand", () => {
    const entries = [fact("m1", ONE), fact("a1", NINE), own("m2", ONE), retraction("m1", ONE), fact("m3", ONE)];

    // A frame reads a retraction back: it is something that happened in that scene.
    expect(collectFacts(entries, ONE).map((read) => read.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} #m1: (已撤回)`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
    // `peek_channel` reads the conversation only.
    expect(collectFacts(entries, ONE, { retractions: false }).map((read) => read.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
    expect(collectFacts(entries, NINE).map((read) => read.line)).toEqual([`${CLOCK} Miaow(42) #a1: a1`]);
  });
});
