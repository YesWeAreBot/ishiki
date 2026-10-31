import { createCustomMessage, type Agent, type AgentEvent } from "@yesimagent/core";
import { describe, expect, it, vi } from "vitest";

import type { IshikiMessageCreated } from "../src/types.js";
import { JevWakeupInstance } from "../src/wakeup/jev.engine.js";
import { decideJev, parseJevEvidence, type JevEvidence, type Participation } from "../src/wakeup/policy.js";

const config = {
  threshold: 0.7,
  addressedThreshold: 0.7,
  cooldownMs: 30000,
  minIntervalMs: 2000,
  conversationMs: 120000,
  participationWindowMs: 300000,
  maxParticipation: 0.25,
  minParticipationTurns: 6,
  maxConsecutiveReplies: 4,
};
function evidence(overrides: Partial<JevEvidence> = {}): JevEvidence {
  return {
    relation: { addressed: 0, followup: 0, open: 0, other: 0, ambient: 1 },
    worthwhile: 0,
    social: 0,
    closed: 0,
    withdrawn: 0,
    interested: 0,
    receptive: 0,
    ready: 1,
    ...overrides,
  };
}

describe("JEV wakeup lifecycle", () => {
  it("maps a selected author label to that author's latest message in a mixed batch", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const continueAgent = vi.fn<() => void>();
    const calls: unknown[] = [];
    const answers = {
      answers: {
        relation: { type: "choice", probabilities: { addressed: 0.95, followup: 0.01, open: 0.01, other: 0.01, ambient: 0.02 } },
        ready: { type: "boolean", probability: 0.99 },
        receptive: { type: "boolean", probability: 0.99 },
        worthwhile: { type: "boolean", probability: 0.2 },
        social: { type: "boolean", probability: 0.8 },
        withdrawn: { type: "boolean", probability: 0.01 },
        closed: { type: "boolean", probability: 0.01 },
        interested: { type: "boolean", probability: 0.1 },
      },
    };
    const agent = {
      isIdle: () => true,
      wait: async () => {},
      continue: continueAgent,
      storage: { read: () => [] },
      channel: {
        subscribe: (_name: "agent", listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as Agent;
    const context = {
      logger: { debug: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() },
      fiber: {
        ishiki: {
          gateway: {
            decisionModel: () => ({
              supportedQuestionTypes: ["boolean", "choice"],
              doDecide: async ({ state, questions }: { state: Array<{ value: unknown }>; questions: Record<string, unknown> }) => {
                calls.push({ state: state[0]?.value, questions });
                if ("focus" in questions) return { answers: { focus: { type: "choice", probabilities: { none: 0.05, author_0: 0.05, author_1: 0.9 } } } };
                return answers;
              },
            }),
          },
        },
      },
    };
    const engine = new JevWakeupInstance(
      {
        model: "decision",
        debounceMs: 20,
        maxWaitMs: 50,
        minIntervalMs: 0,
        botNames: ["小助手"],
        instruction: "额外指引：只在能自然接话时加入",
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      context as never,
    );
    const dispose = engine.attach(agent);
    const emit = (id: string, author: string) => {
      const message: IshikiMessageCreated = {
        timestamp: Date.now(),
        platform: "test",
        selfId: "bot",
        channelId: "room",
        messageId: id,
        content: id === "selected" ? '<at id="bot"/>' : id,
        quote: id === "selected" ? { id: "bot-message", user: { id: "bot" }, content: "hello" } : undefined,
        isDirect: false,
        user: { id: author },
      };
      for (const listener of listeners) listener({ type: "message.appended", message: createCustomMessage("ishiki.message.created", message) });
    };
    emit("first", "author-a");
    emit("selected", "author-b");
    await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      state: {
        pending_message: { id: "selected", author_id: "author-b", mentions_bot: true, quote: { author_id: "bot" } },
        bot: { names: ["小助手"], instruction: "额外指引：只在能自然接话时加入" },
      },
    });
    expect(calls[1]).toMatchObject({
      state: {
        pending_messages: [
          { id: "first", author_id: "author-a", mentions_bot: false },
          { id: "selected", author_id: "author-b", mentions_bot: true, quote: { author_id: "bot" } },
        ],
      },
    });
    dispose();
  });

  it("applies channel styles to the model, policy and trace without changing directed replies", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const states: Array<{ bot: { style: string }; pending_message: { text: string } }> = [];
    const records: Array<{ mode: string; config?: { style: string }; threshold: number; focused: string }> = [];
    const agent = {
      isIdle: () => true,
      wait: async () => {},
      continue: vi.fn<() => void>(),
      storage: { read: () => [] },
      channel: {
        subscribe: (_name: "agent", listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as Agent;
    const context = {
      runtimeId: "styles",
      logger: { debug: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() },
      fiber: {
        ishiki: {
          jevTrace: { record: (record: (typeof records)[number]) => records.push(record) },
          gateway: {
            decisionModel: () => ({
              supportedQuestionTypes: ["boolean", "choice"],
              doDecide: async ({ state }: { state: Array<{ value: (typeof states)[number] }> }) => {
                const input = state[0]!.value;
                states.push(input);
                const directed = input.pending_message.text.includes("<at");
                const contribution = input.pending_message.text.includes("low") ? 0.53 : 0.6;
                return {
                  answers: {
                    relation: {
                      type: "choice",
                      probabilities: directed
                        ? { addressed: 0.95, followup: 0.01, open: 0.01, other: 0.01, ambient: 0.02 }
                        : { addressed: 0, followup: 0, open: 0, other: 0, ambient: 1 },
                    },
                    ready: { type: "boolean", probability: 0.95 },
                    receptive: { type: "boolean", probability: contribution },
                    worthwhile: { type: "boolean", probability: 0.1 },
                    social: { type: "boolean", probability: contribution },
                    withdrawn: { type: "boolean", probability: 0 },
                    closed: { type: "boolean", probability: 0 },
                    interested: { type: "boolean", probability: 0 },
                  },
                };
              },
            }),
          },
        },
      },
    };
    const engine = new JevWakeupInstance(
      {
        model: "decision",
        debounceMs: 0,
        maxWaitMs: 0,
        cooldownMs: 0,
        globalCooldownMs: 0,
        minIntervalMs: 0,
        maxParticipation: 1,
        channelStyles: { "test:bot/quiet": "quiet", "test:bot/talkative": "talkative" },
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      context as never,
    );
    const dispose = engine.attach(agent);
    const emit = async (channelId: string, content: string) => {
      const message: IshikiMessageCreated = {
        timestamp: Date.now(),
        platform: "test",
        selfId: "bot",
        channelId,
        messageId: `${channelId}-${content}`,
        content,
        isDirect: false,
        user: { id: "member" },
      };
      for (const listener of listeners) listener({ type: "message.appended", message: createCustomMessage("ishiki.message.created", message) });
      await vi.waitFor(() => expect(records.some((record) => record.focused === content)).toBe(true));
      return records.find((record) => record.focused === content)!;
    };
    try {
      const quiet = await emit("quiet", "borderline quiet");
      expect(quiet).toMatchObject({ mode: "wait", config: { style: "quiet" } });
      expect(quiet.threshold).toBeCloseTo(0.8);
      const natural = await emit("natural", "borderline natural");
      expect(natural).toMatchObject({ mode: "join", config: { style: "natural" } });
      expect(natural.threshold).toBeCloseTo(0.7);
      expect(await emit("natural", "low natural")).toMatchObject({ mode: "wait", config: { style: "natural" } });
      const talkative = await emit("talkative", "low talkative");
      expect(talkative).toMatchObject({ mode: "join", config: { style: "talkative" } });
      expect(talkative.threshold).toBeCloseTo(0.55);
      expect(await emit("quiet", '<at id="bot"/> quiet directed')).toMatchObject({ mode: "reply", config: { style: "quiet" } });
      expect(states.map((input) => input.bot.style)).toEqual(["quiet", "natural", "natural", "talkative", "quiet"]);
    } finally {
      dispose();
    }
  });

  it("skips the model call for a repeated message but still evaluates a mention", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const calls: unknown[] = [];
    const agent = {
      isIdle: () => true,
      wait: async () => {},
      continue: vi.fn<() => void>(),
      storage: { read: () => [] },
      channel: {
        subscribe: (_name: "agent", listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as Agent;
    const context = {
      logger: { debug: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() },
      fiber: {
        ishiki: {
          gateway: {
            decisionModel: () => ({
              supportedQuestionTypes: ["boolean", "choice"],
              doDecide: async ({ state }: { state: Array<{ value: unknown }> }) => {
                calls.push(state[0]?.value);
                return {
                  answers: {
                    relation: { type: "choice", probabilities: { addressed: 0, followup: 0, open: 0, other: 0, ambient: 1 } },
                    ready: { type: "boolean", probability: 0.9 },
                    receptive: { type: "boolean", probability: 0.3 },
                    worthwhile: { type: "boolean", probability: 0.2 },
                    social: { type: "boolean", probability: 0.2 },
                    withdrawn: { type: "boolean", probability: 0 },
                    closed: { type: "boolean", probability: 0 },
                    interested: { type: "boolean", probability: 0 },
                  },
                };
              },
            }),
          },
        },
      },
    };
    const engine = new JevWakeupInstance(
      { model: "decision", debounceMs: 0, maxWaitMs: 0, minIntervalMs: 0, rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
      context as never,
    );
    const dispose = engine.attach(agent);
    const emit = (id: string, content: string) => {
      const message: IshikiMessageCreated = {
        timestamp: Date.now(),
        platform: "test",
        selfId: "bot",
        channelId: "room",
        messageId: id,
        content,
        isDirect: false,
        user: { id: "member", name: "Member" },
      };
      for (const listener of listeners) listener({ type: "message.appended", message: createCustomMessage("ishiki.message.created", message) });
    };

    emit("first", "same text");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ bot: { instruction: "" } });
    emit("repeat", "same text");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(1);

    emit("mention", '<at id="bot"/>');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    emit("mention-again", '<at id="bot"/>');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    dispose();
  });

  it("keeps a follow-up directed after a delivered bot reply receipt", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const continueAgent = vi.fn<() => void>();
    const debug = vi.fn<(message: string) => void>();
    const agent = {
      isIdle: () => true,
      wait: async () => {},
      continue: continueAgent,
      storage: { read: () => [] },
      channel: {
        subscribe: (_name: "agent", listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as Agent;
    const context = {
      logger: { debug, warn: vi.fn<(message: string) => void>() },
      fiber: {
        ishiki: {
          gateway: {
            decisionModel: () => ({
              supportedQuestionTypes: ["boolean", "choice"],
              doDecide: async () => ({
                answers: {
                  relation: { type: "choice", probabilities: { addressed: 0.3, followup: 0.7, open: 0, other: 0, ambient: 0 } },
                  ready: { type: "boolean", probability: 0.97 },
                  receptive: { type: "boolean", probability: 0.8 },
                  worthwhile: { type: "boolean", probability: 0.65 },
                  social: { type: "boolean", probability: 0.63 },
                  withdrawn: { type: "boolean", probability: 0.02 },
                  closed: { type: "boolean", probability: 0.03 },
                  interested: { type: "boolean", probability: 0.04 },
                },
              }),
            }),
          },
        },
      },
    };
    const engine = new JevWakeupInstance(
      {
        model: "decision",
        debounceMs: 0,
        maxWaitMs: 0,
        minIntervalMs: 0,
        conversationMs: 120_000,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      context as never,
    );
    const dispose = engine.attach(agent);
    const emit = (message: unknown) => {
      for (const listener of listeners) listener({ type: "message.appended", message: message as never });
    };
    const emitMessage = (id: string) => {
      const message: IshikiMessageCreated = {
        timestamp: Date.now(),
        platform: "test",
        selfId: "bot",
        channelId: "room",
        messageId: id,
        content: id,
        isDirect: false,
        user: { id: "member", name: "Member" },
      };
      emit(createCustomMessage("ishiki.message.created", message));
    };
    const logged = (text: string) => debug.mock.calls.some(([line]) => line.includes(text));

    emitMessage("ask");
    await vi.waitFor(() => expect(logged("wait expired-conversation")).toBe(true));

    emit({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "send_message",
          input: { messages: ["在的"], target: { sid: "test:bot", channelId: "room" } },
        },
      ],
    });
    emit({
      role: "tool",
      timestamp: Date.now(),
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "send_message", output: { ok: true, ids: ["1"] } }],
    });

    emitMessage("follow-up");
    await vi.waitFor(() => expect(logged("reply followup")).toBe(true));
    expect(continueAgent).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("re-evaluates a message received during a busy turn after the agent becomes idle", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    let idle = false;
    let releaseWait!: () => void;
    let requestedState: unknown;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const continueAgent = vi.fn<() => void>();
    const agent = {
      isIdle: () => idle,
      wait: () => waitGate,
      continue: continueAgent,
      storage: { read: () => [] },
      channel: {
        subscribe: (_name: "agent", listener: (event: AgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as Agent;
    const answers = {
      answers: {
        relation: { type: "choice", probabilities: { addressed: 0.95, followup: 0.01, open: 0.01, other: 0.01, ambient: 0.02 } },
        ready: { type: "boolean", probability: 0.99 },
        receptive: { type: "boolean", probability: 0.99 },
        worthwhile: { type: "boolean", probability: 0.2 },
        social: { type: "boolean", probability: 0.8 },
        withdrawn: { type: "boolean", probability: 0.01 },
        closed: { type: "boolean", probability: 0.01 },
        interested: { type: "boolean", probability: 0.1 },
      },
    };
    const context = {
      logger: { debug: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() },
      fiber: {
        ishiki: {
          gateway: {
            decisionModel: () => ({
              supportedQuestionTypes: ["boolean", "choice"],
              doDecide: async ({ state }: { state: Array<{ type: string; value: unknown }> }) => {
                requestedState = state[0]?.value;
                return answers;
              },
            }),
          },
        },
      },
    };
    const engine = new JevWakeupInstance(
      { model: "decision", debounceMs: 0, maxWaitMs: 0, minIntervalMs: 0, rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
      context as never,
    );
    const dispose = engine.attach(agent);
    const message: IshikiMessageCreated = {
      timestamp: Date.now(),
      platform: "test",
      selfId: "bot",
      channelId: "room",
      messageId: "busy-1",
      content: "a complete question?",
      isDirect: false,
      user: { id: "member", name: "Member" },
    };
    for (const listener of listeners)
      listener({
        type: "message.appended",
        message: createCustomMessage("ishiki.message.created", message),
      });
    expect(continueAgent).not.toHaveBeenCalled();
    expect(requestedState).toBeUndefined();

    for (const listener of listeners) listener({ type: "turn.done", turnId: "turn-1" });
    idle = true;
    releaseWait();
    await vi.waitFor(() => expect(continueAgent).toHaveBeenCalledTimes(1));
    expect(requestedState).toMatchObject({ pending_message: { id: "busy-1" } });
    dispose();
  });
});

describe("JEV policy", () => {
  it("allows a fitting direct social response without informational value", () => {
    const result = decideJev(
      evidence({ relation: { addressed: 0.9, followup: 0, open: 0, other: 0, ambient: 0.1 }, social: 0.1 }),
      { activity: [] },
      config,
      100000,
    );
    expect(result.mode).toBe("reply");
  });
  it("does not treat interest as a contribution or group opening", () => {
    const result = decideJev(evidence({ interested: 1, receptive: 1 }), { activity: [] }, config, 100000);
    expect(result.mode).toBe("wait");
    expect(result.reason).toBe("no-contribution");
  });
  it("keeps a public two-person exchange eligible when it is receptive", () => {
    const result = decideJev(
      evidence({ worthwhile: 0.8, receptive: 0.9, relation: { addressed: 0, followup: 0, open: 0, other: 0.1, ambient: 0.9 } }),
      {
        activity: [
          { at: 99000, author: "a", self: false },
          { at: 99500, author: "b", self: false },
        ],
      },
      config,
      100000,
    );
    expect(result.mode).toBe("join");
  });
  it("allows moderately positive openings while preserving evidence and safety floors", () => {
    const moderate = evidence({
      relation: { addressed: 0.02, followup: 0.02, open: 0.02, other: 0.04, ambient: 0.9 },
      worthwhile: 0.56,
      receptive: 0.56,
    });
    expect(decideJev(moderate, { activity: [] }, config, 100000)).toMatchObject({ mode: "join", reason: "relevant-contribution" });
    expect(decideJev({ ...moderate, receptive: 0.51 }, { activity: [] }, config, 100000)).toMatchObject({ mode: "wait", reason: "no-opening" });
    expect(decideJev({ ...moderate, worthwhile: 0.51 }, { activity: [] }, config, 100000)).toMatchObject({ mode: "wait", reason: "weak-contribution" });
    expect(decideJev({ ...moderate, withdrawn: 0.9 }, { activity: [] }, config, 100000)).toMatchObject({ mode: "wait", reason: "withdrawn" });
  });
  it("withdraws only on explicit focus-author evidence", () => {
    const result = decideJev(
      evidence({ relation: { addressed: 1, followup: 0, open: 0, other: 0, ambient: 0 }, withdrawn: 0.9 }),
      { activity: [] },
      config,
      100000,
    );
    expect(result).toMatchObject({ mode: "wait", reason: "withdrawn" });
  });
  it("does not treat a group invitation alone as contribution", () => {
    const result = decideJev(
      evidence({ relation: { addressed: 0, followup: 0, open: 0.9, other: 0, ambient: 0.1 }, receptive: 0.9 }),
      { activity: [] },
      config,
      100000,
    );
    expect(result).toMatchObject({ mode: "wait", reason: "no-contribution" });
  });
  it("requires enough actual participants before applying the participation cap", () => {
    const activity: Participation[] = Array.from({ length: 8 }, (_, index) => ({ at: 99000 + index, author: "member-" + index, self: false }));
    activity.push({ at: 99999, author: "bot", self: true, proactive: true });
    const result = decideJev(evidence({ worthwhile: 0.9, receptive: 0.9 }), { activity }, config, 100000);
    expect(result.mode).toBe("join");
  });
  it("enforces the unsolicited participation cap after enough group turns", () => {
    const activity: Participation[] = Array.from({ length: 8 }, (_, index) => ({ at: 99000 + index, author: "member-" + index, self: false, natural: true }));
    activity.push(
      { at: 99997, author: "bot", self: true, proactive: true, natural: false },
      { at: 99998, author: "bot", self: true, proactive: true, natural: false },
      { at: 99999, author: "bot", self: true, proactive: true, natural: false },
    );
    const result = decideJev(evidence({ worthwhile: 0.9, receptive: 0.9 }), { activity }, config, 100000);
    expect(result).toMatchObject({ mode: "wait", reason: "participation-limit" });
  });
  it("requires information when a direct conversation reaches its reply budget", () => {
    const result = decideJev(
      evidence({ relation: { addressed: 1, followup: 0, open: 0, other: 0, ambient: 0 }, social: 0.9 }),
      { activity: [], lastSpokeAt: 99000, lastConversationAt: 99000, consecutiveReplies: 4 },
      config,
      100000,
    );
    expect(result).toMatchObject({ mode: "wait", reason: "conversation-budget" });
  });
  it("rejects incomplete gateway probabilities rather than inventing confidence", () => {
    expect(parseJevEvidence({ answers: { relation: { type: "choice", probabilities: { addressed: 1 } } } })).toBeUndefined();
    expect(
      parseJevEvidence({
        answers: {
          relation: { type: "choice", probabilities: { addressed: 0.2, followup: 0.2, open: 0.2, other: 0.2, ambient: 0.2 } },
          ready: { type: "boolean", probability: 0.5 },
        },
      }),
    ).toBeUndefined();
  });
});
