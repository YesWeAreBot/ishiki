import { Schema } from "koishi";

/**
 * The attachment policy for one profile. `imageInput` is the capability
 * ceiling: turning it on requires every candidate of the profile's model to
 * declare image input. The byte, count and dimension quotas are one budget
 * per request, shared by platform and tool attachments.
 */
export interface AttachmentConfig {
  imageInput: boolean;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  maxImageCount?: number;
  maxImageDimension?: number;
}

export const AttachmentConfig: Schema<AttachmentConfig> = Schema.object({
  imageInput: Schema.boolean().default(false),
  maxImageBytes: Schema.number()
    .min(0)
    .default(5 * 1024 * 1024),
  maxTotalImageBytes: Schema.number()
    .min(0)
    .default(10 * 1024 * 1024),
  maxImageCount: Schema.number().min(0).default(4),
  maxImageDimension: Schema.number().min(1).default(8000),
});
