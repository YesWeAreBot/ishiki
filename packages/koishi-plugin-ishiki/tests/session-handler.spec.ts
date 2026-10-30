import { describe, expect, it } from "vitest";

import { collapse } from "../src/context/render.js";
import { StandardHandler } from "../src/session-handler.js";
import { startApp } from "./harness.js";

describe("session handler", () => {
  it("renders the user's name when the session has no nick", async () => {
    const setup = await startApp();
    try {
      const session = setup.session("20001", "room1", "你好");
      session.event.user = { id: "20001", name: "小明" };

      const event = new StandardHandler().handle(session);
      if (event === undefined) throw new Error("handler returned no event");
      const message = collapse([event])[0];
      if (message?.role !== "user") throw new Error("expected a user message");

      expect(message.content).toContain("小明(20001)");
    } finally {
      await setup.stop();
    }
  });
});
