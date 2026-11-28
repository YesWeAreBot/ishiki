import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {} from "@koishijs/console";
import type {} from "@koishijs/plugin-server";
import type { Context } from "koishi";

import { normalizePackName, resolveImportRoots } from "./config.js";
import { importFromDirectory, type DirectoryImportResult } from "./importer.js";
import { validateCandidateBytes } from "./media.js";
import { isTransientReviewFailure, type ReviewQueue, type StickerReviewer } from "./reviewer.js";
import type { StickerStore } from "./store.js";
import type {
  BlacklistRecord,
  PluginConfig,
  ReviewQueueSnapshot,
  StickerListQuery,
  StickerListResult,
  StickerOverview,
  StickerRecord,
  StickerUpdatePatch,
} from "./types.js";

const READ = 1;
const WRITE = 3;
const ADMIN = 4;

const moduleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export type ConsoleResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export interface UploadItemInput {
  name: string;
  dataBase64: string;
}

export interface UploadRequest {
  pack?: string;
  files: UploadItemInput[];
  autoTag?: boolean;
  character?: string;
  work?: string;
}

export interface UploadResponse {
  created: number;
  duplicate: number;
  rejected: number;
  queued: number;
  errors: string[];
}

export interface BatchRequest {
  action: "approve" | "delete" | "ban" | "movePack" | "setCategory";
  ids: string[];
  value?: string;
}

declare module "@koishijs/console" {
  interface Events {
    "ishiki-sticker/overview": () => Promise<ConsoleResult<StickerOverview>>;
    "ishiki-sticker/list": (query: StickerListQuery) => Promise<ConsoleResult<StickerListResult>>;
    "ishiki-sticker/data-url": (sha256: string) => Promise<ConsoleResult<string>>;
    "ishiki-sticker/update": (id: string, patch: StickerUpdatePatch) => Promise<ConsoleResult<StickerRecord>>;
    "ishiki-sticker/batch": (req: BatchRequest) => Promise<ConsoleResult<{ affected: number }>>;
    "ishiki-sticker/upload": (req: UploadRequest) => Promise<ConsoleResult<UploadResponse>>;
    "ishiki-sticker/retag": (ids: string[]) => Promise<ConsoleResult<{ queued: number }>>;
    "ishiki-sticker/queue/cancel": () => Promise<ConsoleResult<{ cancelled: number }>>;
    "ishiki-sticker/import-dir": (req: { dirPath: string; pack?: string; autoTag?: boolean }) => Promise<ConsoleResult<DirectoryImportResult>>;
    "ishiki-sticker/blacklist/list": () => Promise<ConsoleResult<BlacklistRecord[]>>;
    "ishiki-sticker/blacklist/remove": (sha256: string) => Promise<ConsoleResult<{ removed: boolean }>>;
  }
}

export interface ConsoleDeps {
  store: StickerStore;
  reviewer: StickerReviewer;
  queue: ReviewQueue;
  pluginConfig: PluginConfig;
}

export interface ConsoleController {
  notifyChanged(): void;
  notifyQueue(snapshot: ReviewQueueSnapshot): void;
  mediaBasePath(): string | null;
}

