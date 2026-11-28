import { h, sleep, type Context } from "koishi";
import { jsonSchema, matchesChannel, tool, type ExtensionHost, type ToolSet } from "koishi-plugin-ishiki";

import { normalizePackName } from "./config.js";
import type { RuntimePacer } from "./frequency.js";
import { validateCandidateBytes } from "./media.js";
import type { StickerReviewer } from "./reviewer.js";
import type { StickerStore } from "./store.js";
import type { PluginConfig, ResolvedPolicy, StickerRecord } from "./types.js";

export interface StickerToolsOptions {
  ctx: Context;
  host: ExtensionHost;
  store: StickerStore;
  reviewer: StickerReviewer;
  pluginConfig: PluginConfig;
  policy: ResolvedPolicy;
  pacer: RuntimePacer;
  onChanged: () => void;
}

interface SearchInput {
  query?: string;
  category?: string;
  character?: string;
  pack?: string;
  includeArtifact?: boolean;
  limit?: number;
}

interface SendInput {
  id?: string;
  query?: string;
  category?: string;
  target?: { sid: string; channelId: string };
}

interface SaveInput {
  url: string;
  character?: string;
  work?: string;
  overlayText?: string;
  note?: string;
}

export function buildStickerElement(bytes: Uint8Array, mime: string, platform: string, onebotAsSticker: boolean): h {
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  if (platform === "onebot" && onebotAsSticker) {
    return h("img", {
      src: dataUri,
      "sub-type": "1",
      summary: "[动画表情]",
    });
  }
  return h("img", { src: dataUri });
}

