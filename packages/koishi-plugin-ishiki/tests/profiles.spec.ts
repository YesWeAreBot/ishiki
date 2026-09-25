import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_SETTINGS,
  isSceneAllowed,
  matchingRuleByAddress,
  matchingRule,
  parseProfileFile,
  resolveScenePolicy,
  sceneDirectoryName,
  validateProfiles,
  type Profile,
  type Scene,
} from "../src/profiles.js";

const SOURCE = `
id: neko
name: 猫猫
model: test:model
systemPrompt: |
  你是猫猫。
sid:
  - onebot:1
  - discord:9
defaults:
  promptExtension: 全局补充
  context:
    maxMessages: 40
    evictMs: 120000
  wakeup:
    atMe: true
    direct: true
    keywords: ["猫猫"]
presets:
  public_group:
    promptExtension: 公开群聊，保持克制。
    context:
      maxMessages: 50
    wakeup:
      quoteSelf: true
    disabledTools: ["run_bash"]
  direct_chat:
    promptExtension: 私聊，温柔一点。
    wakeup:
      keywords: ["neko"]
channels:
  - match:
      type: direct
    preset: direct_chat
  - match:
      sid: onebot:1
      type: group
      channelId: ["*", "!12345678"]
    preset: public_group
  - match:
      sid: onebot:1
      type: group
      channelId: "12345678"
    preset: public_group
    promptExtension: 这是研发群，别用口癖。
    disabledTools: []
`;

function parse(source: string, catalog = "im-neko"): Profile {
  return parseProfileFile(source, { catalog, profilePath: `/data/ishiki/profiles/${catalog}/profile.yaml` });
}

function scene(sid: string, channelId: string, sceneType: Scene["sceneType"] = "group"): Scene {
  return { sid, channelId, platform: sid.slice(0, sid.indexOf(":")), sceneType };
}

/** A minimal profile whose one rule covers one channel, plus whatever block the test wants to vary. */
function minimal(block: string, options: { sid?: string; channel?: string } = {}): string {
  return `
id: minimal
model: test:model
systemPrompt: hi
sid: ["${options.sid ?? "onebot:1"}"]
${block}
presets:
  everything: {}
channels:
  - match: { channelId: "${options.channel ?? "group:1"}" }
    preset: everything
`;
}

describe("profile file", () => {
  it("parses the scene rules and applies the schema defaults", () => {
    const profile = parse(SOURCE);

    expect(profile.id).toBe("neko");
    expect(profile.catalog).toBe("im-neko");
    expect(profile.sids).toEqual(["onebot:1", "discord:9"]);
    expect(profile.channelRules).toHaveLength(3);
    expect(profile.channelRules[0].match.type).toBe("direct");
    expect(profile.innerThought).toBe(false);
    expect(profile.typing.charPerSecond).toBe(5);
    expect(profile.presets.public_group.disabledTools).toEqual(["run_bash"]);
  });

  it("reads a rule without a match block as the catch-all rule", () => {
    const profile = parse(`
id: mini
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  everything: {}
channels:
  - preset: everything
`);

    expect(profile.channelRules[0].match).toEqual({});
    expect(isSceneAllowed(profile, scene("onebot:1", "group:1"))).toBe(true);
  });

  it("refuses a rule that names no preset", () => {
    expect(() =>
      parse(`
id: mini
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  everything: {}
channels:
  - match: { channelId: "group:1" }
`),
    ).toThrow(/must name its preset/);
  });
});

describe("scene matching", () => {
  const profile = parse(SOURCE);

  it("matches on type, sid, platform and channel with wildcards and exclusions", () => {
    // The rule for one channel carries its own extension and clears the preset's tool cut.
    expect(matchingRule(profile, scene("onebot:1", "12345678"))?.promptExtension).toContain("研发群");
    expect(matchingRule(profile, scene("onebot:1", "12345678"))?.disabledTools).toEqual([]);
    // The wildcard rule owns every other group and adds nothing of its own.
    expect(matchingRule(profile, scene("onebot:1", "group:1"))?.preset).toBe("public_group");
    expect(matchingRule(profile, scene("onebot:1", "group:1"))?.promptExtension).toBeUndefined();
    expect(matchingRule(profile, scene("onebot:1", "group:2"))?.preset).toBe("public_group");
    expect(matchingRule(profile, scene("discord:9", "private:1", "direct"))?.preset).toBe("direct_chat");
  });

  it("leaves a scene another body owns unclaimed", () => {
    expect(isSceneAllowed(profile, scene("discord:9", "group:1"))).toBe(false);
    expect(isSceneAllowed(profile, scene("onebot:1", "group:1", "guild"))).toBe(false);
  });
});

