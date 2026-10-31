import { createCustomMessage, type Agent, type AgentEvent, type Experimental_DecisionModelV4Result as DecisionModelResult } from "@yesimagent/core";
import { describe, expect, it, vi } from "vitest";

import type { IshikiMessageCreated } from "../src/types.js";
import {
  clipJevText,
  decideJev,
  isDirectedJev,
  jevParticipationThreshold,
  JEV_QUESTIONS,
  JevFrequencyLedger,
  JevWakeupConfig,
  JevWakeupInstance,
  parseJevChoice,
  parseJevEvidence,
  prefilterJev,
  projectJevLine,
  selectJevContext,
  type JevContextLine,
  type JevEvidence,
  type JevPolicyConfig,
  type Participation,
} from "../src/wakeup/jev.engine.js";

const policy: JevPolicyConfig = {
  threshold: 0.7,
  addressedThreshold: 0.7,
  cooldownMs: 30000,
  globalCooldownMs: 60000,
  minIntervalMs: 2000,
  conversationMs: 120000,
  participationWindowMs: 300000,
  maxParticipation: 0.25,
  minParticipationTurns: 6,
  maxConsecutiveReplies: 4,
};

function evidence(overrides: Partial<JevEvidence> = {}): JevEvidence {
  return {
    relation: { addressed: 0.9, followup: 0.025, open: 0.025, other: 0.025, ambient: 0.025 },
    worthwhile: 0.85,
    social: 0.4,
    closed: 0.02,
    withdrawn: 0.02,
    interested: 0.8,
    receptive: 0.9,
    ready: 0.95,
    ...overrides,
  };
}

