import { h, type Context, type Session } from "koishi";

import { normalizePackName, resolveImportRoots } from "./config.js";
import { importFromDirectory } from "./importer.js";
import { validateCandidateBytes } from "./media.js";
import type { ReviewQueue, StickerReviewer } from "./reviewer.js";
import type { StickerStore } from "./store.js";
import { buildStickerElement } from "./tools.js";
import type { PluginConfig } from "./types.js";

const COMMAND_SEND_COOLDOWN_MS = 10_000;

export interface CommandsOptions {
  ctx: Context;
  store: StickerStore;
  reviewer: StickerReviewer;
  queue: ReviewQueue;
  pluginConfig: PluginConfig;
  onChanged: () => void;
}

export function registerStickerCommands(options: CommandsOptions): () => void {
  const { ctx, store, reviewer, queue, pluginConfig, onChanged } = options;
  const auth = pluginConfig.commands.authority;
  const readAuth = pluginConfig.commands.readAuthority ?? 2;
  const importAuth = Math.max(4, auth);
  const lastCommandSend = new Map<string, number>();

  const resolveAllowedPacks = (requested?: string): string[] => {
    const configured = (pluginConfig.commands.allowedPacks ?? []).map((p) => normalizePackName(p, "")).filter((p) => p.length > 0);
    if (requested?.trim()) {
      const clean = normalizePackName(requested, "");
      if (!clean) return [];
      if (configured.length > 0 && !configured.includes(clean)) return [];
      return [clean];
    }
    if (configured.length > 0) return configured;
    const all = store.listPacks().map((p) => p.pack);
    return all.length > 0 ? all : ["default"];
  };

  const cmd = ctx.command("sticker", "表情包图库管理");

  const subStatus = cmd.subcommand(".status", "查看表情包图库统计", { authority: readAuth }).action(() => {
    const overview = store.overview(null, queue.snapshot());
    const allowed = new Set((pluginConfig.commands.allowedPacks ?? []).map((p) => normalizePackName(p, "")).filter((p) => p.length > 0));
    const visiblePacks = allowed.size > 0 ? overview.packs.filter((p) => allowed.has(p.pack)) : overview.packs;
    const packLines = visiblePacks.map((p) => `- ${p.pack}: ${p.activeCount} 可用 / ${p.pendingCount} 待审`).join("\n") || "- 暂无表情包";
    return [
      `表情图库状态：可用 ${overview.totalActive}，待审 ${overview.totalPending}，黑名单 ${overview.totalBanned}`,
      `识别队列：排队 ${overview.queue.pending}，进行中 ${overview.queue.running}，已完成 ${overview.queue.completed}，失败 ${overview.queue.failed}`,
      packLines,
    ].join("\n");
  });

  const subSearch = cmd
    .subcommand(".search <query:text>", "按关键词搜索表情包", { authority: readAuth })
    .option("pack", "-p <pack:string> 限定包名")
    .action(({ options: cmdOpts }, query) => {
      if (!query?.trim()) return "请输入搜索关键词。";
      const packs = resolveAllowedPacks(cmdOpts?.pack);
      if (packs.length === 0) return "目标表情包不在允许范围内。";
      const hits = store.search({ packs, query, limit: 8 });
      if (hits.length === 0) return "未找到匹配的表情包。";
      return hits
        .map(
          (hit, idx) =>
            `${idx + 1}. [${hit.sticker.id}] (${hit.sticker.pack}/${hit.sticker.category}) ${hit.sticker.characterName ? `[${hit.sticker.characterName}] ` : ""}${hit.sticker.description || hit.sticker.ocrText || "无描述"}`,
        )
        .join("\n");
    });

  const subSend = cmd
    .subcommand(".send <idOrQuery:text>", "发送指定 ID 或关键词的表情包", { authority: readAuth })
    .option("pack", "-p <pack:string> 限定包名")
    .action(async ({ session, options: cmdOpts }, idOrQuery) => {
      if (!session || !idOrQuery?.trim()) return "请提供表情 ID 或搜索词。";
      const packs = resolveAllowedPacks(cmdOpts?.pack);
      if (packs.length === 0) return "目标表情包不在允许范围内。";
      const channelKey = `${session.platform}:${session.selfId}:${session.channelId}`;
      const now = Date.now();
      const prev = lastCommandSend.get(channelKey) ?? 0;
      if (now - prev < COMMAND_SEND_COOLDOWN_MS) return "发送冷却中，请稍后再试。";

      const target = store.getByIdOrPrefix(idOrQuery.trim(), packs) ?? store.pickForSend({ packs, query: idOrQuery.trim() });
      if (!target || target.status !== "active") return "未找到可用的匹配表情包。";
      lastCommandSend.set(channelKey, now);
      if (lastCommandSend.size > 500) {
        const oldest = lastCommandSend.keys().next().value;
        if (oldest !== undefined) lastCommandSend.delete(oldest);
      }
      const bytes = store.readBytes(target);
      store.markUsed(target.id);
      onChanged();
      return buildStickerElement(bytes, target.mime, session.platform, true);
    });

  const subSave = cmd
    .subcommand(".save [note:text]", "管理员手动收藏当前或引用消息里的表情包", { authority: auth })
    .option("pack", "-p <pack:string> 目标包名")
    .option("character", "-c <character:string> 角色名")
    .option("work", "-w <work:string> 作品名")
    .action(async ({ session, options: cmdOpts }, note) => {
      if (!session) return "缺少会话上下文。";
      const imageUrls = extractSessionImageUrls(session).filter((u) => /^https?:\/\/|^data:image\//i.test(u));
      if (imageUrls.length === 0) return "请在消息中附带图片，或引用包含图片的消息后再执行。";

      const pack = normalizePackName(cmdOpts?.pack, "default");
      let created = 0;
      let duplicated = 0;
      const rejected: string[] = [];

      for (const url of imageUrls.slice(0, 4)) {
        try {
          const file = await ctx.http.file(url, { timeout: 15_000 });
          const bytes = new Uint8Array(file.data);
          const check = validateCandidateBytes(bytes, {
            maxFileBytes: pluginConfig.maxFileBytes,
            maxAspectRatio: pluginConfig.maxAspectRatio,
          });
          if (!check.ok) {
            rejected.push(check.reason);
            continue;
          }
          if (store.isBlacklisted(check.info.sha256)) {
            rejected.push("该图片在黑名单中");
            continue;
          }
          const existing = store.getBySha256(check.info.sha256);
          if (existing) {
            duplicated += 1;
            continue;
          }

          let category = "未分类";
          let tags: string[] = [];
          let description = note?.trim() ?? "";
          let ocrText = "";
          let characterName = cmdOpts?.character?.trim() ?? "";
          let workName = cmdOpts?.work?.trim() ?? "";
          let emotions: string[] = [];
          let scenes: string[] = [];

          const visionRef = reviewer.resolveVisionModelRef(pluginConfig.defaultVisionModel);
          if (visionRef) {
            const decision = await reviewer.review({
              sha256: check.info.sha256,
              bytes,
              mime: check.info.mime,
              visionModelRef: visionRef,
              existingCategories: store.listCategories([pack], "all").map((item) => item.category),
              facts: {
                character: characterName || undefined,
                work: workName || undefined,
                note: note?.trim() || undefined,
              },
            });
            if (!decision.approved) {
              rejected.push(decision.rejectReason);
              continue;
            }
            category = decision.category;
            tags = decision.tags;
            description = decision.description;
            ocrText = decision.ocrText;
            characterName = decision.characterName;
            workName = decision.workName;
            emotions = decision.emotions;
            scenes = decision.scenes;
          }

          const emb = await reviewer.embedStickerFields(pluginConfig.defaultEmbeddingModel, {
            category,
            tags,
            description,
            ocrText,
            characterName,
            workName,
            emotions,
            scenes,
          });

          const saved = store.save({
            sha256: check.info.sha256,
            bytes,
            mime: check.info.mime,
            ext: check.info.ext,
            width: check.info.width,
            height: check.info.height,
            pack,
            status: pluginConfig.requireApproval ? "pending" : "active",
            category,
            tags,
            description,
            ocrText,
            characterName,
            workName,
            emotions,
            scenes,
            source: {
              kind: "command",
              platform: session.platform,
              channelId: session.channelId,
              userId: session.userId,
              messageId: session.messageId,
              note: note?.trim(),
            },
            embeddingModel: emb?.model ?? null,
            embedding: emb?.vector ?? null,
          });
          if (saved.status === "created") created += 1;
          else duplicated += 1;
        } catch (error) {
          rejected.push(error instanceof Error ? error.message : String(error));
        }
      }

      onChanged();
      return [`收藏完成（包：${pack}）：新增 ${created}，重复跳过 ${duplicated}`, ...(rejected.length > 0 ? [`拦截/失败：${rejected.join("；")}`] : [])].join(
        "\n",
      );
    });

  const subApprove = cmd.subcommand(".approve <id:string>", "通过待审核表情包", { authority: auth }).action((_, id) => {
    if (!id) return "请提供表情 ID。";
    const updated = store.update(id, { status: "active" });
    if (!updated) return `未找到表情 ${id}`;
    onChanged();
    return `已通过表情 ${updated.id}（${updated.pack}/${updated.category}）`;
  });

  const subDelete = cmd.subcommand(".delete <id:string>", "删除表情包", { authority: auth }).action((_, id) => {
    if (!id) return "请提供表情 ID。";
    const ok = store.delete(id);
    if (!ok) return `未找到表情 ${id}`;
    onChanged();
    return `已删除表情 ${id}`;
  });

  const subBan = cmd.subcommand(".ban <id:string> [reason:text]", "删除表情包并加入黑名单", { authority: auth }).action((_, id, reason) => {
    if (!id) return "请提供表情 ID。";
    const ok = store.ban(id, reason?.trim() || "command_ban");
    if (!ok) return `未找到表情 ${id}`;
    onChanged();
    return `已删除并拉黑表情 ${id}`;
  });

  const subImport = cmd
    .subcommand(".import <dirPath:text>", "从服务器本地目录批量导入表情包", { authority: importAuth })
    .option("pack", "-p <pack:string> 目标包名")
    .option("tag", "--tag 导入后自动加入 VLM 识别打标队列")
    .action(async ({ options: cmdOpts }, dirPath) => {
      if (!dirPath?.trim()) return "请提供要导入的本地目录路径。";
      const summary = await importFromDirectory(store, pluginConfig, reviewer, queue, {
        dirPath: dirPath.trim(),
        pack: cmdOpts?.pack,
        autoTag: Boolean(cmdOpts?.tag),
        allowedRoots: resolveImportRoots(ctx.baseDir, pluginConfig.importRoots),
      });
      onChanged();
      return `目录导入完成：扫描 ${summary.scanned}，新增 ${summary.imported}，重复 ${summary.duplicate}，拒绝/失败 ${summary.rejected}，已入识别队列 ${summary.queuedForReview}`;
    });

  return () => {
    subImport.dispose();
    subBan.dispose();
    subDelete.dispose();
    subApprove.dispose();
    subSave.dispose();
    subSend.dispose();
    subSearch.dispose();
    subStatus.dispose();
    cmd.dispose();
  };
}

function extractSessionImageUrls(session: Session): string[] {
  const urls: string[] = [];
  const collect = (elements: h[] | undefined) => {
    if (!elements) return;
    for (const element of elements) {
      if ((element.type === "img" || element.type === "image" || element.type === "mface") && typeof element.attrs.src === "string") {
        urls.push(element.attrs.src);
      } else if (typeof element.attrs.url === "string" && (element.type === "img" || element.type === "mface")) {
        urls.push(element.attrs.url);
      }
      if (element.children.length > 0) collect(element.children);
    }
  };
  collect(session.elements);
  if (session.quote?.elements) collect(session.quote.elements);
  else if (typeof session.quote?.content === "string") collect(h.parse(session.quote.content));
  return [...new Set(urls)];
}
