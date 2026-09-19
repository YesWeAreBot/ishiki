import { describe, expect, it } from "vitest";

import { isChannelAllowed, matchesChannelRules, parseProfileConfig, resolveFocus, type Profile, validateProfileConfig } from "../src/profiles.js";

function makeProfile(id: string, channels: string[], initialChannel = "group:1"): Profile {
  return {
    id,
    dataPath: `data/ishiki/${id}`,
    model: "test:model",
    name: id,
    initialFocus: { sid: "onebot:1", channelId: initialChannel },
    allowedChannels: [{ sid: "onebot:1", channels }],
    keywords: [],
    attention: { mentions: [], quoteSelf: false },
    context: {
      workspaceTokenLimit: 8192,
      charsPerToken: 4,
      idleMs: 1_800_000,
      historyEntries: 40,
      sceneWindowMs: 24 * 60 * 60 * 1000,
    },
    innerThought: false,
  };
}

describe("channel rules", () => {
  it("matches exact ids and prefix wildcards with exclusions", () => {
    expect(matchesChannelRules(["*", "!private:*"], "group:1")).toBe(true);
    expect(matchesChannelRules(["*", "!private:*"], "private:1")).toBe(false);
    expect(matchesChannelRules(["private:*", "!private:10001"], "private:10000")).toBe(true);
    expect(matchesChannelRules(["private:*", "!private:10001"], "private:10001")).toBe(false);
    expect(matchesChannelRules(["*", "!12345678"], "12345679")).toBe(true);
    expect(matchesChannelRules(["*", "!12345678"], "12345678")).toBe(false);
    expect(matchesChannelRules(["*"], "@user-id")).toBe(true);
  });

  it("allows an exclusion-only declaration to mean all except the exclusions", () => {
    expect(matchesChannelRules(["!private:*"], "group:1")).toBe(true);
    expect(matchesChannelRules(["!private:*"], "private:1")).toBe(false);
  });

  it("rejects unsupported rule syntax", () => {
    expect(() => matchesChannelRules(["group*1"], "group1")).toThrow(/only allowed once at the end/);
    expect(() => matchesChannelRules(["group!1"], "group1")).toThrow(/only allowed at the beginning/);
    expect(() => matchesChannelRules(["!"], "group1")).toThrow(/must contain/);
  });

  it("uses channel id as the only matching value", () => {
    const profile = makeProfile("boki", ["*"]);
    expect(isChannelAllowed(profile, "onebot:1", "@user-id")).toBe(true);
    expect(isChannelAllowed(profile, "onebot:1", "private:1")).toBe(true);
    expect(isChannelAllowed(profile, "onebot:2", "group:1")).toBe(false);
  });
});

describe("profile validation", () => {
  it("parses yaml and applies schema defaults before semantic validation", () => {
    const config = parseProfileConfig(`
profiles:
  - id: boki
    dataPath: data/ishiki/boki
    model: test:model
    initialFocus:
      sid: "onebot:1"
      channelId: group:1
    allowedChannels:
      - sid: "onebot:1"
        channels:
          - "*"
          - "!private:*"
`);

    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].keywords).toEqual([]);
    expect(config.profiles[0].context.historyEntries).toBe(40);
  });

  it("requires the initial focus to be allowed", () => {
    expect(() => validateProfileConfig({ profiles: [makeProfile("boki", ["group:1"], "private:1")] })).toThrow(/initial focus/);
  });

  it("rejects duplicate profile ids and duplicate sids within one profile", () => {
    const first = makeProfile("boki", ["group:1"]);
    expect(() => validateProfileConfig({ profiles: [first, { ...first }] })).toThrow(/duplicated/);

    const duplicateSid = { ...first, allowedChannels: [...first.allowedChannels, { sid: "onebot:1", channels: ["group:2"] }] };
    expect(() => validateProfileConfig({ profiles: [duplicateSid] })).toThrow(/more than once/);
  });

  it("rejects overlapping channel sets for the same sid across profiles", () => {
    const group = makeProfile("group", ["*", "!private:*"]);
    const privateChat = makeProfile("private", ["private:*"], "private:1");
    expect(() => validateProfileConfig({ profiles: [group, privateChat] })).not.toThrow();

    const overlap = makeProfile("overlap", ["group:*"]);
    expect(() => validateProfileConfig({ profiles: [group, overlap] })).toThrow(/overlap/);
  });

  it("recognizes fully excluded prefixes as disjoint", () => {
    const allExceptPrivate = makeProfile("all-except-private", ["*", "!private:*"]);
    const privateChat = makeProfile("private", ["private:*"], "private:1");
    expect(() => validateProfileConfig({ profiles: [allExceptPrivate, privateChat] })).not.toThrow();
  });

  it("considers exclusions when checking cross-profile overlap", () => {
    const exceptOne = makeProfile("except-one", ["private:*", "!private:1"], "private:2");
    const one = makeProfile("one", ["private:1"], "private:1");
    const two = makeProfile("two", ["private:2"], "private:2");

    expect(() => validateProfileConfig({ profiles: [exceptOne, one] })).not.toThrow();
    expect(() => validateProfileConfig({ profiles: [exceptOne, two] })).toThrow(/overlap/);
  });
});

describe("focus resolution", () => {
  const profile = makeProfile("boki", ["group:1", "group:2"]);
  const focus = { sid: "onebot:1", channelId: "group:1" };

  it("defaults the body to the current focus", () => {
    expect(resolveFocus(profile, focus, { channel: "group:2" })).toEqual({ sid: "onebot:1", channelId: "group:2" });
  });

  it("defaults the whole target to the open window", () => {
    expect(resolveFocus(profile, focus, {})).toEqual(focus);
    expect(resolveFocus(profile, focus, { sid: "onebot:1" })).toEqual(focus);
  });

  it("rejects a body the profile does not own", () => {
    const result = resolveFocus(profile, focus, { sid: "onebot:9", channel: "group:1" });
    expect("error" in result && result.error.name).toBe("UnknownBody");
  });

  it("rejects a channel outside the declaration of that body", () => {
    const result = resolveFocus(profile, focus, { channel: "group:3" });
    expect("error" in result && result.error.name).toBe("TargetNotAllowed");
    expect("error" in result && result.error.message).toContain("group:1, group:2");
  });

  it("refuses another body without a channel", () => {
    const twoBodies: Profile = { ...profile, allowedChannels: [...profile.allowedChannels, { sid: "onebot:2", channels: ["group:3"] }] };

    const result = resolveFocus(twoBodies, focus, { sid: "onebot:2" });
    expect("error" in result && result.error.name).toBe("InvalidInput");
    expect(resolveFocus(twoBodies, focus, { sid: "onebot:2", channel: "group:3" })).toEqual({ sid: "onebot:2", channelId: "group:3" });
  });

  it("rejects an empty channel", () => {
    const result = resolveFocus(profile, focus, { channel: "" });
    expect("error" in result && result.error.name).toBe("InvalidInput");
  });
});
