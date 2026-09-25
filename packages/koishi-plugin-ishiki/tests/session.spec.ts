import { describe, expect, it } from "vitest";

import "../src/types.js";
import { DefaultReceptor } from "../src/session-handler.js";
import { makeSession } from "./helpers.js";

const BODY = new DefaultReceptor();

describe("scene classification", () => {
  it("reads the scene type the platform described", () => {
    expect(BODY.receive(makeSession({ isDirect: true }))?.data.sceneType).toBe("direct");
    expect(BODY.receive(makeSession({ isDirect: false, guildId: "g9" }))?.data.sceneType).toBe("guild");
    expect(BODY.receive(makeSession({ isDirect: false, guildId: undefined }))?.data.sceneType).toBe("group");
  });
});

describe("claims", () => {
  it("yields nothing for a session no rule claims", () => {
    expect(BODY.receive(makeSession({ type: "message-updated" }))).toBeUndefined();
    expect(BODY.receive(makeSession({ type: "message-deleted", messageId: undefined }))).toBeUndefined();
  });

  it("carries the address on a retraction", () => {
    const event = BODY.receive(makeSession({ type: "message-deleted", messageId: "m9" }));

    expect(event?.type).toBe("ishiki.message.deleted");
    expect(event?.data.sid).toBe("onebot:1");
    expect(event?.data.channelId).toBe("group:1");
  });
});