async function run<T>(task: () => T | Promise<T>): Promise<ConsoleResult<T>> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function installStickerConsole(ctx: Context, deps: ConsoleDeps): ConsoleController {
  const { store, reviewer, queue, pluginConfig } = deps;
  const bootToken = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const routePrefix = `/ishiki-sticker/${bootToken}/files`;
  let serverReady = false;

  ctx.inject(["server"], (serverCtx) => {
    const server = serverCtx.server;
    if (!server) return;
    server.get(`${routePrefix}/:sha256`, (koa) => {
      const sha256 = koa.params.sha256;
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
        koa.status = 400;
        koa.body = "invalid sha256";
        return;
      }
      const media = store.readBytesBySha(sha256);
      if (!media) {
        koa.status = 404;
        koa.body = "not found";
        return;
      }
      koa.set("Content-Type", media.mime);
      koa.set("Content-Length", String(media.bytes.byteLength));
      koa.set("Cache-Control", "private, max-age=86400, immutable");
      koa.set("X-Content-Type-Options", "nosniff");
      koa.body = Buffer.from(media.bytes);
    });
    serverReady = true;
    serverCtx.on("dispose", () => {
      serverReady = false;
    });
  });

  const mediaBasePath = () => (serverReady ? routePrefix : null);

  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const notifyChanged = () => {
    if (notifyTimer !== undefined) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      ctx.get("console")?.broadcast("ishiki-sticker/changed", {}, { authority: READ });
    }, 150);
  };
  ctx.on("dispose", () => {
    if (notifyTimer !== undefined) {
      clearTimeout(notifyTimer);
      notifyTimer = undefined;
    }
  });

  const notifyQueue = (snapshot: ReviewQueueSnapshot) => {
    ctx.get("console")?.broadcast("ishiki-sticker/queue", snapshot, { authority: READ });
  };

  ctx.inject(["console"], (consoleCtx) => {
    const consoleService = consoleCtx.console;

    consoleService.addListener("ishiki-sticker/overview", () => run(() => store.overview(mediaBasePath(), queue.snapshot())), { authority: READ });

    consoleService.addListener("ishiki-sticker/list", (query) => run(() => store.list(query ?? {})), { authority: READ });

    consoleService.addListener(
      "ishiki-sticker/data-url",
      (sha256) =>
        run(() => {
          if (typeof sha256 !== "string" || !sha256.trim()) throw new Error("无效的文件哈希");
          const media = store.readBytesBySha(sha256);
          if (!media) throw new Error("文件不存在");
          return `data:${media.mime};base64,${Buffer.from(media.bytes).toString("base64")}`;
        }),
      { authority: READ },
    );

    consoleService.addListener(
      "ishiki-sticker/update",
      (id, patch) =>
        run(async () => {
          if (typeof id !== "string" || !patch || typeof patch !== "object") {
            throw new Error("无效的更新参数");
          }
          const current = store.getByIdOrPrefix(id);
          if (!current) throw new Error(`未找到表情 ${id}`);
          if (patch.status !== undefined && patch.status !== "active" && patch.status !== "pending") {
            throw new Error(`无效的状态值: ${String(patch.status)}`);
          }
          const safePatch: StickerUpdatePatch = {
            pack: typeof patch.pack === "string" ? patch.pack : undefined,
            status: patch.status,
            category: typeof patch.category === "string" ? patch.category : undefined,
            description: typeof patch.description === "string" ? patch.description : undefined,
            ocrText: typeof patch.ocrText === "string" ? patch.ocrText : undefined,
            characterName: typeof patch.characterName === "string" ? patch.characterName : undefined,
            workName: typeof patch.workName === "string" ? patch.workName : undefined,
            tags: Array.isArray(patch.tags) ? patch.tags.filter((t): t is string => typeof t === "string") : undefined,
            emotions: Array.isArray(patch.emotions) ? patch.emotions.filter((t): t is string => typeof t === "string") : undefined,
            scenes: Array.isArray(patch.scenes) ? patch.scenes.filter((t): t is string => typeof t === "string") : undefined,
          };
          const textChanged =
            safePatch.category !== undefined ||
            safePatch.tags !== undefined ||
            safePatch.description !== undefined ||
            safePatch.ocrText !== undefined ||
            safePatch.characterName !== undefined ||
            safePatch.workName !== undefined ||
            safePatch.emotions !== undefined ||
            safePatch.scenes !== undefined;

          let embeddingUpdate: { model: string | null; vector: Float32Array | null } | undefined;
          if (textChanged) {
            const merged = {
              category: safePatch.category ?? current.category,
              tags: safePatch.tags ?? current.tags,
              description: safePatch.description ?? current.description,
              ocrText: safePatch.ocrText ?? current.ocrText,
              characterName: safePatch.characterName ?? current.characterName,
              workName: safePatch.workName ?? current.workName,
              emotions: safePatch.emotions ?? current.emotions,
              scenes: safePatch.scenes ?? current.scenes,
            };
            const emb = await reviewer.embedStickerFields(pluginConfig.defaultEmbeddingModel, merged);
            embeddingUpdate = emb ? { model: emb.model, vector: emb.vector } : { model: null, vector: null };
          }

          const updated = store.update(current.id, safePatch, embeddingUpdate);
          if (!updated) throw new Error(`更新失败 ${id}`);
          notifyChanged();
          return updated;
        }),
      { authority: WRITE },
    );

    consoleService.addListener(
      "ishiki-sticker/batch",
      (req) =>
        run(() => {
          if (!req || typeof req !== "object" || !Array.isArray(req.ids)) {
            throw new Error("无效的批量操作参数");
          }
          const allowedActions = new Set(["approve", "delete", "ban", "movePack", "setCategory"]);
          if (!allowedActions.has(req.action)) {
            throw new Error(`不支持的批量操作: ${String(req.action)}`);
          }
          if (req.ids.length > 500) {
            throw new Error("单次批量操作最多处理 500 条记录");
          }
          const cleanIds = req.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
          const res = store.batch(req.action, cleanIds, typeof req.value === "string" ? req.value : undefined);
          notifyChanged();
          return res;
        }),
      { authority: WRITE },
    );

    consoleService.addListener(
      "ishiki-sticker/upload",
      (req) =>
        run(() => {
          if (!req || typeof req !== "object") throw new Error("无效的上传参数");
          const pack = normalizePackName(req.pack, "default");
          const files = Array.isArray(req.files) ? req.files.slice(0, 100) : [];
          const maxB64Len = Math.ceil(pluginConfig.maxFileBytes * 1.38) + 256;
          const response: UploadResponse = { created: 0, duplicate: 0, rejected: 0, queued: 0, errors: [] };

          for (const item of files) {
            try {
              if (!item || typeof item.dataBase64 !== "string") {
                response.rejected += 1;
                continue;
              }
              const rawB64 = item.dataBase64.includes(",") ? item.dataBase64.split(",", 2)[1]! : item.dataBase64;
              if (rawB64.length > maxB64Len) {
                response.rejected += 1;
                response.errors.push(`${item.name || "file"}: 文件体积超出上传限制`);
                continue;
              }
              const bytes = new Uint8Array(Buffer.from(rawB64, "base64"));
              const check = validateCandidateBytes(bytes, {
                maxFileBytes: pluginConfig.maxFileBytes,
                maxAspectRatio: pluginConfig.maxAspectRatio,
              });
              if (!check.ok) {
                response.rejected += 1;
                response.errors.push(`${item.name}: ${check.reason}`);
                continue;
              }
              if (store.isBlacklisted(check.info.sha256)) {
                response.rejected += 1;
                response.errors.push(`${item.name}: 在黑名单中`);
                continue;
              }
              if (pluginConfig.maxTotalStickers > 0 && store.countTotal() >= pluginConfig.maxTotalStickers) {
                response.rejected += 1;
                response.errors.push(`${item.name}: 已达图库总量上限`);
                break;
              }
              const saved = store.save({
                sha256: check.info.sha256,
                bytes,
                mime: check.info.mime,
                ext: check.info.ext,
                width: check.info.width,
                height: check.info.height,
                pack,
                status: pluginConfig.requireApproval ? "pending" : "active",
                category: "未分类",
                tags: [],
                description: "",
                ocrText: "",
                characterName: req.character?.trim() ?? "",
                workName: req.work?.trim() ?? "",
                emotions: [],
                scenes: [],
                source: { kind: "upload", note: item.name },
              });
              if (saved.status === "duplicate") {
                response.duplicate += 1;
                continue;
              }
              response.created += 1;
              if (req.autoTag) {
                const enqueued = enqueueTagJob(store, reviewer, queue, pluginConfig, saved.sticker.id, notifyChanged);
                if (enqueued) response.queued += 1;
              }
            } catch (error) {
              response.rejected += 1;
              response.errors.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          notifyChanged();
          return response;
        }),
      { authority: WRITE },
    );

    consoleService.addListener(
      "ishiki-sticker/retag",
      (ids) =>
        run(() => {
          if (!Array.isArray(ids)) throw new Error("ids 必须为数组");
          let queued = 0;
          const cleanIds = ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 200);
          for (const id of cleanIds) {
            if (enqueueTagJob(store, reviewer, queue, pluginConfig, id, notifyChanged)) queued += 1;
          }
          return { queued };
        }),
      { authority: WRITE },
    );

    consoleService.addListener(
      "ishiki-sticker/queue/cancel",
      () =>
        run(() => ({
          cancelled: queue.cancelPending(),
        })),
      { authority: WRITE },
    );

    consoleService.addListener(
      "ishiki-sticker/import-dir",
      (req) =>
        run(async () => {
          if (!req || typeof req !== "object" || typeof req.dirPath !== "string" || !req.dirPath.trim()) {
            throw new Error("请提供有效的目录路径");
          }
          const result = await importFromDirectory(store, pluginConfig, reviewer, queue, {
            dirPath: req.dirPath,
            pack: req.pack,
            autoTag: req.autoTag,
            allowedRoots: resolveImportRoots(ctx.baseDir, pluginConfig.importRoots),
          });
          notifyChanged();
          return result;
        }),
      { authority: ADMIN },
    );

    consoleService.addListener("ishiki-sticker/blacklist/list", () => run(() => store.listBlacklist()), { authority: READ });

    consoleService.addListener(
      "ishiki-sticker/blacklist/remove",
      (sha256) =>
        run(() => {
          if (typeof sha256 !== "string" || !sha256.trim()) throw new Error("无效的哈希值");
          const removed = store.unban(sha256);
          notifyChanged();
          return { removed };
        }),
      { authority: WRITE },
    );

    const installedDist = path.resolve(ctx.baseDir, "node_modules", "koishi-plugin-ishiki-sticker", "dist");
    const localDist = path.resolve(moduleDirectory, "..", "dist");
    const prodEntry = existsSync(installedDist) ? installedDist : localDist;
    consoleService.addEntry({
      dev: path.resolve(moduleDirectory, "..", "client", "index.ts"),
      prod: prodEntry,
    });
  });

  return { notifyChanged, notifyQueue, mediaBasePath };
}

