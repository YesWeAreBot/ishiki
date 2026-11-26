import type { Context, Session } from "koishi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pluginConfig, profileConfig, resolvePolicy } from "../src/config.js";
import { Confirmations } from "../src/confirm.js";

describe("configuration precedence", () => {
  it("can tighten the plugin allowlist and require additional confirmation without granting a new command", () => {
    const policy = resolvePolicy(
      { ...pluginConfig(), allow: ["weather", "draw", "roll"], confirm: ["stamp"], deny: ["system"] },
      { ...profileConfig(), restrictCommands: true, only: ["draw", "stamp", "new"], confirm: ["draw", "new"], deny: ["faq"] },
    );
    expect(policy.allow).toEqual(["draw", "stamp"]);
    expect(policy.effects).toEqual(expect.arrayContaining(["draw", "stamp"]));
    expect(policy.deny).toEqual(expect.arrayContaining(["system", "faq"]));
    expect(resolvePolicy({ ...pluginConfig(), allow: ["draw"] }, { ...profileConfig(), restrictCommands: true }).allow).toEqual([]);
  });

  it.each([
    [1, 2, 1],
    [2, 1, 1],
    [2, 2, 2],
  ] as const)("caps %i plugin calls at a profile limit of %i", (global, local, effective) => {
    const plugin = { ...pluginConfig(), maxCallsPerTurn: global };
    const profile = { ...profileConfig(), maxCallsPerTurn: local };
    expect(resolvePolicy(plugin, profile).maxCallsPerTurn).toBe(effective);
  });

  it("discovers by default with no delegated commands and a single allowed dispatch per turn", () => {
    expect(resolvePolicy(pluginConfig(), profileConfig())).toMatchObject({ allow: [], effects: [], deny: [], maxCallsPerTurn: 1 });
  });
});

type Incoming = (session: Session, next: () => Promise<string>) => Promise<unknown>;
const pass = async () => "unhandled";

function confirmationFixture() {
  let receive!: Incoming;
  let recalled!: (session: Session) => void;
  const sent: string[] = [];
  const source = {
    platform: "onebot",
    selfId: "100",
    userId: "alice",
    guildId: "guild",
    channelId: "chat",
    messageId: "source",
    type: "message-created",
    event: { user: { id: "alice" } },
    send: async (content: unknown) => {
      sent.push(String(content));
      return ["out-1"];
    },
  } as unknown as Session;
  const confirmations = new Confirmations({
    middleware(handler: Incoming) {
      receive = handler;
    },
    on(name: string, handler: (session: Session) => void) {
      if (name === "internal/session") recalled = handler;
    },
  } as Context);
  function response(overrides: Partial<Session> = {}) {
    const token = sent.at(-1)?.match(/确认执行 [a-f0-9]{16}$/u)?.[0];
    expect(token).toBeTruthy();
    return receive({ ...source, content: token, messageId: "confirmation", ...overrides } as Session, pass);
  }
  return {
    source,
    response,
    recall: (overrides: Partial<Session> = {}) => recalled({ ...source, type: "message-deleted", ...overrides } as Session),
    request: (perform: () => Promise<void>) => confirmations.request(source, "stamp", [], perform),
  };
}

describe("account-bound confirmation", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("accepts a matching reply just before expiry and rejects it at expiry even if the cleanup timer hasn't fired", async () => {
    const fixture = confirmationFixture();
    const perform = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await fixture.request(perform);
    await vi.advanceTimersByTimeAsync(59_999);
    await fixture.response();
    expect(perform).toHaveBeenCalledTimes(1);

    await fixture.request(perform);
    vi.setSystemTime(start.getTime() + 119_999);
    expect(await fixture.response()).toBe("确认已过期。");
    expect(perform).toHaveBeenCalledTimes(1);

    await fixture.request(perform);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await fixture.response()).toBe("unhandled");
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("removes a withdrawn original message, while ignoring unrelated withdrawal events", async () => {
    const fixture = confirmationFixture();
    const perform = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await fixture.request(perform);
    fixture.recall({ platform: "elsewhere" });
    fixture.recall({ selfId: "other-bot" });
    fixture.recall({ channelId: "other-room" });
    fixture.recall({ messageId: "other-message" });
    await fixture.response();
    expect(perform).toHaveBeenCalledTimes(1);

    await fixture.request(perform);
    fixture.recall();
    expect(await fixture.response()).toBe("unhandled");
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("rejects a different actor, platform, bot, channel, guild or original message id without consuming the legitimate reply", async () => {
    const fixture = confirmationFixture();
    const perform = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await fixture.request(perform);
    for (const change of [
      { userId: "bob" },
      { platform: "other" },
      { selfId: "101" },
      { channelId: "another" },
      { guildId: "elsewhere" },
      { messageId: "source" },
      { messageId: "" },
      { type: "message-deleted" },
      { event: { user: { isBot: true } } },
    ])
      expect(await fixture.response(change as Partial<Session>)).toBe("unhandled");
    expect(perform).not.toHaveBeenCalled();
    await fixture.response();
    expect(perform).toHaveBeenCalledOnce();
  });

  it("redeems before dispatch so a concurrent repeat, a retry after failure and a later replay cannot run twice", async () => {
    const fixture = confirmationFixture();
    const finish = Promise.withResolvers<void>();
    const perform = vi.fn<() => Promise<void>>(() => finish.promise);
    await fixture.request(perform);
    const first = fixture.response();
    expect(perform).toHaveBeenCalledOnce();
    expect(await fixture.response({ messageId: "concurrent" })).toBe("unhandled");
    finish.reject(new Error("dispatch result uncertain"));
    expect(await first).toMatch(/未能确认/);
    expect(await fixture.response({ messageId: "retry" })).toBe("unhandled");
    expect(perform).toHaveBeenCalledOnce();
  });
});
