import { Service, type Context } from "koishi";
import { Extension, type AgentRuntime, type ExtensionHost, type ToolSet } from "koishi-plugin-ishiki";

import { registerStickerCommands } from "./commands.js";
import { pluginConfigSchema, profileConfigSchema, resolveDataDir, resolvePolicy } from "./config.js";
import { installStickerConsole, type ConsoleController } from "./console.js";
import { PacerSharedState, RuntimePacer } from "./frequency.js";
import { ReviewQueue, StickerReviewer } from "./reviewer.js";
import { StickerStore } from "./store.js";
import { buildStickerInstructions, createStickerTools } from "./tools.js";
import type { PluginConfig, ProfileConfig } from "./types.js";

class StickerExtension extends Extension<ProfileConfig> {
  static readonly name = "sticker";
  static readonly inject = { required: ["ishiki"], optional: ["console", "server", "database"] };
  static readonly Config = pluginConfigSchema;
  public readonly Schema = profileConfigSchema;

  private readonly pluginConfig: PluginConfig;
  private readonly store: StickerStore;
  private readonly reviewer: StickerReviewer;
  private readonly queue: ReviewQueue;
  private readonly sharedPacer = new PacerSharedState();
  private consoleController: ConsoleController | undefined;

  public constructor(ctx: Context, config: PluginConfig) {
    super(ctx, "sticker");
    this.pluginConfig = config;
    this.logger.level = config.logLevel;

    const rootDir = resolveDataDir(ctx, config.dataDir);
    this.store = new StickerStore(rootDir);
    this.reviewer = new StickerReviewer({
      gateway: ctx.ishiki.gateway,
      logger: this.logger,
      store: this.store,
    });
    this.queue = new ReviewQueue(config.reviewConcurrency, config.reviewRpm, (snapshot) => {
      this.consoleController?.notifyQueue(snapshot);
    });

    this.consoleController = installStickerConsole(ctx, {
      store: this.store,
      reviewer: this.reviewer,
      queue: this.queue,
      pluginConfig: this.pluginConfig,
    });

    if (config.commands.enable) {
      const disposeCommands = registerStickerCommands({
        ctx,
        store: this.store,
        reviewer: this.reviewer,
        queue: this.queue,
        pluginConfig: this.pluginConfig,
        onChanged: () => this.consoleController?.notifyChanged(),
      });
      ctx.on("dispose", () => disposeCommands());
    }

    ctx.on("dispose", () => {
      this.queue.cancelPending();
      this.store.close();
    });
  }

  public [Service.invoke](host: ExtensionHost, profile: ProfileConfig) {
    const policy = resolvePolicy(this.pluginConfig, profile);
    const pacer = new RuntimePacer(this.sharedPacer);
    const fallbackChannelKey =
      host.domain.mode === "channel" ? `${host.domain.platform}:${host.domain.selfId}:${host.domain.channelId}` : `${host.runtimeId}:cross`;

    const runtimeReviewer = new StickerReviewer({
      gateway: host.gateway,
      logger: host.logger,
      store: this.store,
    });

    return {
      name: "ishiki.sticker",
      attach: (runtime: AgentRuntime) => pacer.attach(runtime),
      extendInstructions: async () => {
        await pacer.syncFromStorage();
        return buildStickerInstructions(this.store, policy, pacer, fallbackChannelKey);
      },
      extendTools: async (): Promise<ToolSet> => {
        await pacer.syncFromStorage();
        return createStickerTools({
          ctx: this.ctx,
          host,
          store: this.store,
          reviewer: runtimeReviewer,
          pluginConfig: this.pluginConfig,
          policy,
          pacer,
          onChanged: () => this.consoleController?.notifyChanged(),
        });
      },
    };
  }
}

export { buildStickerElement } from "./tools.js";
export { gifFirstFrameToPng } from "./gif.js";
export { importFromDirectory, type DirectoryImportOptions, type DirectoryImportResult } from "./importer.js";
export { detectStickerMime, mimeForFilename, sha256Hex, validateCandidateBytes } from "./media.js";
export { ReviewQueue, StickerReviewer } from "./reviewer.js";
export { StickerStore } from "./store.js";
export type * from "./types.js";
export default StickerExtension;
