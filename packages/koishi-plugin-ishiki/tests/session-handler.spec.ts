import type { Session } from "koishi";
import { describe, expect, it } from "vitest";

import { StandardHandler } from "../src/session-handler.js";

/** 只喂 handler 真正读到的字段。 */
function session(overrides: Record<string, unknown> = {}): Session {
  return {
    type: "message-created",
    platform: "onebot",
    selfId: "bot",
    userId: "u1",
    channelId: "group:1",
    messageId: "m1",
    content: "在吗",
    timestamp: 1,
    author: { nick: "Neko", name: "neko" },
    ...overrides,
  } as unknown as Session;
}

const handler = new StandardHandler();

describe("StandardHandler: 私聊判定", () => {
  it("适配器填了 channel.type（session.isDirect 才算真）就用它", () => {
    expect(handler.handle(session({ isDirect: true, channelId: "whatever:1" }))?.data).toMatchObject({ isDirect: true });
  });

  it("适配器只给 private: 频道号时也认私聊", () => {
    // onebot 这类适配器不填 channel.type，`session.isDirect` 因此是 false，只看它就会把私聊当群聊。
    expect(handler.handle(session({ isDirect: false, channelId: "private:1293865264" }))?.data).toMatchObject({
      isDirect: true,
      channelId: "private:1293865264",
    });
  });

  it("群聊不算私聊", () => {
    expect(handler.handle(session({ isDirect: false, channelId: "group:9" }))?.data).toMatchObject({ isDirect: false });
  });

  it("非消息事件不产出事件", () => {
    expect(handler.handle(session({ type: "guild-added" }))).toBeUndefined();
  });
});
