import { Schema, Time } from "koishi";
import { parse as parseYaml } from "yaml";

export interface Profile {
  id: string;
  dataPath: string;
  model: string;
  initialFocus: { sid: string; channelId: string };
  allowedChannels: Array<{ sid: string; channels: string[] }>;
  keywords: string[];
  attention: { mentions: string[]; quoteSelf: boolean };
  context: {
    workspaceTokenLimit: number;
    idleMs: number;
    historyEntries: number;
    focusHistoryEntries: number;
    toolResultChars: number;
  };
  innerThought: boolean;
}

export interface ProfileConfig {
  profiles: Profile[];
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  profiles: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      dataPath: Schema.string().required(),
      model: Schema.string().required(),
      initialFocus: Schema.object({
        sid: Schema.string().required(),
        channelId: Schema.string().required(),
      }).required(),
      allowedChannels: Schema.array(
        Schema.object({
          sid: Schema.string()
            .pattern(/^\S+:\S+$/)
            .required()
            .description("bot account, e.g. onebot:1434974784"),
          channels: Schema.array(Schema.string()).required(),
        }),
      ).required(),
      keywords: Schema.array(Schema.string()).default([]),
      attention: Schema.object({
        mentions: Schema.array(Schema.string()).default([]),
        quoteSelf: Schema.boolean().default(false),
      }),
      context: Schema.object({
        workspaceTokenLimit: Schema.number().default(8192),
        idleMs: Schema.number().default(30 * Time.minute),
        historyEntries: Schema.number().default(40),
        focusHistoryEntries: Schema.number().default(40),
        toolResultChars: Schema.number().default(2000),
      }),
      innerThought: Schema.boolean().default(false),
    }),
  ).required(),
});

interface CompiledChannelRule {
  negated: boolean;
  prefix: string;
  wildcard: boolean;
}

function invalidRule(rule: string, reason: string): never {
  throw new Error(`Invalid channel rule "${rule}": ${reason}`);
}

function compileChannelRule(rule: string): CompiledChannelRule {
  if (rule.length === 0) invalidRule(rule, "rule must not be empty");

  const negated = rule.startsWith("!");
  const body = negated ? rule.slice(1) : rule;
  if (body.length === 0) invalidRule(rule, "rule must contain a channel id or wildcard");
  if (body.includes("!")) invalidRule(rule, '"!" is only allowed at the beginning');

  const wildcardIndex = body.indexOf("*");
  if (wildcardIndex >= 0 && (wildcardIndex !== body.length - 1 || body.indexOf("*", wildcardIndex + 1) >= 0)) {
    invalidRule(rule, '"*" is only allowed once at the end');
  }

  const wildcard = wildcardIndex >= 0;
  const prefix = wildcard ? body.slice(0, -1) : body;
  if (!prefix && !wildcard) invalidRule(rule, "rule must contain a channel id or wildcard");

  return { negated, prefix, wildcard };
}

function matchesCompiledRule(rule: CompiledChannelRule, channelId: string): boolean {
  return rule.wildcard ? channelId.startsWith(rule.prefix) : channelId === rule.prefix;
}

export function matchesChannelRules(rules: readonly string[], channelId: string): boolean {
  if (!channelId) return false;

  const compiled = rules.map(compileChannelRule);
  const positives = compiled.filter((rule) => !rule.negated);
  const negatives = compiled.filter((rule) => rule.negated);
  const included = positives.length === 0 || positives.some((rule) => matchesCompiledRule(rule, channelId));
  return included && !negatives.some((rule) => matchesCompiledRule(rule, channelId));
}

export function isChannelAllowed(profile: Profile, sid: string, channelId: string): boolean {
  const declaration = profile.allowedChannels.find((item) => item.sid === sid);
  return declaration ? matchesChannelRules(declaration.channels, channelId) : false;
}