export function createStickerTools(options: StickerToolsOptions): ToolSet {
  const { ctx, host, store, reviewer, pluginConfig, policy, pacer, onChanged } = options;
  const cross = host.domain.mode === "cross";
  const fallbackChannelKey =
    host.domain.mode === "channel" ? `${host.domain.platform}:${host.domain.selfId}:${host.domain.channelId}` : `${host.runtimeId}:cross`;
  const channelKey = pacer.currentChannelKey(fallbackChannelKey);
  const sendGate = pacer.evaluateSendGate(policy, channelKey);
  const canSave = policy.allowSave && pacer.hasRecentAsset();

  const tools: ToolSet = {};

  if (sendGate.allowed) {
    tools.sticker_search = tool({
      description: "按情绪、场景、台词文字或角色检索可用表情包，返回简短 ID 与描述供 sticker_send 使用；可选生成 artifact:// 供 send_message 混排。",
      inputSchema: jsonSchema<SearchInput>({
        type: "object",
        properties: {
          query: { type: "string", maxLength: 120, description: "情绪、台词、动作或场景关键词" },
          category: { type: "string", maxLength: 48, description: "限定分类名" },
          character: { type: "string", maxLength: 64, description: "限定角色名" },
          pack: { type: "string", maxLength: 48, description: "限定表情包名称" },
          includeArtifact: { type: "boolean", description: "为命中项生成可用于 send_message 的 artifact:// 引用（默认 false）" },
          limit: { type: "integer", minimum: 1, maximum: 16, description: "返回条数（默认 6）" },
        },
        additionalProperties: false,
      }),
      execute: async (input, { abortSignal }) => {
        const targetPacks = resolveSearchPacks(policy.readPacks, input.pack);
        if (targetPacks.length === 0) return { ok: false as const, error: "no_accessible_packs" };
        const emb = input.query ? await reviewer.embedText(policy.embeddingModel, input.query, abortSignal) : undefined;
        const hits = store.search({
          packs: targetPacks,
          query: input.query,
          category: input.category,
          character: input.character,
          limit: input.limit ?? 6,
          queryEmbedding: emb?.vector,
          embeddingModel: emb?.model,
        });

        const items = await Promise.all(
          hits.map(async (hit, index) => {
            const s = hit.sticker;
            let artifactUrl: string | undefined;
            if (input.includeArtifact === true && index < 4) {
              const bytes = store.readBytes(s);
              artifactUrl = await host.resources.store.writeArtifact("sticker", bytes, {
                mediaType: s.mime,
                filename: `${s.id}.${s.ext}`,
              });
            }
            return {
              id: s.id,
              pack: s.pack,
              category: s.category,
              character: s.characterName || undefined,
              ocrText: s.ocrText || undefined,
              description: s.description,
              emotions: s.emotions,
              scenes: s.scenes,
              score: hit.score,
              ...(artifactUrl ? { artifactUrl } : {}),
            };
          }),
        );

        return { ok: true as const, total: items.length, items };
      },
    });

    tools.sticker_send = tool({
      description: cross
        ? "发送一张已收藏的表情包到目标频道。优先传 sticker_search 返回的 id，或传 query/category 由插件挑选贴合语境的表情。"
        : "发送一张已收藏的表情包到当前频道。优先传 sticker_search 返回的 id，或传 query/category 由插件挑选贴合语境的表情。",
      inputSchema: jsonSchema<SendInput>({
        type: "object",
        properties: {
          id: { type: "string", minLength: 4, maxLength: 64, description: "sticker_search 返回的表情 ID" },
          query: { type: "string", maxLength: 120, description: "按情绪、场景或台词自动选图" },
          category: { type: "string", maxLength: 48, description: "按分类随机挑选表情" },
          ...(cross
            ? {
                target: {
                  type: "object" as const,
                  description: "目标频道，从频道头部的 [channel target=...] 原样复制",
                  properties: {
                    sid: { type: "string" as const, minLength: 1 },
                    channelId: { type: "string" as const, minLength: 1 },
                  },
                  required: ["sid", "channelId"],
                  additionalProperties: false,
                },
              }
            : {}),
        },
        additionalProperties: false,
      }),
      execute: async (input, { abortSignal }) => {
        const destination = resolveSendDestination(ctx, host, input.target);
        if (!destination.ok) return destination;

        let sticker: StickerRecord | undefined;
        if (input.id) {
          sticker = store.getByIdOrPrefix(input.id, policy.readPacks);
          if (!sticker || sticker.status !== "active") {
            return { ok: false as const, error: "sticker_not_found" };
          }
        } else {
          const emb = input.query ? await reviewer.embedText(policy.embeddingModel, input.query, abortSignal) : undefined;
          sticker = store.pickForSend({
            packs: policy.readPacks,
            query: input.query,
            category: input.category,
            queryEmbedding: emb?.vector,
            embeddingModel: emb?.model,
          });
          if (!sticker) return { ok: false as const, error: "no_matching_sticker" };
        }

        const budget = pacer.tryConsumeSendBudget(policy, destination.channelKey);
        if (!budget.ok) {
          return { ok: false as const, error: "rate_limited", message: budget.error };
        }

        const bytes = store.readBytes(sticker);
        const element = buildStickerElement(bytes, sticker.mime, destination.platform, policy.onebotAsSticker);
        // Yield briefly so a preceding send_message text bubble lands first ("先文后图").
        await sleep(250);
        const sentIds = await destination.send(element);
        store.markUsed(sticker.id);
        onChanged();

        return {
          ok: true as const,
          id: sticker.id,
          pack: sticker.pack,
          category: sticker.category,
          messageIds: sentIds,
        };
      },
    });
  }

  if (canSave) {
    tools.sticker_save = tool({
      description:
        "收藏聊天消息里的一张表情包图片（传入消息中的 asset://... 地址）。入库前会自动进行图片规格预筛与视觉内容安全审查，并尽量填入已知的角色、作品与图上文字线索。",
      inputSchema: jsonSchema<SaveInput>({
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "消息中的 asset://<id> 图片地址" },
          character: { type: "string", maxLength: 64, description: "已知角色名（例如：小桃）" },
          work: { type: "string", maxLength: 64, description: "已知作品名（例如：示例作品）" },
          overlayText: { type: "string", maxLength: 120, description: "图上配字（已知时填写）" },
          note: { type: "string", maxLength: 120, description: "适用场景或备注" },
        },
        required: ["url"],
        additionalProperties: false,
      }),
      execute: async (input, { abortSignal }) => {
        const cleanUrl = input.url.trim();
        if (!cleanUrl.startsWith("asset://")) {
          return { ok: false as const, error: "invalid_resource_url", reason: "仅支持收藏入站消息里的 asset:// 图片地址" };
        }

        let payload: Awaited<ReturnType<typeof host.resources.resolve>>;
        try {
          payload = await host.resources.resolve(cleanUrl);
        } catch (error) {
          return {
            ok: false as const,
            error: "resource_unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (payload.type !== "file") {
          return { ok: false as const, error: "not_a_file", reason: "目标资源不是图片文件" };
        }

        const check = validateCandidateBytes(payload.bytes, {
          maxFileBytes: pluginConfig.maxFileBytes,
          maxAspectRatio: pluginConfig.maxAspectRatio,
        });
        if (!check.ok) {
          return { ok: false as const, error: check.code, reason: check.reason };
        }

        if (store.isBlacklisted(check.info.sha256)) {
          return { ok: false as const, error: "blacklisted", reason: "该图片在黑名单中，禁止收藏" };
        }

        const existing = store.getBySha256(check.info.sha256);
        if (existing) {
          return {
            ok: true as const,
            status: "duplicate" as const,
            id: existing.id,
            pack: existing.pack,
            category: existing.category,
            message: `图库里已经有这张表情啦（分类：${existing.category}）`,
          };
        }

        if (pluginConfig.maxTotalStickers > 0 && store.countTotal() >= pluginConfig.maxTotalStickers) {
          return { ok: false as const, error: "storage_full", reason: `图库总量已达上限 (${pluginConfig.maxTotalStickers})` };
        }

        const gate = pacer.checkSaveGate(policy, channelKey, cleanUrl);
        if (!gate.allowed) {
          return { ok: false as const, error: "save_gate_blocked", reason: gate.reason };
        }

        pacer.recordReviewAttempt(channelKey);
        const categories = store.listCategories(policy.readPacks, "all").map((item) => item.category);
        const decision = await reviewer.review({
          sha256: check.info.sha256,
          bytes: payload.bytes,
          mime: check.info.mime,
          visionModelRef: policy.visionModel,
          existingCategories: categories,
          facts: {
            character: input.character,
            work: input.work,
            overlayText: input.overlayText,
            note: input.note,
          },
          abortSignal,
        });

        if (!decision.approved) {
          return {
            ok: false as const,
            error: "review_rejected",
            reason: decision.rejectReason,
          };
        }

        const embeddingUpdate = await reviewer.embedStickerFields(
          policy.embeddingModel,
          {
            category: decision.category,
            tags: decision.tags,
            description: decision.description,
            ocrText: decision.ocrText,
            characterName: decision.characterName,
            workName: decision.workName,
            emotions: decision.emotions,
            scenes: decision.scenes,
          },
          abortSignal,
        );

        const sourceInbound = pacer.findInboundByAsset(cleanUrl) ?? pacer.getLatestInbound();
        const saved = store.save({
          sha256: check.info.sha256,
          bytes: payload.bytes,
          mime: check.info.mime,
          ext: check.info.ext,
          width: check.info.width,
          height: check.info.height,
          pack: policy.writePack,
          status: policy.requireApproval ? "pending" : "active",
          category: decision.category,
          tags: decision.tags,
          description: decision.description,
          ocrText: decision.ocrText,
          characterName: decision.characterName,
          workName: decision.workName,
          emotions: decision.emotions,
          scenes: decision.scenes,
          source: {
            kind: "llm",
            platform: sourceInbound?.platform,
            channelId: sourceInbound?.channelId,
            userId: sourceInbound?.user.id,
            messageId: sourceInbound?.messageId,
            note: input.note,
          },
          embeddingModel: embeddingUpdate?.model ?? null,
          embedding: embeddingUpdate?.vector ?? null,
        });

        if (saved.status === "created" && gate.autonomous) {
          pacer.recordAutonomousSave(channelKey);
        }
        onChanged();

        return {
          ok: true as const,
          status: saved.status,
          approvalStatus: saved.sticker.status,
          id: saved.sticker.id,
          pack: saved.sticker.pack,
          category: saved.sticker.category,
          character: saved.sticker.characterName || undefined,
          description: saved.sticker.description,
        };
      },
    });
  }

  return tools;
}

