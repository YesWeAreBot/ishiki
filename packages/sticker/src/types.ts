export type StickerStatus = "active" | "pending";

export type StickerSort = "newest" | "most_used" | "updated";

export interface StickerSourceInfo {
  kind: "llm" | "command" | "upload" | "import" | "legacy";
  platform?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
  note?: string;
}

export interface StickerRecord {
  id: string;
  sha256: string;
  pack: string;
  status: StickerStatus;
  mime: string;
  ext: string;
  size: number;
  width: number;
  height: number;
  category: string;
  tags: string[];
  description: string;
  ocrText: string;
  characterName: string;
  workName: string;
  emotions: string[];
  scenes: string[];
  source: StickerSourceInfo;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  embeddingModel: string | null;
}

export interface StickerSearchHit {
  sticker: StickerRecord;
  score: number;
  lexicalScore: number;
  vectorScore: number;
}

export interface BlacklistRecord {
  sha256: string;
  reason: string;
  createdAt: number;
}

export interface PackSummary {
  pack: string;
  activeCount: number;
  pendingCount: number;
  totalCount: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface ReviewFacts {
  character?: string;
  work?: string;
  overlayText?: string;
  note?: string;
}

export interface ReviewDecision {
  approved: boolean;
  isSticker: boolean;
  safe: boolean;
  rejectReason: string;
  category: string;
  tags: string[];
  description: string;
  ocrText: string;
  characterName: string;
  workName: string;
  emotions: string[];
  scenes: string[];
  cached: boolean;
}

export interface ReviewQueueSnapshot {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  lastError?: string;
}

export interface StickerOverview {
  totalActive: number;
  totalPending: number;
  totalBanned: number;
  packs: PackSummary[];
  categories: CategoryCount[];
  queue: ReviewQueueSnapshot;
  mediaBasePath: string | null;
  defaultPack: string;
}

export interface StickerListQuery {
  pack?: string;
  status?: StickerStatus;
  category?: string;
  character?: string;
  query?: string;
  sort?: StickerSort;
  page?: number;
  pageSize?: number;
}

export interface StickerListResult {
  items: StickerRecord[];
  total: number;
  page: number;
  pageSize: number;
  packs: PackSummary[];
  categories: CategoryCount[];
}

export interface StickerUpdatePatch {
  pack?: string;
  status?: StickerStatus;
  category?: string;
  tags?: string[];
  description?: string;
  ocrText?: string;
  characterName?: string;
  workName?: string;
  emotions?: string[];
  scenes?: string[];
}

export interface PluginConfig {
  dataDir: string;
  importRoots: string[];
  defaultVisionModel: string;
  defaultEmbeddingModel: string;
  requireApproval: boolean;
  maxFileBytes: number;
  maxAspectRatio: number;
  maxTotalStickers: number;
  reviewConcurrency: number;
  reviewRpm: number;
  commands: {
    enable: boolean;
    authority: number;
    readAuthority: number;
    allowedPacks: string[];
  };
  logLevel: number;
}

export interface ProfileConfig {
  readPacks: string[];
  writePack: string;
  allowSave: boolean;
  allowSend: boolean;
  requireApproval?: boolean;
  visionModel?: string;
  embeddingModel?: string;
  sendChance: number;
  exemptStickerReply: boolean;
  sendCooldownSeconds: number;
  maxSendPerTurn: number;
  onebotAsSticker: boolean;
  autonomousDailyLimit: number;
  autonomousCooldownMinutes: number;
  dailyReviewLimit: number;
}

export interface ResolvedPolicy {
  readPacks: string[];
  writePack: string;
  allowSave: boolean;
  allowSend: boolean;
  requireApproval: boolean;
  visionModel: string;
  embeddingModel: string;
  sendChance: number;
  exemptStickerReply: boolean;
  sendCooldownSeconds: number;
  maxSendPerTurn: number;
  onebotAsSticker: boolean;
  autonomousDailyLimit: number;
  autonomousCooldownMinutes: number;
  dailyReviewLimit: number;
}