function positiveIntersections(left: CompiledChannelRule[], right: CompiledChannelRule[]): CompiledChannelRule[] {
  const leftRules = left.length > 0 ? left : [{ negated: false, prefix: "", wildcard: true }];
  const rightRules = right.length > 0 ? right : [{ negated: false, prefix: "", wildcard: true }];
  const intersections: CompiledChannelRule[] = [];

  for (const a of leftRules) {
    for (const b of rightRules) {
      if (!a.wildcard && !b.wildcard) {
        if (a.prefix === b.prefix) intersections.push({ negated: false, prefix: a.prefix, wildcard: false });
      } else if (!a.wildcard) {
        if (a.prefix.startsWith(b.prefix)) intersections.push({ negated: false, prefix: a.prefix, wildcard: false });
      } else if (!b.wildcard) {
        if (b.prefix.startsWith(a.prefix)) intersections.push({ negated: false, prefix: b.prefix, wildcard: false });
      } else if (a.prefix.startsWith(b.prefix)) {
        intersections.push({ negated: false, prefix: a.prefix, wildcard: true });
      } else if (b.prefix.startsWith(a.prefix)) {
        intersections.push({ negated: false, prefix: b.prefix, wildcard: true });
      }
    }
  }

  return intersections;
}

function hasUnexcludedIntersection(intersection: CompiledChannelRule, negatives: CompiledChannelRule[]): boolean {
  if (!intersection.wildcard) return !negatives.some((rule) => matchesCompiledRule(rule, intersection.prefix));

  return !negatives.some((rule) => rule.wildcard && intersection.prefix.startsWith(rule.prefix));
}

function channelRulesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const leftCompiled = left.map(compileChannelRule);
  const rightCompiled = right.map(compileChannelRule);
  const intersections = positiveIntersections(
    leftCompiled.filter((rule) => !rule.negated),
    rightCompiled.filter((rule) => !rule.negated),
  );
  const leftNegatives = leftCompiled.filter((rule) => rule.negated);
  const rightNegatives = rightCompiled.filter((rule) => rule.negated);
  return intersections.some(
    (intersection) => hasUnexcludedIntersection(intersection, leftNegatives) && hasUnexcludedIntersection(intersection, rightNegatives),
  );
}

function validateProfile(profile: Profile): void {
  if (profile.allowedChannels.length === 0) {
    throw new Error(`Profile "${profile.id}" must declare at least one allowed channel`);
  }

  const sids = new Set<string>();
  for (const declaration of profile.allowedChannels) {
    if (sids.has(declaration.sid)) throw new Error(`Profile "${profile.id}" declares sid "${declaration.sid}" more than once`);
    sids.add(declaration.sid);
    if (declaration.channels.length === 0) {
      throw new Error(`Profile "${profile.id}" must declare at least one channel for sid "${declaration.sid}"`);
    }
    declaration.channels.forEach(compileChannelRule);
  }

  if (!isChannelAllowed(profile, profile.initialFocus.sid, profile.initialFocus.channelId)) {
    throw new Error(`Profile "${profile.id}" initial focus "${profile.initialFocus.sid}/${profile.initialFocus.channelId}" is not allowed by allowedChannels`);
  }
}

function validateDisjointProfiles(profiles: readonly Profile[]): void {
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const left = profiles[i];
      const right = profiles[j];
      const rightBySid = new Map(right.allowedChannels.map((declaration) => [declaration.sid, declaration.channels]));

      for (const declaration of left.allowedChannels) {
        const rightChannels = rightBySid.get(declaration.sid);
        if (rightChannels && channelRulesOverlap(declaration.channels, rightChannels)) {
          throw new Error(`Profiles "${left.id}" and "${right.id}" overlap for sid "${declaration.sid}"`);
        }
      }
    }
  }
}

export function validateProfileConfig(config: ProfileConfig): ProfileConfig {
  const ids = new Set<string>();
  for (const profile of config.profiles) {
    if (ids.has(profile.id)) throw new Error(`Profile id "${profile.id}" is duplicated`);
    ids.add(profile.id);
    validateProfile(profile);
  }
  validateDisjointProfiles(config.profiles);
  return config;
}

export function parseProfileConfig(source: string): ProfileConfig {
  const raw = parseYaml(source);
  const config = ProfileConfig(raw);
  return validateProfileConfig(config);
}
