import type { Experimental_DecisionModelV4Result as DecisionModelResult } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import {
  clipJevText,
  decideJev,
  isDirectedJev,
  JEV_QUESTIONS,
  parseJevEvidence,
  selectJevContext,
  type JevContextLine,
  type JevEvidence,
  type JevPolicyConfig,
} from "../src/wakeup/jev.engine.js";

const policy: JevPolicyConfig = {
  threshold: 0.7,
  addressedThreshold: 0.7,
  cooldownMs: 30_000,
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
    expect(Object.values(JEV_QUESTIONS).some((question) => question.type === "noul")).toBe(false);
  });
});

describe("JEV local policy", () => {
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

    expect(selected.map((line) => line.id)).toEqual(["focus", "bot", "before-bot", "quote"]);
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