export function buildStickerInstructions(store: StickerStore, policy: ResolvedPolicy, pacer: RuntimePacer, fallbackChannelKey: string): string {
  const channelKey = pacer.currentChannelKey(fallbackChannelKey);
  const sendGate = pacer.evaluateSendGate(policy, channelKey);
  const canSave = policy.allowSave && pacer.hasRecentAsset();

  if (!sendGate.allowed && !canSave) return "";

  const lines: string[] = [];
  if (sendGate.allowed) {
    const categories = store.listCategories(policy.readPacks, "active").slice(0, 12);
    const summary = categories.length > 0 ? categories.map((item) => `${item.category}(${item.count})`).join("、") : "暂无可用表情";
    lines.push(
      `表情包发图：当聊天氛围适合吐槽、卖萌、接梗或纯发表情回应时，可先用 sticker_search 查询（可用分类：${summary}），再用 sticker_send 发送。每轮最多发 ${policy.maxSendPerTurn} 张，严肃或需认真解答时不必硬发表情。`,
    );
  }
  if (canSave) {
    lines.push(
      "表情包收藏：仅当群友明确要求保存、或发现非常贴合人设的优质表情包时，才调用 sticker_save(url='asset://...') 收藏；若知道角色或作品名请一并填入 character/work。",
    );
  }
  return lines.join("\n");
}

