import { createCustomMessage, createEntry } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import "../src/types.js";
import { ContextEngine, formatClock } from "../src/context-engine.js";
import type { Focus } from "../src/profiles.js";
import { makeProfile } from "./helpers.js";

const ONE: Focus = { sid: "onebot:1", channelId: "group:1" };
const NINE: Focus = { sid: "onebot:2", channelId: "group:9" };
/** One timestamp for the whole file, so no assertion below depends on the machine's time zone. */
const AT = 1_700_000_000_000;
const CLOCK = `[${formatClock(AT)}]`;

/** The bodies as the platform reports them, stated rather than derived: nothing splits a sid. */
const BODIES: Record<string, { platform: string; selfId: string }> = {
  "onebot:1": { platform: "onebot", selfId: "1" },
  "onebot:2": { platform: "onebot", selfId: "2" },
};

function bodyOf(scene: Focus): { platform: string; selfId: string } {
  const body = BODIES[scene.sid];
  if (body === undefined) throw new Error(`unknown body ${scene.sid}`);
  return body;
}

function fact(messageId: string, scene: Focus, options: { content?: string; direct?: boolean } = {}) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.created", {
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      content: options.content ?? messageId,
      user: { id: "42", name: "Miaow" },
      direct: options.direct,
      messageId,
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function own(messageId: string, scene: Focus) {
  const { selfId } = bodyOf(scene);
  return createEntry(
    "message",
    createCustomMessage("ishiki.self.message", {
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      content: messageId,
      user: { id: selfId, name: "NekoChan" },
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
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      messageId,
      operatorId: "42",
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

/** Reading lines depends on nothing but the stream, so the engine carries no profile of its own. */
const ENGINE = new ContextEngine({ profile: makeProfile(), currentFocus: () => ONE });

describe("scene reads", () => {
  it("reads one scene's rendered lines in stream order", () => {
    const entries = [fact("m1", ONE), fact("a1", NINE), own("m2", ONE), retraction("m1", ONE), fact("m3", ONE)];

    expect(ENGINE.lines(entries, ONE).map((read) => read.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} #m1: (已撤回)`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
    expect(ENGINE.lines(entries, NINE).map((read) => read.line)).toEqual([`${CLOCK} Miaow(42) #a1: a1`]);
  });
});
