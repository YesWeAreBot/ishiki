import { DataService, type Console } from "@koishijs/console";
import type { Context } from "koishi";

import type Ishiki from "../index.js";
import type { CacheSnapshot, ModelsDocument, UsageSnapshot } from "../management/types.js";
import type { ProfilesSnapshot, RuntimesSnapshot, SessionsSnapshot } from "./types.js";

abstract class IshikiService<T> extends DataService<T> {
  constructor(
    ctx: Context,
    key: keyof Console.Services,
    protected readonly host: Ishiki,
  ) {
    super(ctx, key, { authority: 1 });
  }
}

export class ModelsProvider extends IshikiService<ModelsDocument> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiModels", host);
  }

  override async get(): Promise<ModelsDocument> {
    return this.host.management.models.read();
  }
}

export class ProfilesProvider extends IshikiService<ProfilesSnapshot> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiProfiles", host);
  }

  override async get(): Promise<ProfilesSnapshot> {
    const management = this.host.management;
    return {
      profiles: await management.profiles.list(),
      engines: management.engines(),
      extensions: management.extensions(),
    };
  }
}

export class RuntimesProvider extends IshikiService<RuntimesSnapshot> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiRuntimes", host);
  }

  override async get(): Promise<RuntimesSnapshot> {
    return { runtimes: this.host.management.runtimes.list() };
  }
}

export class SessionsProvider extends IshikiService<SessionsSnapshot> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiSessions", host);
  }

  override async get(): Promise<SessionsSnapshot> {
    return { sessions: await this.host.management.sessions.list() };
  }
}

export class UsageProvider extends IshikiService<UsageSnapshot> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiUsage", host);
  }

  override async get(): Promise<UsageSnapshot> {
    const usage = this.host.management.usage;
    await usage.sync();
    return usage.snapshot();
  }
}

export class CacheProvider extends IshikiService<CacheSnapshot> {
  constructor(ctx: Context, host: Ishiki) {
    super(ctx, "ishikiCache", host);
  }

  override async get(): Promise<CacheSnapshot> {
    return this.host.management.cache.read();
  }
}
