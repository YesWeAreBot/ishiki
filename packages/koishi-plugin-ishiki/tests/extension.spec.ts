import { afterEach, describe, expect, it } from "vitest";

import "../src/types.js";
import { textPart } from "../src/context-engine.js";
import type { Receptor } from "../src/extension.js";
import { createRegistry } from "../src/registry.js";
import { cleanup, createHarness, promptText, textStep } from "./helpers.js";

afterEach(async () => {
  await cleanup();
});

/** The address every fact carries, as the built-in receptor reads it out of a session. */
function sceneFields(session: { sid: string; platform: string; selfId: string; channelId?: string; timestamp: number; isDirect?: boolean; guildId?: string }) {
  return {
    timestamp: session.timestamp,
    sid: session.sid,
    platform: session.platform,
    selfId: session.selfId,
    channelId: session.channelId!,
    sceneType: session.isDirect === true ? ("direct" as const) : session.guildId ? ("guild" as const) : ("group" as const),
  };
}

describe("bodies", () => {
  it("lets a host receptor speak before the built-in one", async () => {
    const registry = createRegistry();
    registry.registerReceptor({
      platform: "onebot",
      priority: 0,
      receive: (session) =>
        session.type === "message-created"
          ? {
              role: "custom",
              type: "ishiki.message.created",
              id: "rewritten",
              timestamp: session.timestamp,
              data: { ...sceneFields(session), content: `改写过：${session.content}`, user: { id: session.userId! }, messageId: session.messageId! },
            }
          : undefined,
    } satisfies Receptor as Receptor);

    const harness = await createHarness([textStep("nothing")], { registry });
    await harness.send();

    expect(promptText(harness.prompts(), 0)).toContain("改写过：hello");
  });
});

describe("projection", () => {
  it("renders a host's own event type once a transform is registered for it", async () => {
    const registry = createRegistry();
    registry.registerTransform("test.notice", (data: { text: string }) => [textPart(`<notice>${data.text}</notice>`)]);
    const seeded = JSON.stringify({
      id: "n1",
      type: "message",
      timestamp: Date.now(),
      data: {
        id: "n1",
        timestamp: Date.now(),
        role: "custom",
        type: "test.notice",
        data: { ...sceneFields({ sid: "onebot:1", platform: "onebot", selfId: "1", channelId: "group:1", timestamp: Date.now() }), text: "外部事件" },
      },
    });

    const harness = await createHarness([textStep("nothing")], { registry, seed: [seeded] });
    await harness.send();

    expect(promptText(harness.prompts(), 0)).toContain("<notice>外部事件</notice>");
  });

  it("keeps an event type nobody renders invisible", async () => {
    const seeded = JSON.stringify({
      id: "n1",
      type: "message",
      timestamp: Date.now(),
      data: {
        id: "n1",
        timestamp: Date.now(),
        role: "custom",
        type: "test.unknown",
        data: { ...sceneFields({ sid: "onebot:1", platform: "onebot", selfId: "1", channelId: "group:1", timestamp: Date.now() }), text: "看不见" },
      },
    });

    const harness = await createHarness([textStep("nothing")], { seed: [seeded] });
    await harness.send();

    expect(promptText(harness.prompts(), 0)).not.toContain("看不见");
  });
});
