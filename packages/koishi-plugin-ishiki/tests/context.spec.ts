import { createCustomMessage, createEntry } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import "../src/types.js";
import { assembleScene, formatClock, readSceneLines } from "../src/context-engine.js";
import { createRegistry } from "../src/registry.js";
import type { SceneAddress, SceneType } from "../src/types.js";

const ONE = { sid: "onebot:1", channelId: "group:1", platform: "onebot", sceneType: "group" as SceneType };
const NINE: SceneAddress = { sid: "onebot:2", channelId: "group:9" };
const AT = 1_700_000_000_000;
const CLOCK = `[${formatClock(AT)}]`;

const BODIES: Record<string, { platform: string; selfId: string }> = {
  "onebot:1": { platform: "onebot", selfId: "1" },
  "onebot:2": { platform: "onebot", selfId: "2" },
};

function bodyOf(scene: SceneAddress): { platform: string; selfId: string } {
  const body = BODIES[scene.sid];
  if (body === undefined) throw new Error(`unknown body ${scene.sid}`);
  return body;
}

function fact(messageId: string, scene: SceneAddress, options: { content?: string; sceneType?: SceneType } = {}) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.created", {
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      content: options.content ?? messageId,
      user: { id: "42", name: "Miaow" },
      sceneType: options.sceneType ?? "group",
      messageId,
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function own(messageId: string, scene: SceneAddress) {
  const { selfId } = bodyOf(scene);
  return createEntry(
    "message",
    createCustomMessage("ishiki.self.message", {
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      content: messageId,
      user: { id: selfId, name: "NekoChan" },
      sceneType: "group",
      messageId,
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

function retraction(messageId: string, scene: SceneAddress) {
  return createEntry(
    "message",
    createCustomMessage("ishiki.message.deleted", {
      ...bodyOf(scene),
      sid: scene.sid,
      channelId: scene.channelId,
      sceneType: "group",
      messageId,
      operatorId: "42",
      timestamp: AT,
    }),
    { timestamp: AT },
  );
}

const REGISTRY = createRegistry();

describe("scene reads", () => {
  it("reads one scene's rendered lines in stream order", async () => {
    const entries = [fact("m1", ONE), fact("a1", NINE), own("m2", ONE), retraction("m1", ONE), fact("m3", ONE)];

    const lines = await readSceneLines(REGISTRY.transforms, entries, ONE);

    expect(lines.map((line) => line.line)).toEqual([
      `${CLOCK} Miaow(42) #m1: m1`,
      `${CLOCK} NekoChan(1) #m2: m2`,
      `${CLOCK} #m1: (已撤回)`,
      `${CLOCK} Miaow(42) #m3: m3`,
    ]);
  });
});

describe("assembly", () => {
  it("keeps the last maxMessages facts and the tool trace after them", async () => {
    const entries = [fact("m1", ONE), fact("m2", ONE), fact("a1", NINE), fact("m3", ONE)];

    const assembled = await assembleScene(entries, ONE, REGISTRY.transforms, 2);
    const text = JSON.stringify(assembled);

    expect(text).not.toContain("#m1");
    expect(text).toContain("#m2");
    expect(text).toContain("#m3");
    expect(text).not.toContain("#a1");
  });

  it("skips a checkpoint left by an older log and still shows the fact after it", async () => {
    const checkpoint = createEntry(
      "message",
      createCustomMessage("ishiki.message.created", {
        ...bodyOf(ONE),
        sid: ONE.sid,
        channelId: ONE.channelId,
        content: "seed",
        user: { id: "42", name: "Miaow" },
        sceneType: "group",
        messageId: "seed",
        timestamp: AT,
      }),
    );
    const legacy = { ...checkpoint, type: "ishiki.checkpoint", data: { text: "<frame>SEEDED</frame>" } };
    const entries = [legacy as unknown as typeof checkpoint, fact("m1", ONE), own("m2", ONE)];

    const text = JSON.stringify(await assembleScene(entries, ONE, REGISTRY.transforms, 40));

    expect(text).not.toContain("SEEDED");
    expect(text).toContain("Miaow(42) #m1: m1");
    expect(text).toContain("NekoChan(1) #m2: m2");
  });
});