function resolveSearchPacks(allowedPacks: string[], requested?: string): string[] {
  if (!requested || requested.trim().length === 0) return allowedPacks;
  const clean = normalizePackName(requested, "");
  return allowedPacks.includes(clean) ? [clean] : [];
}

function resolveSendDestination(
  ctx: Context,
  host: ExtensionHost,
  target: SendInput["target"],
): { ok: true; platform: string; channelKey: string; send: (fragment: h.Fragment) => Promise<string[]> } | { ok: false; error: string; reason: string } {
  if (host.domain.mode === "channel") {
    const sid = `${host.domain.platform}:${host.domain.selfId}`;
    const bot = ctx.bots[sid];
    if (!bot) return { ok: false, error: "bot_unavailable", reason: `机器人 ${sid} 未连接` };
    const channelId = host.domain.channelId;
    return {
      ok: true,
      platform: host.domain.platform,
      channelKey: `${sid}:${channelId}`,
      send: (fragment) => bot.sendMessage(channelId, fragment),
    };
  }

  if (!target || !target.sid || !target.channelId) {
    return { ok: false, error: "missing_target", reason: "cross 模式必须传入目标 target: { sid, channelId }" };
  }
  const filter = host.domain.channels.get(target.sid);
  if (!filter || !matchesChannel(filter, target.channelId)) {
    return { ok: false, error: "target_out_of_domain", reason: "目标频道不在当前 profile 认领范围内" };
  }
  const bot = ctx.bots[target.sid];
  if (!bot) return { ok: false, error: "bot_unavailable", reason: `机器人 ${target.sid} 未连接` };
  const platform = target.sid.split(":")[0] ?? "unknown";
  return {
    ok: true,
    platform,
    channelKey: `${target.sid}:${target.channelId}`,
    send: (fragment) => bot.sendMessage(target.channelId, fragment),
  };
}
