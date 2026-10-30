import type {
  CacheSnapshot,
  EnginesDirectory,
  ExtensionsDirectory,
  ModelOption,
  ModelsConfigInput,
  ModelsDocument,
  ModelsSaveInput,
  ProfileSaveInput,
  ProfileStatus,
  ProfileSummary,
  ProfileView,
  RemoteModelsDocument,
  RemoteModelsQuery,
  RuntimeView,
  RuntimeWakeResult,
  SessionEntries,
  SessionEntryFilters,
  SessionFilters,
  SessionReadDirection,
  SessionSummary,
  UsageFilters,
  UsageSnapshot,
} from "../management/types.js";

/** 控制台数据服务的推送内容；写入操作走请求响应，不进入推送快照。 */
export interface ProfilesSnapshot {
  profiles: ProfileSummary[];
  engines: EnginesDirectory;
  extensions: ExtensionsDirectory;
}

export interface RuntimesSnapshot {
  runtimes: RuntimeView[];
}

export interface SessionsSnapshot {
  sessions: SessionSummary[];
}

export type ConsoleFailure = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};

export type ConsoleResult<T> = { ok: true; value: T } | ConsoleFailure;

declare module "@koishijs/console" {
  namespace Console {
    interface Services {
      ishikiModels: ModelsDocument;
      ishikiProfiles: ProfilesSnapshot;
      ishikiRuntimes: RuntimesSnapshot;
      ishikiSessions: SessionsSnapshot;
      ishikiUsage: UsageSnapshot;
      ishikiCache: CacheSnapshot;
    }
  }

  interface Events {
    "ishiki/models/validate": (input: ModelsConfigInput) => Promise<ConsoleResult<{ config: ModelsConfigInput; options: ModelOption[] }>>;
    "ishiki/models/save": (input: ModelsSaveInput) => Promise<ConsoleResult<ModelsDocument>>;
    "ishiki/models/remote": (query: RemoteModelsQuery) => Promise<ConsoleResult<RemoteModelsDocument>>;

    "ishiki/profiles/read": (id: string) => Promise<ConsoleResult<ProfileView>>;
    "ishiki/profiles/status": (id: string) => Promise<ConsoleResult<ProfileStatus>>;
    "ishiki/profiles/save": (id: string, input: ProfileSaveInput, revision: string) => Promise<ConsoleResult<ProfileView>>;
    "ishiki/profiles/create": (id: string, input: ProfileSaveInput) => Promise<ConsoleResult<ProfileView>>;
    "ishiki/profiles/apply": (id: string) => Promise<ConsoleResult<ProfileView>>;
    "ishiki/profiles/reload": (id: string) => Promise<ConsoleResult<ProfileView>>;
    "ishiki/profiles/stop": (id: string) => Promise<ConsoleResult<ProfileStatus>>;
    "ishiki/profiles/remove": (id: string) => Promise<ConsoleResult<null>>;

    "ishiki/runtimes/read": (id: string) => Promise<ConsoleResult<RuntimeView>>;
    "ishiki/runtimes/wake": (id: string, prompt?: string) => Promise<ConsoleResult<RuntimeWakeResult>>;
    "ishiki/runtimes/restart": (id: string) => Promise<ConsoleResult<RuntimeView>>;
    "ishiki/runtimes/stop": (id: string) => Promise<ConsoleResult<RuntimeView>>;
    "ishiki/runtimes/interrupt": (id: string) => Promise<ConsoleResult<RuntimeView>>;

    "ishiki/sessions/list": (filters?: SessionFilters) => Promise<ConsoleResult<SessionSummary[]>>;
    "ishiki/sessions/entries": (
      id: string,
      cursor: string | undefined,
      limit: number,
      filters?: SessionEntryFilters,
      direction?: SessionReadDirection,
    ) => Promise<ConsoleResult<SessionEntries>>;

    "ishiki/observability/usage": (filters?: UsageFilters) => Promise<ConsoleResult<UsageSnapshot>>;
    "ishiki/observability/cache": () => Promise<ConsoleResult<CacheSnapshot>>;
  }
}