function ambientEvidence(overrides: Partial<JevEvidence> = {}): JevEvidence {
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

function typedResult(value: JevEvidence): DecisionModelResult {
  return {
    answers: {
      relation: { type: "choice", choice: "addressed", probabilities: value.relation },
      ready: { type: "boolean", probability: value.ready },
      receptive: { type: "boolean", probability: value.receptive },
      worthwhile: { type: "boolean", probability: value.worthwhile },
      social: { type: "boolean", probability: value.social },
      withdrawn: { type: "boolean", probability: value.withdrawn },
      closed: { type: "boolean", probability: value.closed },
      interested: { type: "boolean", probability: value.interested },
    },
    warnings: [],
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

  it("lets a direct message reach the model when proactive participation is disabled", async () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const calls: Array<{ scene: { type: string } }> = [];
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
              doDecide: async ({ state }: { state: Array<{ value: { scene: { type: string } } }> }) => {
                calls.push(state[0]!.value);
                return typedResult(evidence());
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
        minIntervalMs: 0,
        maxParticipation: 0,
        rules: { direct: false, atSelf: false, quoteSelf: false, keywords: [] },
      },
      context as never,
    );
    const dispose = engine.attach(agent);
    const message: IshikiMessageCreated = {
      timestamp: Date.now(),
      platform: "test",
      selfId: "bot",
      channelId: "dm",
      messageId: "direct",
      content: "hello",
      isDirect: true,
      user: { id: "member" },
    };
    for (const listener of listeners) listener({ type: "message.appended", message: createCustomMessage("ishiki.message.created", message) });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.scene.type).toBe("direct");
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

describe("JEV configuration", () => {
  it("materializes the JEV interval and rule defaults", () => {
    expect(JevWakeupConfig({ model: "decision" })).toMatchObject({
      minIntervalMs: 2000,
      rules: { quoteSelf: false },
    });
  });
});

describe("JEV decision evidence", () => {
  it("selects a unique highest-probability focus and rejects ties", () => {
    expect(
      parseJevChoice({ answers: { focus: { type: "choice", probabilities: { none: 0.1, author_0: 0.2, author_1: 0.7 } } } }, "focus", [
        "none",
        "author_0",
        "author_1",
      ]),
    ).toBe("author_1");
    expect(
      parseJevChoice({ answers: { focus: { type: "choice", probabilities: { none: 0.1, author_0: 0.45, author_1: 0.45 } } } }, "focus", [
        "none",
        "author_0",
        "author_1",
      ]),
    ).toBeUndefined();
  });

  it("uses typed boolean answers and rejects the old raw noul payload", () => {
    expect(parseJevEvidence(typedResult(evidence()))).toEqual(evidence());
    expect(
      parseJevEvidence({
        answers: {
          relation: { probabilities: evidence().relation },
          ready: { noul: 0.8 },
        },
      }),
    ).toBeUndefined();
  });

  it("rejects refusal and malformed relation distributions", () => {
    const refused = typedResult(evidence());
    refused.answers.relation = { type: "refusal" };
    expect(parseJevEvidence(refused)).toBeUndefined();

    const malformed = typedResult(evidence());
    malformed.answers.relation = {
      type: "choice",
      choice: "addressed",
      probabilities: { addressed: 0.9, followup: 0.9, open: 0.9, other: 0.9, ambient: 0.9 },
    };
    expect(parseJevEvidence(malformed)).toBeUndefined();
  });

  it("exposes only typed decision questions", () => {
    expect(JEV_QUESTIONS.relation.type).toBe("choice");
    expect(JEV_QUESTIONS.ready.type).toBe("boolean");
    expect(JEV_QUESTIONS.ready.criteria.true).toContain("emoji");
    expect(JEV_QUESTIONS.ready.instructions).toContain("brevity alone does not mean unfinished");
    expect(JEV_QUESTIONS.ready.criteria.true).toContain("natural stopping point");
    expect(JEV_QUESTIONS.receptive.instructions).toContain("this bot");
    expect(JEV_QUESTIONS.relation.criteria.open).toContain("concrete opening");
    expect(JEV_QUESTIONS.social.instructions).toContain("specific, concise social response");
    expect(JEV_QUESTIONS.relation.instructions).toContain("mentions_bot=true");
    expect(JEV_QUESTIONS.relation.instructions).toContain("quote.author_id matching bot.id");
    expect(JEV_QUESTIONS.relation.criteria.addressed).toContain("discussing the bot in third person");
    expect(JEV_QUESTIONS.relation.criteria.addressed).toContain("without a literal second-person pronoun");
    expect(JEV_QUESTIONS.relation.criteria.open).toContain("meaningful +1");
    expect(JEV_QUESTIONS.relation.criteria.followup).toContain("Continuation between other group members is not followup to the bot");
    expect(JEV_QUESTIONS.social.criteria.true).toContain("genuine solidarity");
    expect(JEV_QUESTIONS.social.criteria.false).toContain("reflexive +1");
    expect(JEV_QUESTIONS.social.criteria.false).toContain("echoing a reply already given");
    expect(JEV_QUESTIONS.social.criteria.false).toContain("without context");
    expect(Object.values(JEV_QUESTIONS).map((question) => question.type)).toEqual([
      "choice",
      "boolean",
      "boolean",
      "boolean",
      "boolean",
      "boolean",
      "boolean",
      "boolean",
    ]);
  });
});

describe("JEV policy", () => {
  it("allows a fitting direct social response without informational value", () => {
    const result = decideJev(
      ambientEvidence({ relation: { addressed: 0.9, followup: 0, open: 0, other: 0, ambient: 0.1 }, social: 0.1 }),
      { activity: [] },
      policy,
      100000,
    );
    expect(result.mode).toBe("reply");
  });
  it("does not treat interest as a contribution or group opening", () => {
    const result = decideJev(ambientEvidence({ interested: 1, receptive: 1 }), { activity: [] }, policy, 100000);
    expect(result.mode).toBe("wait");
    expect(result.reason).toBe("no-contribution");
  });
  it("keeps a public two-person exchange eligible when it is receptive", () => {
    const result = decideJev(
      ambientEvidence({ worthwhile: 0.8, receptive: 0.9, relation: { addressed: 0, followup: 0, open: 0, other: 0.1, ambient: 0.9 } }),
      {
        activity: [
          { at: 99000, author: "a", self: false },
          { at: 99500, author: "b", self: false },
        ],
      },
      policy,
      100000,
    );
    expect(result.mode).toBe("join");
  });
  it("allows moderately positive openings while preserving evidence and safety floors", () => {
    const moderate = ambientEvidence({
      relation: { addressed: 0.02, followup: 0.02, open: 0.02, other: 0.04, ambient: 0.9 },
      worthwhile: 0.56,
      receptive: 0.56,
    });
    expect(decideJev(moderate, { activity: [] }, policy, 100000)).toMatchObject({ mode: "join", reason: "relevant-contribution" });
    expect(decideJev({ ...moderate, receptive: 0.51 }, { activity: [] }, policy, 100000)).toMatchObject({ mode: "wait", reason: "no-opening" });
    expect(decideJev({ ...moderate, worthwhile: 0.51 }, { activity: [] }, policy, 100000)).toMatchObject({ mode: "wait", reason: "weak-contribution" });
    expect(decideJev({ ...moderate, withdrawn: 0.9 }, { activity: [] }, policy, 100000)).toMatchObject({ mode: "wait", reason: "withdrawn" });
  });
  it("withdraws only on explicit focus-author evidence", () => {
    const result = decideJev(
      ambientEvidence({ relation: { addressed: 1, followup: 0, open: 0, other: 0, ambient: 0 }, withdrawn: 0.9 }),
      { activity: [] },
      policy,
      100000,
    );
    expect(result).toMatchObject({ mode: "wait", reason: "withdrawn" });
  });
  it("does not treat a group invitation alone as contribution", () => {
    const result = decideJev(
      ambientEvidence({ relation: { addressed: 0, followup: 0, open: 0.9, other: 0, ambient: 0.1 }, receptive: 0.9 }),
      { activity: [] },
      policy,
      100000,
    );
    expect(result).toMatchObject({ mode: "wait", reason: "no-contribution" });
  });
  it("requires enough actual participants before applying the participation cap", () => {
    const activity: Participation[] = Array.from({ length: 8 }, (_, index) => ({ at: 99000 + index, author: "member-" + index, self: false }));
    activity.push({ at: 99999, author: "bot", self: true, proactive: true });
    const result = decideJev(ambientEvidence({ worthwhile: 0.9, receptive: 0.9 }), { activity }, policy, 100000);
    expect(result.mode).toBe("join");
  });
  it("enforces the unsolicited participation cap after enough group turns", () => {
    const activity: Participation[] = Array.from({ length: 8 }, (_, index) => ({ at: 99000 + index, author: "member-" + index, self: false, natural: true }));
    activity.push(
      { at: 99997, author: "bot", self: true, proactive: true, natural: false },
      { at: 99998, author: "bot", self: true, proactive: true, natural: false },
      { at: 99999, author: "bot", self: true, proactive: true, natural: false },
    );
    const result = decideJev(ambientEvidence({ worthwhile: 0.9, receptive: 0.9 }), { activity }, policy, 100000);
    expect(result).toMatchObject({ mode: "wait", reason: "participation-limit" });
  });
  it("requires information when a direct conversation reaches its reply budget", () => {
    const result = decideJev(
      ambientEvidence({ relation: { addressed: 1, followup: 0, open: 0, other: 0, ambient: 0 }, social: 0.9 }),
      { activity: [], lastSpokeAt: 99000, lastConversationAt: 99000, consecutiveReplies: 4 },
      policy,
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

  it("maps participation styles to bounded confidence floors", () => {
    expect(jevParticipationThreshold(0.7, "quiet")).toBeCloseTo(0.8);
    expect(jevParticipationThreshold(0.7, "natural")).toBe(0.7);
    expect(jevParticipationThreshold(0.7, "talkative")).toBeCloseTo(0.55);
    expect(jevParticipationThreshold(0.4, "talkative")).toBe(0.52);
    expect(jevParticipationThreshold(0.95, "quiet")).toBe(1);
  });

  it("treats a live follow-up as directed and answers only when it is addressed", () => {
    const followup = evidence({
      relation: { addressed: 0.05, followup: 0.9, open: 0.02, other: 0.02, ambient: 0.01 },
    });
    const state = { activity: [], lastSpokeAt: 1_000 };

    expect(isDirectedJev(followup, state, policy, 10_000)).toBe(true);
    expect(decideJev(followup, state, policy, 10_000)).toMatchObject({ mode: "reply", reason: "followup" });
    expect(isDirectedJev(followup, state, { ...policy, addressedThreshold: 0.99 }, 10_000)).toBe(false);
    expect(decideJev(followup, state, { ...policy, addressedThreshold: 0.99 }, 10_000).mode).toBe("wait");
  });

  it("allows contextual short social replies but rejects unsupported or unfinished chatter", () => {
    const contextualReaction = evidence({
      relation: { addressed: 0.1, followup: 0.15, open: 0.1, other: 0.1, ambient: 0.55 },
      worthwhile: 0.2,
      social: 0.58,
      receptive: 0.7,
      ready: 0.72,
      closed: 0.1,
      withdrawn: 0.05,
    });
    const talkative = jevParticipationThreshold(policy.threshold, "talkative");

    expect(decideJev(contextualReaction, { activity: [] }, policy, 10_000, talkative)).toMatchObject({ mode: "join", reason: "relevant-contribution" });
    expect(decideJev({ ...contextualReaction, social: 0.45 }, { activity: [] }, policy, 10_000, talkative)).toMatchObject({
      mode: "wait",
      reason: "no-contribution",
    });
    expect(decideJev({ ...contextualReaction, ready: 0.48 }, { activity: [] }, policy, 10_000, talkative)).toMatchObject({
      mode: "wait",
      reason: "unfinished",
    });
  });

  it("applies global and channel proactive intervals independently", () => {
    const ledger = new JevFrequencyLedger();
    expect(ledger.reserve("runtime-a\0turn-1", "channel-a", 100_000, 60_000, 30_000)).toBeUndefined();
    expect(ledger.reserve("runtime-b\0turn-2", "channel-b", 100_001, 60_000, 10_000)).toBe("global-frequency");
    ledger.release("runtime-a\0turn-1");
    expect(ledger.reserve("runtime-b\0turn-2", "channel-b", 100_001, 60_000, 10_000)).toBeUndefined();
    ledger.commit("runtime-b\0turn-2", 100_010);
    expect(ledger.state("channel-b")).toMatchObject({ lastGlobalProactiveAt: 100_010, lastChannelProactiveAt: 100_010 });
    expect(ledger.reserve("runtime-c\0turn-3", "channel-a", 120_000, 60_000, 30_000)).toBe("global-frequency");
    expect(ledger.reserve("runtime-c\0turn-4", "channel-b", 120_000, 0, 30_000)).toBe("join-cooldown");
  });

  it("enforces the shared global speech interval but not on directed replies", () => {
    const state = { activity: [], lastGlobalProactiveAt: 9_000 };
    const open = evidence({ relation: { addressed: 0.02, followup: 0.02, open: 0.9, other: 0.04, ambient: 0.02 } });

    expect(
      prefilterJev({ now: 10_000, state, config: policy, mode: "safe", alive: false, possibleAddress: false, duplicate: false, mediaOnly: false }),
    ).toEqual({ reason: "global-frequency" });
    expect(decideJev(open, state, policy, 10_000)).toMatchObject({ mode: "wait", reason: "global-frequency" });
    expect(decideJev(evidence(), state, policy, 10_000).mode).toBe("reply");
  });

  it("records the rule chain so a rejection can be explained", () => {
    const blocked = decideJev(
      evidence({
        relation: { addressed: 0.02, followup: 0.02, open: 0.02, other: 0.04, ambient: 0.9 },
        worthwhile: 0.2,
        social: 0.2,
        receptive: 0.3,
      }),
      { activity: [] },
      policy,
      10_000,
    );
    expect(blocked).toMatchObject({ mode: "wait", reason: "no-contribution" });
    const failed = blocked.steps.filter((step) => step.stop);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ key: "no-contribution", value: 0.2, line: 0.5 });
    expect(blocked.steps.at(-1)).toBe(failed[0]);

    const joined = decideJev(evidence(), { activity: [] }, policy, 10_000);
    expect(joined.mode).toBe("reply");
    expect(joined.steps.every((step) => step.ok)).toBe(true);
    expect(joined.steps.map((step) => step.key)).toContain("directed");
    expect(joined.steps.some((step) => step.stop === true)).toBe(false);
  });

  it("prefilters only when the outcome is already decided locally", () => {
    const base = { now: 10_000, config: policy, mode: "safe" as const, alive: false, possibleAddress: false, duplicate: false, mediaOnly: false };
    const state = { activity: [], lastSpokeAt: 9_000 };

    expect(prefilterJev({ ...base, state })).toEqual({ reason: "cooldown" });
    expect(prefilterJev({ ...base, state, alive: true })).toBeUndefined();
    expect(prefilterJev({ ...base, state, possibleAddress: true })).toBeUndefined();
    expect(prefilterJev({ ...base, state: { activity: [] }, duplicate: true })).toEqual({ reason: "duplicate" });
    expect(prefilterJev({ ...base, state: { activity: [] }, mediaOnly: true })).toBeUndefined();
    expect(prefilterJev({ ...base, state: { activity: [] }, mediaOnly: true, mode: "strict" })).toEqual({ reason: "media-only" });
    expect(prefilterJev({ ...base, state: { activity: [] }, mode: "off" })).toBeUndefined();
  });

  it("joins a meaningful +1 in an open group discussion but rejects a reflexive echo", () => {
    const continuation = evidence({
      relation: { addressed: 0.02, followup: 0.03, open: 0.78, other: 0.05, ambient: 0.12 },
      worthwhile: 0.2,
      social: 0.64,
      receptive: 0.82,
      ready: 0.96,
      closed: 0.04,
      withdrawn: 0.02,
    });
    const talkative = jevParticipationThreshold(policy.threshold, "talkative");

    expect(decideJev(continuation, { activity: [] }, policy, 10_000, talkative)).toMatchObject({ mode: "join", reason: "group-invitation" });
    expect(
      decideJev(
        { ...continuation, relation: { addressed: 0.02, followup: 0.03, open: 0.12, other: 0.08, ambient: 0.75 }, social: 0.42 },
        { activity: [] },
        policy,
        10_000,
        talkative,
      ),
    ).toMatchObject({ mode: "wait", reason: "no-contribution" });
  });

  it("does not reply to a third-person bot mention but replies to a direct vocative", () => {
    const thirdPerson = evidence({
      relation: { addressed: 0.12, followup: 0.03, open: 0.05, other: 0.25, ambient: 0.55 },
      worthwhile: 0.18,
      social: 0.2,
      receptive: 0.8,
    });
    const vocative = evidence({
      relation: { addressed: 0.82, followup: 0.04, open: 0.02, other: 0.04, ambient: 0.08 },
      worthwhile: 0.18,
      social: 0.25,
    });

    expect(decideJev(thirdPerson, { activity: [] }, policy, 10_000)).toMatchObject({ mode: "wait", reason: "no-contribution" });
    expect(decideJev(vocative, { activity: [] }, policy, 10_000)).toMatchObject({ mode: "reply", reason: "addressed" });
  });

  it("keeps the observed bot welcome, useful group question, and other-person welcome distinct", () => {
    const botWelcome = evidence({
      relation: { addressed: 1, followup: 0, open: 0, other: 0, ambient: 0 },
      worthwhile: 0.03,
      social: 0.71,
      ready: 0.98,
      receptive: 0.84,
      withdrawn: 0.02,
      closed: 0.15,
      interested: 0.03,
    });
    const publicQuestion = evidence({
      relation: { addressed: 0, followup: 0, open: 1, other: 0, ambient: 0 },
      worthwhile: 0.95,
      social: 0.31,
      ready: 0.98,
      receptive: 0.93,
      withdrawn: 0.02,
      closed: 0.03,
      interested: 0.99,
    });
    const otherPersonWelcome = evidence({
      relation: { addressed: 0, followup: 0, open: 0.24, other: 0.55, ambient: 0.21 },
      worthwhile: 0.04,
      social: 0.35,
      ready: 0.97,
      receptive: 0.89,
      withdrawn: 0.02,
      closed: 0.17,
      interested: 0.02,
    });
    const naturalThreshold = jevParticipationThreshold(policy.threshold, "natural");

    expect(decideJev(botWelcome, { activity: [] }, policy, 10_000).mode).toBe("reply");
    expect(decideJev(publicQuestion, { activity: [] }, policy, 10_000, naturalThreshold).mode).toBe("join");
    expect(decideJev(otherPersonWelcome, { activity: [] }, policy, 10_000, naturalThreshold)).toMatchObject({ mode: "wait", reason: "no-contribution" });
  });

  it("applies participation style to invitations without lowering positive-evidence floors", () => {
    const moderateInvitation = evidence({
      relation: { addressed: 0.02, followup: 0.02, open: 0.9, other: 0.02, ambient: 0.04 },
      worthwhile: 0.53,
      receptive: 0.53,
    });
    const naturalThreshold = jevParticipationThreshold(policy.threshold, "natural");
    const talkativeThreshold = jevParticipationThreshold(policy.threshold, "talkative");
    const quietThreshold = jevParticipationThreshold(policy.threshold, "quiet");

    expect(decideJev(moderateInvitation, { activity: [] }, policy, 10_000, naturalThreshold)).toMatchObject({ mode: "wait", reason: "no-opening" });
    expect(
      decideJev({ ...moderateInvitation, receptive: 0.6 }, { activity: [] }, policy, 10_000, jevParticipationThreshold(policy.threshold, "talkative")),
    ).toMatchObject({ mode: "join", reason: "group-invitation" });
    expect(decideJev(moderateInvitation, { activity: [] }, policy, 10_000, talkativeThreshold)).toMatchObject({ mode: "join", reason: "group-invitation" });
    expect(decideJev(moderateInvitation, { activity: [] }, policy, 10_000, quietThreshold)).toMatchObject({ mode: "wait", reason: "no-opening" });
    expect(decideJev({ ...moderateInvitation, receptive: 0.5 }, { activity: [] }, policy, 10_000, talkativeThreshold)).toMatchObject({
      mode: "wait",
      reason: "no-opening",
    });
  });

  it("does not let talkative participation style bypass the direct-reply conversation budget", () => {
    const direct = evidence({ relation: { addressed: 0.9, followup: 0.025, open: 0.025, other: 0.025, ambient: 0.025 }, worthwhile: 0.6 });
    expect(
      decideJev(
        direct,
        { activity: [], lastSpokeAt: 9_000, lastConversationAt: 9_000, consecutiveReplies: 4 },
        policy,
        10_000,
        jevParticipationThreshold(policy.threshold, "talkative"),
      ),
    ).toMatchObject({ mode: "wait", reason: "conversation-budget" });
  });

  it("requires receptive pacing and contribution for an unsolicited join", () => {
    const open = evidence({
      relation: { addressed: 0.02, followup: 0.02, open: 0.9, other: 0.04, ambient: 0.02 },
    });
    const activity = Array.from({ length: 6 }, (_, index) => ({
      at: 9_000 + index,
      author: `user-${index}`,
      self: false,
      natural: true,
    }));

    expect(decideJev(open, { activity }, policy, 10_000)).toMatchObject({ mode: "join", reason: "group-invitation" });
    expect(decideJev({ ...open, receptive: 0.2 }, { activity }, policy, 10_000)).toMatchObject({
      mode: "wait",
      reason: "no-opening",
    });
  });

  it("stops unsolicited participation at the configured ratio", () => {
    const open = evidence({
      relation: { addressed: 0.02, followup: 0.02, open: 0.9, other: 0.04, ambient: 0.02 },
    });
    const activity = [
      ...Array.from({ length: 6 }, (_, index) => ({
        at: 9_000 + index,
        author: `user-${index}`,
        self: false,
        natural: true,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        at: 9_100 + index,
        author: "self",
        self: true,
        proactive: true,
      })),
    ];

    expect(decideJev(open, { activity }, policy, 10_000)).toMatchObject({
      mode: "wait",
      reason: "participation-limit",
    });
  });
});

describe("JEV context", () => {
  it("uses one normalized evidence projection for focus and history messages", () => {
    expect(
      projectJevLine(
        {
          id: "mention",
          author: "member",
          authorId: "u1",
          text: '<at id="bot"/>',
          at: 9_000,
          self: false,
          mentionsBot: true,
          quote: { id: "bot-reply", author_id: "bot", text: "hello" },
        },
        10_000,
      ),
    ).toMatchObject({
      author_id: "u1",
      is_bot: false,
      seconds_ago: 1,
      mentions_bot: true,
      quote: { author_id: "bot" },
    });
  });

  it("retains focus, quote and the last bot exchange without pending input", () => {
    const lines: JevContextLine[] = [
      { id: "first", author: "甲", authorId: "u1", text: "first", at: 1_000, self: false },
      { id: "quote", author: "乙", authorId: "u2", text: "quoted", at: 2_000, self: false },
      { id: "before-bot", author: "甲", authorId: "u1", text: "before bot", at: 3_000, self: false },
      { id: "bot", author: "self", authorId: "self", text: "bot reply", at: 4_000, self: true },
      { id: "pending", author: "乙", authorId: "u2", text: "pending", at: 5_000, self: false },
      { id: "focus", author: "乙", authorId: "u2", text: "focus", at: 6_000, self: false },
    ];

    const selected = selectJevContext(lines, {
      count: 4,
      chars: 2_000,
      now: 10_000,
      maxAgeMs: 20_000,
      pendingIds: ["pending"],
      quoteId: "quote",
      focusId: "focus",
    });

    expect(selected.map((line) => line.id)).toEqual(["quote", "before-bot", "bot", "focus"]);
    expect(selected.every((line) => line.id !== "pending")).toBe(true);
    expect(selected.find((line) => line.id === "focus")).toMatchObject({
      author_id: "u2",
      is_bot: false,
      seconds_ago: 4,
    });
  });

  it("clips long text without losing both ends", () => {
    const text = `${"head".repeat(100)}${"tail".repeat(100)}`;
    const clipped = clipJevText(text, 160);

    expect(clipped).toContain("…[middle omitted]…");
    expect(clipped.startsWith("head")).toBe(true);
    expect(clipped.endsWith("tail")).toBe(true);
    expect(clipped.length).toBe(160);
  });
});
