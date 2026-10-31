import type { Experimental_DecisionModelV4Result as DecisionModelResult } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import { clipJevText, projectJevLine, selectJevContext, type JevContextLine } from "../src/context.js";
import { JevFrequencyLedger } from "../src/frequency.js";
import {
  decideJev,
  isDirectedJev,
  jevParticipationThreshold,
  JEV_QUESTIONS,
  parseJevChoice,
  parseJevEvidence,
  prefilterJev,
  type JevEvidence,
  type JevPolicyConfig,
} from "../src/policy.js";

const policy: JevPolicyConfig = {
  threshold: 0.7,
  addressedThreshold: 0.7,
  cooldownMs: 30_000,
  globalCooldownMs: 60_000,
  minIntervalMs: 2_000,
  conversationMs: 120_000,
  participationWindowMs: 300_000,
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

describe("JEV local policy", () => {
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
    expect(ledger.reserve("runtime-a\\0turn-1", "channel-a", 100_000, 60_000, 30_000)).toBeUndefined();
    expect(ledger.reserve("runtime-b\\0turn-2", "channel-b", 100_001, 60_000, 10_000)).toBe("global-frequency");
    ledger.release("runtime-a\\0turn-1");
    expect(ledger.reserve("runtime-b\\0turn-2", "channel-b", 100_001, 60_000, 10_000)).toBeUndefined();
    ledger.commit("runtime-b\\0turn-2", 100_010);
    expect(ledger.state("channel-b")).toMatchObject({ lastGlobalProactiveAt: 100_010, lastChannelProactiveAt: 100_010 });
    expect(ledger.reserve("runtime-c\\0turn-3", "channel-a", 120_000, 60_000, 30_000)).toBe("global-frequency");
    expect(ledger.reserve("runtime-c\\0turn-4", "channel-b", 120_000, 0, 30_000)).toBe("join-cooldown");
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

  it("blocks proactive paths globally but leaves direct replies available", () => {
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

  it("lets an explicit withdrawal override a direct question", () => {
    expect(decideJev(evidence({ withdrawn: 0.9 }), { activity: [] }, policy, 10_000)).toMatchObject({
      mode: "wait",
      reason: "withdrawn",
    });
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
