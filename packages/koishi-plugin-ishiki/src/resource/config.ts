import { Schema } from "koishi";

/** Image capability ceiling, recent-history retention and per-request budgets. */
export interface AttachmentConfig {
  imageInput: boolean;
  recentImageCount?: number;
  imagePruneBatchSize?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  maxImageCount?: number;
  maxImageDimension?: number;
}

export const AttachmentConfig: Schema<AttachmentConfig> = Schema.object({
  imageInput: Schema.boolean().default(false),
  recentImageCount: Schema.number().step(1).min(1).default(3),
  imagePruneBatchSize: Schema.number().step(1).min(1).default(2),
  maxImageBytes: Schema.number()
    .min(0)
    .default(5 * 1024 * 1024),
  maxTotalImageBytes: Schema.number()
    .min(0)
    .default(10 * 1024 * 1024),
  maxImageCount: Schema.number().min(0).default(4),
  maxImageDimension: Schema.number().min(1).default(8000),
});
