import fs from "node:fs/promises";
import path from "node:path";

import { normalizePackName } from "./config.js";
import { validateCandidateBytes } from "./media.js";
import { isTransientReviewFailure, type ReviewQueue, type StickerReviewer } from "./reviewer.js";
import type { StickerStore } from "./store.js";
import type { PluginConfig, StickerStatus } from "./types.js";

export interface DirectoryImportOptions {
  dirPath: string;
  pack?: string;
  status?: StickerStatus;
  autoTag?: boolean;
  visionModel?: string;
  embeddingModel?: string;
  maxFiles?: number;
  allowedRoots?: string[];
}

export interface DirectoryImportResult {
  scanned: number;
  imported: number;
  duplicate: number;
  rejected: number;
  queuedForReview: number;
  errors: string[];
}

interface ManifestMeta {
  category?: string;
  tags?: string[];
  description?: string;
  ocrText?: string;
  characterName?: string;
  workName?: string;
  emotions?: string[];
  scenes?: string[];
}

export async function importFromDirectory(
  store: StickerStore,
  pluginConfig: PluginConfig,
  reviewer: StickerReviewer | undefined,
  queue: ReviewQueue | undefined,
  options: DirectoryImportOptions,
): Promise<DirectoryImportResult> {
  const resolvedInput = path.resolve(options.dirPath);
  let root: string;
  try {
    root = await fs.realpath(resolvedInput);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      throw new Error(`目标不是目录: ${resolvedInput}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("目标不是目录")) throw error;
    throw new Error(`目录不存在或不可访问: ${resolvedInput}`, { cause: error });
  }

  if (options.allowedRoots && options.allowedRoots.length > 0) {
    const allowed = await isWithinAllowedRoots(root, options.allowedRoots);
    if (!allowed) {
      throw new Error(`目录 "${resolvedInput}" 不在允许的导入根目录（importRoots）白名单内`);
    }
  }

  const pack = normalizePackName(options.pack, "default");
  const status: StickerStatus = options.status ?? (pluginConfig.requireApproval ? "pending" : "active");
  const maxFiles = Math.max(1, Math.min(5000, options.maxFiles ?? 2000));
  const metadataIndex = await loadOptionalIndex(root);

  const walkErrors: string[] = [];
  const files = await walkImageFiles(root, maxFiles, walkErrors);
  const result: DirectoryImportResult = {
    scanned: files.length,
    imported: 0,
    duplicate: 0,
    rejected: 0,
    queuedForReview: 0,
    errors: walkErrors.slice(0, 20),
  };

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!;
    if (i > 0 && i % 16 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    try {
      const bytes = new Uint8Array(await fs.readFile(filePath));
      const check = validateCandidateBytes(bytes, {
        maxFileBytes: pluginConfig.maxFileBytes,
        maxAspectRatio: pluginConfig.maxAspectRatio,
      });
      if (!check.ok) {
        result.rejected += 1;
        if (result.errors.length < 20) result.errors.push(`${path.basename(filePath)}: ${check.reason}`);
        continue;
      }

      if (store.isBlacklisted(check.info.sha256)) {
        result.rejected += 1;
        continue;
      }

      if (pluginConfig.maxTotalStickers > 0 && store.countTotal() >= pluginConfig.maxTotalStickers) {
        result.errors.push(`已达到图库总量上限 (${pluginConfig.maxTotalStickers})`);
        break;
      }

      const rel = path.relative(root, filePath).replaceAll("\\", "/");
      const meta = metadataIndex.get(rel) ?? metadataIndex.get(path.basename(filePath));
      const folderCategory = inferFolderCategory(root, filePath);

      const saved = store.save({
        sha256: check.info.sha256,
        bytes,
        mime: check.info.mime,
        ext: check.info.ext,
        width: check.info.width,
        height: check.info.height,
        pack,
        status,
        category: meta?.category || folderCategory || "未分类",
        tags: meta?.tags ?? [],
        description: meta?.description ?? "",
        ocrText: meta?.ocrText ?? "",
        characterName: meta?.characterName ?? "",
        workName: meta?.workName ?? "",
        emotions: meta?.emotions ?? [],
        scenes: meta?.scenes ?? [],
        source: { kind: "import", note: rel },
      });

      if (saved.status === "duplicate") {
        result.duplicate += 1;
        continue;
      }

      result.imported += 1;
      if (options.autoTag && reviewer && queue) {
        const sticker = saved.sticker;
        const modelRef = reviewer.resolveVisionModelRef(options.visionModel || pluginConfig.defaultVisionModel);
        if (modelRef) {
          queue.enqueue({
            id: `tag:${sticker.id}`,
            run: async (signal) => {
              const raw = store.readBytes(sticker);
              const decision = await reviewer.review({
                sha256: sticker.sha256,
                bytes: raw,
                mime: check.info.mime,
                visionModelRef: modelRef,
                existingCategories: store.listCategories([sticker.pack], "all").map((item) => item.category),
                facts: {
                  character: sticker.characterName || undefined,
                  work: sticker.workName || undefined,
                  overlayText: sticker.ocrText || undefined,
                },
                abortSignal: signal,
              });
              if (signal.aborted) return;
              if (!decision.approved) {
                if (!isTransientReviewFailure(decision) && sticker.status === "active") {
                  store.update(sticker.id, { status: "pending" });
                }
                return;
              }
              const embeddingUpdate = await reviewer.embedStickerFields(
                options.embeddingModel || pluginConfig.defaultEmbeddingModel,
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
                embeddingUpdate ? { model: embeddingUpdate.model, vector: embeddingUpdate.vector } : { model: null, vector: null },
              );
            },
          });
          result.queuedForReview += 1;
        }
      }
    } catch (error) {
      result.rejected += 1;
      if (result.errors.length < 20) result.errors.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

function normalizeRootPath(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

async function isWithinAllowedRoots(realTarget: string, allowedRoots: readonly string[]): Promise<boolean> {
  const target = normalizeRootPath(realTarget);
  for (const candidate of allowedRoots) {
    try {
      const realAllowed = normalizeRootPath(await fs.realpath(path.resolve(candidate)));
      const rel = path.relative(realAllowed, target);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return true;
      }
    } catch {
      // Skip non-existent configured root directories.
    }
  }
  return false;
}

async function walkImageFiles(root: string, limit: number, walkErrors: string[]): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  const allowedExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

  while (stack.length > 0 && results.length < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (walkErrors.length < 20) {
        walkErrors.push(`${path.basename(dir)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && allowedExts.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

function inferFolderCategory(root: string, filePath: string): string | undefined {
  const rel = path.relative(root, path.dirname(filePath));
  if (!rel || rel === ".") return undefined;
  const parts = rel.split(path.sep).filter((part) => part.length > 0 && part !== "media" && part !== "files");
  return parts.at(-1);
}

async function loadOptionalIndex(root: string): Promise<Map<string, ManifestMeta>> {
  const map = new Map<string, ManifestMeta>();
  for (const filename of ["archive_index.json", "manifest.json", "stickers.json"]) {
    const full = path.join(root, filename);
    try {
      const raw = await fs.readFile(full, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            const key =
              typeof obj.file === "string" ? obj.file : typeof obj.path === "string" ? obj.path : typeof obj.original === "string" ? obj.original : "";
            if (key) map.set(key.replaceAll("\\", "/"), parseMetaObject(obj));
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (val && typeof val === "object") map.set(key.replaceAll("\\", "/"), parseMetaObject(val as Record<string, unknown>));
        }
      }
    } catch {
      // Ignore missing or malformed optional index files.
    }
  }
  return map;
}

function asStrings(val: unknown): string[] | undefined {
  return Array.isArray(val) ? val.filter((item): item is string => typeof item === "string") : undefined;
}

function parseMetaObject(obj: Record<string, unknown>): ManifestMeta {
  return {
    category: typeof obj.category === "string" ? obj.category : undefined,
    tags: asStrings(obj.tags),
    description: typeof obj.desc === "string" ? obj.desc : typeof obj.description === "string" ? obj.description : undefined,
    ocrText: typeof obj.ocrText === "string" ? obj.ocrText : typeof obj.ocr_text === "string" ? obj.ocr_text : undefined,
    characterName: typeof obj.character === "string" ? obj.character : typeof obj.characterName === "string" ? obj.characterName : undefined,
    workName: typeof obj.work === "string" ? obj.work : typeof obj.workName === "string" ? obj.workName : undefined,
    emotions: asStrings(obj.emotions),
    scenes: asStrings(obj.scenes),
  };
}
