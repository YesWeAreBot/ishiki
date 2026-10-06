import { Schema } from "koishi";

import { ContextEngines } from "../context/index.js";
import { ToolcallEngines } from "../toolcall/index.js";
import { WakeupEngines } from "../wakeup/index.js";

export type EngineConfig<E> = [keyof E] extends [never]
  ? { engine: string; [k: string]: unknown }
  : { [K in keyof E]: { engine: K } & Partial<Record<K, Partial<E[K]>>> }[keyof E];

export type ContextConfig = EngineConfig<ContextEngines>;

export const ContextConfig: Schema<ContextConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string(),
  }).required(),
  Schema.union([Schema.any()]),
]);

export type WakeupConfig = EngineConfig<WakeupEngines>;

export const WakeupConfig: Schema<WakeupConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string(),
  }).required(),
  Schema.union([Schema.any()]),
]);

export type ToolcallConfig = EngineConfig<ToolcallEngines>;

export const ToolcallConfig: Schema<ToolcallConfig> = Schema.intersect([
  Schema.object({
    engine: Schema.string(),
  }).required(),
  Schema.union([Schema.any()]),
]);

export interface TypingConfig {
  baseDelay: number;
  charPerSecond: number;
  minDelay: number;
  maxDelay: number;
}

export const TypingConfig: Schema<TypingConfig> = Schema.object({
  baseDelay: Schema.number().description("每条消息的基础延迟（毫秒）").default(500),
  charPerSecond: Schema.number().description("模拟打字速度（字符/秒）").default(5),
  minDelay: Schema.number().description("单条消息延迟下限（毫秒）").default(800),
  maxDelay: Schema.number().description("单条消息延迟上限（毫秒）").default(4000),
});

export interface CodemodeConfig {
  enable: boolean;
  direct: string[];
  timeoutMs: number;
}

export const CodemodeConfig: Schema<CodemodeConfig> = Schema.object({
  enable: Schema.boolean().default(false),
  direct: Schema.array(Schema.string()).default([]),
  timeoutMs: Schema.number().default(30_000),
});

export interface FailoverConfig {
  attempts?: number;
  backoffMs: number;
  failoverOn: "unavailable" | "any";
}

export const FailoverConfig: Schema<FailoverConfig> = Schema.object({
  attempts: Schema.number(),
  backoffMs: Schema.number().default(500),
  failoverOn: Schema.union(["unavailable", "any"]).default("unavailable"),
});

export type ProfileMode = "channel" | "cross";

/** 编译后的频道名单：include 命中且 exclude 不命中才算认领。 */
export interface ChannelFilter {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export type InstanceDomain =
  | { mode: "channel"; platform: string; selfId: string; channelId: string }
  | { mode: "cross"; channels: ReadonlyMap<string, ChannelFilter> };

export interface ProfileExtensionConfig<T = unknown> {
  enable?: boolean;
  config?: T;
}

export const ProfileExtensionConfig: Schema<ProfileExtensionConfig> = Schema.object({
  enable: Schema.boolean(),
  config: Schema.any(),
});

export interface ProfileSettings {
  model: string;
  failover: FailoverConfig;
  context: ContextConfig;
  wakeup: WakeupConfig;
  toolcall: ToolcallConfig;
  innerThoughts: boolean;
  codemode: CodemodeConfig;
  typing: TypingConfig;
}

export interface ProfileConfig {
  model: string;
  mode: ProfileMode;
  channels?: Record<string, string[]>;
  extends?: Record<string, ProfileExtensionConfig>;
  failover?: FailoverConfig;
  context?: ContextConfig;
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  innerThoughts?: boolean;
  codemode?: CodemodeConfig;
  typing?: TypingConfig;
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  model: Schema.string().required(),
  mode: Schema.union(["channel", "cross"]).default("channel"),
  channels: Schema.dict(Schema.array(Schema.string())),
  extends: Schema.dict(ProfileExtensionConfig),
  failover: FailoverConfig,
  context: ContextConfig,
  wakeup: WakeupConfig,
  toolcall: ToolcallConfig,
  innerThoughts: Schema.boolean(),
  codemode: CodemodeConfig,
  typing: TypingConfig,
});

