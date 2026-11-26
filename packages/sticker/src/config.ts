import path from "node:path";

import { Logger, Schema, type Context } from "koishi";

import type { PluginConfig, ProfileConfig, ResolvedPolicy } from "./types.js";

export const pluginConfigSchema: Schema<PluginConfig> = Schema.object({
  dataDir: Schema.string().role("path").description("表情包数据目录；留空时默认使用 Ishiki 数据目录下的 stickers 子目录").default(""),
  importRoots: Schema.array(Schema.string().role("path"))
    .description("允许通过指令或控制台执行目录导入的根目录白名单；留空时仅允许当前实例 data 目录")
    .default([]),
  defaultVisionModel: Schema.string().description("默认视觉审查与打标模型（provider:modelId 或模型组名）").default(""),
  defaultEmbeddingModel: Schema.string().description("可选默认向量模型（provider:modelId）；留空仅使用本地 SQLite FTS5 检索").default(""),
  requireApproval: Schema.boolean().description("新收藏的表情是否先进入待审核池（false = VLM 审查通过后直接可用）").default(false),
  maxFileBytes: Schema.number()
    .min(64 * 1024)
    .description("单张表情图片最大字节数")
    .default(8 * 1024 * 1024),
  maxAspectRatio: Schema.number().min(1.2).max(10).description("允许的最大宽高比（超过通常为手机长截图，直接拦截）").default(2.6),
  maxTotalStickers: Schema.number().min(0).description("图库总量上限（0 表示不限）").default(2000),
  reviewConcurrency: Schema.number().min(1).max(8).description("后台批量 VLM 识别并发数").default(2),
  reviewRpm: Schema.number().min(1).max(300).description("后台批量 VLM 识别每分钟请求上限").default(20),
  commands: Schema.object({
    enable: Schema.boolean().description("注册 Koishi 表情管理指令").default(true),
    authority: Schema.number().min(1).description("写操作指令所需的最低 Koishi 权限等级").default(3),
    readAuthority: Schema.number().min(1).description("查询与发送指令（sticker.status/search/send）所需的最低 Koishi 权限等级").default(2),
    allowedPacks: Schema.array(Schema.string()).description("指令允许检索/发送的包名列表；留空表示允许全部包").default([]),
  })
    .description("Koishi 指令设置")
    .default({ enable: true, authority: 3, readAuthority: 2, allowedPacks: [] }),
  logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
});

export const profileConfigSchema: Schema<ProfileConfig> = Schema.object({
  readPacks: Schema.array(Schema.string()).description("该人格允许检索与发送的表情包名称列表").default(["default"]),
  writePack: Schema.string().description("该人格新收藏表情默认写入的包名").default("default"),
  allowSave: Schema.boolean().description("允许模型在对话中收藏表情包").default(true),
  allowSend: Schema.boolean().description("允许模型在对话中发送表情包").default(true),
  requireApproval: Schema.boolean().description("覆盖全局待审核开关；留空跟随插件默认配置"),
  visionModel: Schema.string().description("覆盖全局视觉模型（provider:modelId 或模型组名）"),
  embeddingModel: Schema.string().description("覆盖全局向量模型（provider:modelId）"),
  sendChance: Schema.number().min(0).max(1).description("普通文字对话开放发表情工具的概率窗口（0~1）").default(0.35),
  exemptStickerReply: Schema.boolean().description("对方发图或主动斗图时是否豁免 sendChance 概率限制（仍受频道冷却与单轮上限约束）").default(true),
  sendCooldownSeconds: Schema.number().min(0).description("同一频道连续发表情的最短冷却秒数").default(60),
  maxSendPerTurn: Schema.number().min(1).max(5).description("单轮对话最多允许发送的表情数量").default(1),
  onebotAsSticker: Schema.boolean().description("OneBot 平台发送时是否附带动画表情属性（sub-type=1）").default(true),
  autonomousDailyLimit: Schema.number().min(0).description("单频道每日允许模型主动偷图的次数上限（0 = 禁止自主偷图）").default(5),
  autonomousCooldownMinutes: Schema.number().min(0).description("单频道模型主动偷图的最小间隔分钟数").default(60),
  dailyReviewLimit: Schema.number().min(1).description("单频道每日送审表情上限（含被拒图片，防止刷爆 VLM）").default(30),
});

export function resolveDataDir(ctx: Context, configured: string): string {
  const trimmed = configured.trim();
  if (trimmed.length > 0) return path.resolve(ctx.baseDir, trimmed);
  const ishikiDataPath = ctx.ishiki?.dataPath ?? path.resolve(ctx.baseDir, "data", "ishiki");
  return path.resolve(ishikiDataPath, "stickers");
}

export function resolveImportRoots(baseDir: string, configured?: readonly string[]): string[] {
  const custom = (configured ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (custom.length > 0) return custom.map((item) => path.resolve(baseDir, item));
  return [path.resolve(baseDir, "data")];
}

export function normalizePackName(value: string | undefined, fallback = "default"): string {
  const cleaned = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : fallback;
}

export function resolvePolicy(plugin: PluginConfig, profile: Partial<ProfileConfig>): ResolvedPolicy {
  const writePack = normalizePackName(profile.writePack, "default");
  const rawReads = Array.isArray(profile.readPacks) ? profile.readPacks.map((item) => normalizePackName(item, "")).filter((item) => item.length > 0) : [];
  const readPacks = rawReads.length > 0 ? [...new Set(rawReads)] : [writePack];

  return {
    readPacks,
    writePack,
    allowSave: profile.allowSave ?? true,
    allowSend: profile.allowSend ?? true,
    requireApproval: profile.requireApproval ?? plugin.requireApproval,
    visionModel: (profile.visionModel ?? plugin.defaultVisionModel).trim(),
    embeddingModel: (profile.embeddingModel ?? plugin.defaultEmbeddingModel).trim(),
    sendChance: clampNumber(profile.sendChance ?? 0.35, 0, 1),
    exemptStickerReply: profile.exemptStickerReply ?? true,
    sendCooldownSeconds: Math.max(0, profile.sendCooldownSeconds ?? 60),
    maxSendPerTurn: Math.max(1, Math.min(5, Math.trunc(profile.maxSendPerTurn ?? 1))),
    onebotAsSticker: profile.onebotAsSticker ?? true,
    autonomousDailyLimit: Math.max(0, Math.trunc(profile.autonomousDailyLimit ?? 5)),
    autonomousCooldownMinutes: Math.max(0, profile.autonomousCooldownMinutes ?? 60),
    dailyReviewLimit: Math.max(1, Math.trunc(profile.dailyReviewLimit ?? 30)),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
