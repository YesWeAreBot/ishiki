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

export interface UploadResponse {
  created: number;
  duplicate: number;
  rejected: number;
  queued: number;
  errors: string[];
}

export interface DirectoryImportResult {
  scanned: number;
  imported: number;
  duplicate: number;
  rejected: number;
  queuedForReview: number;
  errors: string[];
}
