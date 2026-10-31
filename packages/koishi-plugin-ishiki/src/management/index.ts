import type { Context } from "koishi";
import type Logger from "reggol";

import type Ishiki from "../index.js";
import { enginesDirectory, extensionsDirectory } from "./catalog.js";
import { ChannelsManager } from "./channels.js";
import { ManagementEventBus } from "./events.js";
import { ModelsManager } from "./models.js";
import { CacheReporter, UsageLedger } from "./observability.js";
import { ProfilesManager } from "./profiles.js";
import { RuntimesManager } from "./runtimes.js";
import { SessionsManager } from "./sessions.js";

export * from "./types.js";
export { ManagementError, describeError } from "./errors.js";
export type { ManagementEvents } from "./events.js";

/** 核心运行时对外管理能力的入口；控制台与指令层只通过这里读取和修改状态。 */
export class Management {
  public readonly events = new ManagementEventBus();
  public readonly sessions: SessionsManager;
  public readonly runtimes: RuntimesManager;
  public readonly profiles: ProfilesManager;
  public readonly models: ModelsManager;
  public readonly channels: ChannelsManager;
  public readonly usage: UsageLedger;
  public readonly cache: CacheReporter;

  constructor(
    private readonly host: Ishiki,
    private readonly ctx: Context,
    private readonly logger: Logger,
  ) {
    this.sessions = new SessionsManager(host, this.events);
    this.runtimes = new RuntimesManager(host, this.events, this.sessions);
    this.usage = new UsageLedger(host.dataPath, this.sessions);
    this.models = new ModelsManager(host, this.events, logger, this.runtimes);
    this.profiles = new ProfilesManager(host, ctx, this.events, this.sessions, this.usage, this.runtimes, this.models, logger);
    this.channels = new ChannelsManager(host, this.profiles, this.runtimes);
    this.cache = new CacheReporter(host, this.sessions, this.usage);
  }

  engines() {
    return enginesDirectory(this.ctx);
  }

  extensions() {
    return extensionsDirectory(this.ctx);
  }

  dispose(): void {
    this.runtimes.dispose();
  }
}