/** 解析产物：一个 profile 的全部静态信息，装配期只读它。 */
export interface Profile {
  readonly id: string;
  readonly root: string;
  readonly mode: ProfileMode;
  readonly channels: ReadonlyMap<string, ChannelFilter>;
  readonly settings: ProfileSettings;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export function resolveProfile(raw: unknown, id: string, root: string): Profile {
  const config = ProfileConfig(raw as ProfileConfig);
  return {
    id,
    root,
    mode: config.mode,
    channels: compileChannels(id, config.channels ?? {}),
    settings: {
      model: config.model,
      failover: FailoverConfig((config.failover ?? {}) as FailoverConfig),
      // Schema 对缺省段落会给出空对象而非 undefined，这里以 engine 兜底合并。
      context: fillEngine(config.context, "standard"),
      wakeup: fillEngine(config.wakeup, "standard"),
      toolcall: fillEngine(config.toolcall, "native"),
      innerThoughts: config.innerThoughts ?? false,
      codemode: CodemodeConfig((config.codemode ?? {}) as CodemodeConfig),
      typing: TypingConfig((config.typing ?? {}) as TypingConfig),
    },
    extensions: resolveExtensions(config.extends ?? {}),
  };
}

function fillEngine<T extends { engine: string }>(config: T | undefined, engine: string): T {
  return { engine, ...config } as T;
}

function resolveExtensions(extendsConfig: Record<string, ProfileExtensionConfig>): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [name, conf] of Object.entries(extendsConfig)) {
    if (conf.enable === false) continue;
    extensions[name] = conf.config;
  }
  return extensions;
}

function compileChannels(id: string, channels: Record<string, string[]>): ReadonlyMap<string, ChannelFilter> {
  const compiled = new Map<string, ChannelFilter>();
  for (const [sid, patterns] of Object.entries(channels)) {
    if (!sid.includes(":")) throw new Error(`Profile "${id}" has an invalid account id "${sid}", expected "<platform>:<selfId>"`);
    const include: string[] = [];
    const exclude: string[] = [];
    for (const pattern of patterns) {
      if (pattern.startsWith("!")) {
        const body = pattern.slice(1);
        if (body.length === 0) throw new Error(`Profile "${id}" claims "${sid}" with an empty "!" pattern`);
        exclude.push(body);
      } else if (pattern.length > 0) {
        include.push(pattern);
      } else {
        throw new Error(`Profile "${id}" claims "${sid}" with an empty channel pattern`);
      }
    }
    if (include.length === 0) throw new Error(`Profile "${id}" claims "${sid}" without any positive channel pattern`);
    compiled.set(sid, { include, exclude });
  }
  if (compiled.size === 0) throw new Error(`Profile "${id}" claims no accounts, add a "channels" entry`);
  return compiled;
}

export function matchesChannel(filter: ChannelFilter, channelId: string): boolean {
  const matched = (pattern: string): boolean => pattern === "*" || (pattern.endsWith("*") ? channelId.startsWith(pattern.slice(0, -1)) : pattern === channelId);
  return filter.include.some(matched) && !filter.exclude.some(matched);
}

/** 排除项是否把某条正项整个盖掉：`*`、同值，或前缀覆盖（含正项本身是前缀模式）。 */
function excluded(items: readonly string[], pattern: string): boolean {
  return items.some(
    (item) =>
      item === "*" ||
      item === pattern ||
      (item.endsWith("*") && (pattern.startsWith(item.slice(0, -1)) || (pattern.endsWith("*") && pattern.slice(0, -1).startsWith(item.slice(0, -1))))),
  );
}

function intersects(left: string, right: string): boolean {
  return (
    left === "*" ||
    right === "*" ||
    (left.endsWith("*") ? right.startsWith(left.slice(0, -1)) : right.endsWith("*") ? left.startsWith(right.slice(0, -1)) : left === right)
  );
}

/** 两个名单是否有交集：存在同时被双方正项命中的频道，且这个频道没被任一方排除。 */
export function overlaps(left: ChannelFilter, right: ChannelFilter): boolean {
  return left.include.some((pattern) =>
    right.include.some((other) => intersects(pattern, other) && !excluded(left.exclude, other) && !excluded(right.exclude, pattern)),
  );
}

/** runtime key 转目录名：key 以 profile id 开头，剩下的每段做文件名安全化。 */
export function directoryName(key: string): string {
  return key
    .split("/")
    .map((segment) => segment.replace(/[<>:"/\\|?*]/g, "_"))
    .join("/");
}
