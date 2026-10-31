import Schema from "schemastery";

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
  imageInput: Schema.boolean().description("允许向支持图片输入的模型发送图片").default(false),
  recentImageCount: Schema.number().step(1).min(1).description("保留最近多少张图片参与上下文").default(3),
  imagePruneBatchSize: Schema.number().step(1).min(1).description("一次清理多少张过期图片").default(2),
  maxImageBytes: Schema.number()
    .min(0)
    .description("单张图片的字节上限")
    .default(5 * 1024 * 1024),
  maxTotalImageBytes: Schema.number()
    .min(0)
    .description("一次请求内图片总字节上限")
    .default(10 * 1024 * 1024),
  maxImageCount: Schema.number().min(0).description("一次请求内的图片数量上限").default(4),
  maxImageDimension: Schema.number().min(1).description("图片长边像素上限，超出时降采样").default(1568),
});