describe("scene policy", () => {
  const profile = parse(SOURCE);

  it("layers defaults, preset and rule: prompt extensions add up, numbers override", () => {
    const policy = resolveScenePolicy(profile, scene("onebot:1", "12345678"));

    expect(policy.promptExtension).toBe("全局补充\n\n公开群聊，保持克制。\n\n这是研发群，别用口癖。");
    expect(policy.context.maxMessages).toBe(50);
    expect(policy.context.evictMs).toBe(120000);
    // The rule's own empty list means "no tool is cut here", not "inherit the preset's list".
    expect(policy.disabledTools).toEqual([]);
  });

  it("keeps the preset's tool list when the rule does not mention one", () => {
    const policy = resolveScenePolicy(profile, scene("onebot:1", "group:2"));

    expect(policy.disabledTools).toEqual(["run_bash"]);
    expect(policy.context.maxMessages).toBe(50);
  });

  it("layers the wakeup parameters over the profile defaults", () => {
    const group = resolveScenePolicy(profile, scene("onebot:1", "group:2"));
    expect(group.wakeup).toEqual({ atMe: true, direct: true, quoteSelf: true, keywords: ["猫猫"] });

    // The preset's keyword list replaces the profile's, and the untouched fields keep their earlier value.
    const direct = resolveScenePolicy(profile, scene("discord:9", "private:1", "direct"));
    expect(direct.wakeup).toEqual({ atMe: true, direct: true, quoteSelf: false, keywords: ["neko"] });
    expect(direct.context.maxMessages).toBe(DEFAULT_CONTEXT_SETTINGS.maxMessages);
  });
});

describe("profile validation", () => {
  it("lets the earlier rule win when two rules could both match", () => {
    expect(() =>
      parse(`
id: overlap
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  everything: {}
channels:
  - match: { channelId: "*" }
    preset: everything
  - match: { channelId: "group:1" }
    preset: everything
`),
    ).not.toThrow();
    const profile = parse(`
id: overlap
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  wide: {}
  narrow:
    promptExtension: 窄规则
channels:
  - match: { channelId: "*" }
    preset: wide
  - match: { channelId: "group:1" }
    preset: narrow
`);
    expect(matchingRule(profile, scene("onebot:1", "group:1"))?.preset).toBe("wide");
  });

  it("refuses a rule that names a preset the profile never declares", () => {
    expect(() =>
      parse(`
id: dangling
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  everything: {}
channels:
  - match: { channelId: "group:1" }
    preset: missing
`),
    ).toThrow(/unknown preset/);
  });

  it("refuses a rule that names a sid the profile never declared", () => {
    expect(() =>
      parse(`
id: stranger
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  everything: {}
channels:
  - match: { sid: "onebot:2", channelId: "group:1" }
    preset: everything
`),
    ).toThrow(/unknown sid/);
  });

  it("refuses a parameter this build reads when it is not the type it reads", () => {
    expect(() => parse(minimal(`defaults:\n  context:\n      maxMessages: "many"`))).toThrow(/expected a number/);
  });

  it("refuses an engine name where a setting belongs", () => {
    expect(() => parse(minimal(`defaults:\n  wakeup:\n    engine: standard-rule`))).toThrow(/unknown key "engine"/);
  });

  it("refuses malformed channel rules and sids", () => {
    expect(() => parse(minimal("", { channel: "group*1" }))).toThrow(/only allowed once at the end/);
    expect(() => parse(minimal("", { channel: "group!1" }))).toThrow(/only allowed at the beginning/);
    expect(() => parse(minimal("", { sid: "onebot" }))).toThrow(/invalid sid/);
  });

  it("refuses two profiles that drive the same body, and allows two personalities in one channel", () => {
    const mine = parse(SOURCE, "im-neko");
    const sameBody: Profile = { ...parse(SOURCE, "im-copy"), id: "neko-copy" };
    expect(() => validateProfiles([mine, sameBody])).toThrow(/both claim sid/);

    // Another personality in the same channels, speaking through its own body.
    const other = parse(
      `
id: neko-other
model: test:model
systemPrompt: hi
sid: ["onebot:7"]
presets:
  everything: {}
channels:
  - match: { channelId: "*" }
    preset: everything
`,
      "im-other",
    );
    expect(() => validateProfiles([mine, other])).not.toThrow();

    const duplicate: Profile = { ...parse(SOURCE, "im-again") };
    expect(() => validateProfiles([mine, duplicate])).toThrow(/duplicated/);
  });
});

describe("address matching", () => {
  const addressed = parse(`
id: addressed
model: test:model
systemPrompt: hi
sid: ["onebot:1"]
presets:
  group: {}
  direct: {}
channels:
  - match: { channelId: "private:*" }
    preset: direct
  - match: { sid: "onebot:1", channelId: "group:*" }
    preset: group
`);

  it("answers an address whose scene type nobody knows", () => {
    // Only `sid` and `channel` are given: a scene type cannot be read out of an address, so it is not consulted.
    expect(matchingRuleByAddress(addressed, { sid: "onebot:1", channelId: "private:7", platform: "onebot" })?.preset).toBe("direct");
    expect(matchingRuleByAddress(addressed, { sid: "onebot:1", channelId: "group:5", platform: "onebot" })?.preset).toBe("group");
    expect(matchingRuleByAddress(addressed, { sid: "onebot:2", channelId: "group:5", platform: "onebot" })).toBeUndefined();
  });
});

describe("scene directory names", () => {
  it("keeps safe characters and folds every other run into one dash", () => {
    expect(sceneDirectoryName("onebot:123:group:456")).toBe("onebot-123-group-456");
    expect(sceneDirectoryName("onebot:1/group:2")).toBe("onebot-1-group-2");
    expect(sceneDirectoryName("sandbox:abcd.v1_koishi:private:1")).toBe("sandbox-abcd.v1_koishi-private-1");
  });
});
