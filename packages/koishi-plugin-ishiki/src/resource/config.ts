import Schema from "schemastery";

/** Image capability ceiling, recent-history retention and per-request budgets. */
export interface AttachmentConfig {
  imageInput: boolean;
  messageImageInput: boolean;
  visionModel?: string;
  recentImageCount?: number;
  imagePruneBatchSize?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  maxImageCount?: number;
  maxImageDimension?: number;
}

export const AttachmentConfig: Schema<AttachmentConfig> = Schema.object({
  imageInput: Schema.boolean().description("允许向支持图片输入的模型发送图片").default(false),
  messageImageInput: Schema.boolean().description("imageInput 开启时，允许平台消息中的图片自动进入主对话模型上下文").default(true),
  visionModel: Schema.string().description("read 识图模式使用的模型或模型组；留空表示未配置").role("model"),
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

export interface AssetCleanupConfig {
  enabled: boolean;
  retentionDays: number;
  intervalMinutes: number;
}

export const AssetCleanupConfig: Schema<AssetCleanupConfig> = Schema.object({
  enabled: Schema.boolean().description("定时删除过期 asset 及其元数据").default(false),
  retentionDays: Schema.number().min(0).description("asset 创建后保留的天数；0 表示到期即可清理").default(30),
  intervalMinutes: Schema.number().min(1).description("自动清理的执行间隔（分钟）").default(60),
});

export interface AssetConfig {
  autoDownloadMaxBytes: number;
  cleanup: AssetCleanupConfig;
}

export const AssetConfig: Schema<AssetConfig> = Schema.object({
  autoDownloadMaxBytes: Schema.number()
    .min(0)
    .description("入站 asset 自动下载的字节上限；等于上限仍会下载，0 表示关闭自动下载")
    .default(20 * 1024 * 1024),
  cleanup: AssetCleanupConfig.description("asset 自动清理"),
});
