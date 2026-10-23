import Schema from "schemastery";

import { ContextEngines } from "../context/index.js";
import { AttachmentConfig } from "../resource/config.js";
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
  memoryLimitBytes: number;
  maxOutputTokens: number;
}

export const CodemodeConfig: Schema<CodemodeConfig> = Schema.object({
  enable: Schema.boolean().description("启用代码模式沙箱").default(true),
  direct: Schema.array(Schema.string()).description("直接暴露给脚本的宿主工具名称").default([]),
  timeoutMs: Schema.number().min(1).description("单次执行的超时时间（毫秒），脚本里的 @options 可以覆盖").default(30_000),
  memoryLimitBytes: Schema.number()
    .min(1)
    .description("沙箱内存上限（字节），创建时固定")
    .default(256 * 1024 * 1024),
  maxOutputTokens: Schema.number().min(0).description("工具结果里 RESULT/TEXT/CONSOLE 预览的字符预算（按每 token 4 字符折算），0 表示省略预览").default(10_000),
});

export interface PacingConfig {
  /** 一轮允许的步数上限，也是 core 的硬上限。 */
  maxSteps: number;
  /** 剩余步数不多于这个值时，每一步都提醒收尾；0 关闭。 */
  wrapUpSteps: number;
  /** 走到第几步时提醒汇报一次进度；0 关闭。 */
  progressAt: number;
}

export const PacingConfig: Schema<PacingConfig> = Schema.object({
  maxSteps: Schema.number().min(1).description("一轮允许的步数上限").default(20),
  wrapUpSteps: Schema.number().min(0).description("剩余步数不多于该值时，每一步都提醒收尾；0 表示关闭").default(2),
  progressAt: Schema.number().min(0).description("走到该步数时提醒汇报进度；0 表示关闭").default(8),
});

export interface FailoverConfig {
  attempts?: number;
  backoffMs: number;
  failoverOn: "unavailable" | "any";
}

export const FailoverConfig: Schema<FailoverConfig> = Schema.object({
  attempts: Schema.number().min(1).description("最多尝试次数，留空表示只调用一次"),
  backoffMs: Schema.number().min(0).description("每次重试前的等待时间（毫秒）").default(500),
  failoverOn: Schema.union(["unavailable", "any"]).description("仅在模型不可用时切换，或对任何错误都切换").default("unavailable"),
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
  instructions: string[];
  failover: FailoverConfig;
  context: ContextConfig;
  wakeup: WakeupConfig;
  toolcall: ToolcallConfig;
  codemode: CodemodeConfig;
  pacing: PacingConfig;
  typing: TypingConfig;
  attachment: AttachmentConfig;
}

export interface ProfileConfig {
  model: string;
  instructions?: string[];
  mode: ProfileMode;
  channels?: Record<string, string[]>;
  extends?: Record<string, ProfileExtensionConfig>;
  failover?: FailoverConfig;
  context?: ContextConfig;
  wakeup?: WakeupConfig;
  toolcall?: ToolcallConfig;
  codemode?: CodemodeConfig;
  pacing?: PacingConfig;
  typing?: TypingConfig;
  attachment?: AttachmentConfig;
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  model: Schema.string().required().role("model").description("模型或模型组引用，Profile 的输入会发送到这里"),
  instructions: Schema.array(Schema.string()).description("按顺序读取的指令文件，路径相对于 Profile 目录").default(["PERSONA.md"]),
  mode: Schema.union(["channel", "cross"]).description("channel 为每个频道创建独立实例，cross 在一个实例里汇合多个频道").default("channel"),
  channels: Schema.dict(Schema.array(Schema.string())).description("频道认领表，键为 platform:selfId，值为 include/exclude 模式"),
  extends: Schema.dict(ProfileExtensionConfig).description("扩展配置，键为扩展名称"),
  failover: FailoverConfig.description("模型失败时的重试与切换策略"),
  context: ContextConfig.description("上下文引擎"),
  wakeup: WakeupConfig.description("唤醒引擎"),
  toolcall: Schema.union([ToolcallConfig, Schema.any()]).description("工具调用引擎"),
  codemode: CodemodeConfig.description("代码模式沙箱"),
  pacing: PacingConfig.description("轮次步数节奏"),
  typing: TypingConfig.description("消息打字模拟"),
  attachment: AttachmentConfig.description("附件与图片处理"),
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

/** 已删除的配置项必须报错，不能悄悄忽略：旧 profile 里的它们代表一整套旧运行时语义。 */
function assertSupportedFields(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const config = raw as Record<string, unknown>;
  const attachment = config.attachment;
  if (typeof attachment === "object" && attachment !== null && "maxImageRenders" in attachment) {
    throw new Error("attachment.maxImageRenders was removed; use image lifetimes (once, recent, retain) and attachment.recentImageCount/imagePruneBatchSize");
  }
  if ("toolsearch" in config) {
    throw new Error("toolsearch was removed; codemode scripts search host tools with the searchTools/describeTool globals, delete the toolsearch section");
  }
  const codemode = config.codemode;
  if (typeof codemode === "object" && codemode !== null) {
    const removed = ["maxToolInputBytes", "maxToolOutputBytes", "maxResultBytes"].filter((key) => key in codemode);
    if (removed.length > 0) {
      throw new Error(`codemode.${removed.join("/")} were removed; use codemode.timeoutMs, codemode.memoryLimitBytes and codemode.maxOutputTokens`);
    }
  }
}

export function resolveProfile(raw: unknown, id: string, root: string): Profile {
  assertSupportedFields(raw);
  const config = ProfileConfig(raw as ProfileConfig);
  return {
    id,
    root,
    mode: config.mode,
    channels: compileChannels(id, config.channels ?? {}),
    settings: {
      model: config.model,
      instructions: config.instructions ?? ["PERSONA.md"],
      failover: FailoverConfig((config.failover ?? {}) as FailoverConfig),
      // Schema 对缺省段落会给出空对象而非 undefined，这里以 engine 兜底合并。
      context: fillEngine(config.context, "standard"),
      wakeup: fillEngine(config.wakeup, "standard"),
      toolcall: fillEngine(config.toolcall, "native"),
      codemode: CodemodeConfig((config.codemode ?? {}) as CodemodeConfig),
      pacing: PacingConfig((config.pacing ?? {}) as PacingConfig),
      typing: TypingConfig((config.typing ?? {}) as TypingConfig),
      attachment: AttachmentConfig((config.attachment ?? {}) as AttachmentConfig),
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

/** runtime key 转目录名：key 以 profile id 开头，剩下的每段做文件名安全化后用下划线连接成单层目录。 */
export function directoryName(key: string): string {
  return key
    .split("/")
    .map((segment) => segment.replace(/[<>:"/\\|?*]/g, "_"))
    .join("_");
}