function enqueueTagJob(
  store: StickerStore,
  reviewer: StickerReviewer,
  queue: ReviewQueue,
  pluginConfig: PluginConfig,
  id: string,
  onDone: () => void,
): boolean {
  const sticker = store.getByIdOrPrefix(id);
  if (!sticker) return false;
  const modelRef = reviewer.resolveVisionModelRef(pluginConfig.defaultVisionModel);
  if (!modelRef) return false;

  queue.enqueue({
    id: `retag:${sticker.id}`,
    run: async (signal) => {
      const bytes = store.readBytes(sticker);
      const mime =
        sticker.mime === "image/png" || sticker.mime === "image/jpeg" || sticker.mime === "image/gif" || sticker.mime === "image/webp"
          ? sticker.mime
          : "image/png";
      const decision = await reviewer.review({
        sha256: sticker.sha256,
        bytes,
        mime,
        visionModelRef: modelRef,
        existingCategories: store.listCategories([sticker.pack], "all").map((item) => item.category),
        facts: {
          character: sticker.characterName || undefined,
          work: sticker.workName || undefined,
          overlayText: sticker.ocrText || undefined,
          note: sticker.tags.length > 0 ? `已有参考标签：${sticker.tags.slice(0, 8).join("、")}` : undefined,
        },
        skipCache: true,
        abortSignal: signal,
      });
      if (signal.aborted) return;
      if (!decision.approved) {
        if (!isTransientReviewFailure(decision) && !decision.safe && sticker.status === "active") {
          store.update(sticker.id, { status: "pending" });
          onDone();
        }
        return;
      }
      const emb = await reviewer.embedStickerFields(
        pluginConfig.defaultEmbeddingModel,
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
        signal,
      );
      store.update(
        sticker.id,
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
        emb ? { model: emb.model, vector: emb.vector } : { model: null, vector: null },
      );
      onDone();
    },
  });
  return true;
}
