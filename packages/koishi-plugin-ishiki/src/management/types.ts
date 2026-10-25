import type { SchemaNode } from "./schema.js";

/* 模型配置 */

export interface SecretState {
  /** `${NAME}` 形式的环境变量引用；明文密钥永远不出现在响应里。 */
  reference?: string;
  configured: boolean;
}

export interface ModelDecl {
  id: string;
  type?: string;
  name?: string;
  toolCall?: boolean;
  reasoning?: boolean;
  input?: string[];
  thinking?: { mode: string; efforts: string[] };
  contextWindow?: number;
  maxTokens?: number;
  dimensions?: number;
}

export interface ModelDeclView extends ModelDecl {
  reference: string;
  provider: string;
  type: string;
}

export interface ProviderView {
  id: string;
  api: string;
  baseUrl?: string;
  apiKey: SecretState;
  headers: Record<string, string>;
  settings: Record<string, unknown>;
  models: ModelDeclView[];
}

export interface GroupView {
  name: string;
  strategy?: string;
  models: string[];
  circuitBreaker?: { failureThreshold?: number; cooldownSeconds?: number };
}

export interface ModelOption {
  reference: string;
  label: string;
  kind: "model" | "group";
  type?: string;
  provider?: string;
}

export interface ModelsSchemas {
  provider: SchemaNode;
  model: SchemaNode;
  group: SchemaNode;
}

export interface ModelsDocument {
  revision: string;
  providers: ProviderView[];
  groups: GroupView[];
  options: ModelOption[];
  schemas: ModelsSchemas;
  readAt: number;
}

export interface ModelsSaveInput {
  config: ModelsConfigInput;
  revision: string;
}

export interface ModelsConfigInput {
  providers: Record<string, ProviderInput>;
  groups: Record<string, GroupView>;
}

export interface ProviderInput {
  api: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  settings?: Record<string, unknown>;
  models?: ModelDecl[];
}

/* Profile */

export type ProfileState = "active" | "inactive" | "failed" | "loading";

export interface ProfileSummary {
  id: string;
  model: string;
  mode: "channel" | "cross";
  channels: string[];
  state: ProfileState;
  runtimeCount: number;
  savedAt: number;
  appliedAt?: number;
  revision: string;
  lastError?: string;
}

export interface ProfileView extends ProfileSummary {
  config: Record<string, unknown>;
  persona: string;
  instructions: Array<{ path: string; missing: boolean }>;
  runtimes: RuntimeView[];
  sessionCount: number;
}

export interface ProfileSaveInput {
  config: Record<string, unknown>;
  persona?: string;
}

export interface ProfileCheckReport {
  id: string;
  ok: boolean;
  items: Array<{ aspect: "schema" | "engines" | "model" | "instructions" | "claims"; ok: boolean; message?: string }>;
}

export interface ProfileStatus {
  id: string;
  state: ProfileState;
  active: boolean;
  savedAt: number;
  appliedAt?: number;
  revision: string;
  lastError?: string;
  runtimes: string[];
}

/* Runtime */

export type RuntimeState = "idle" | "running" | "stopped" | "failed";

/** 频道坐标：与 Runtime id、认领表键（platform:selfId）同构。 */
export interface ChannelAddress {
  platform: string;
  selfId: string;
  channelId: string;
}

/** 一个频道此刻的归属事实：激活认领、磁盘认领名单、已派生 Runtime。 */
export interface ChannelClaimView {
  address: string;
  profileId?: string;
  matchedPattern?: string;
  savedClaimants: string[];
  runtime?: RuntimeView;
}

export interface RuntimeView {
  id: string;
  profileId: string;
  mode: "channel" | "cross";
  domainLabel: string;
  platform?: string;
  selfId?: string;
  channelId?: string;
  state: RuntimeState;
  activeTurnId?: string;
  createdAt: number;
  lastActivity?: number;
  home: string;
  model: string;
  engines: { context: string; wakeup: string; toolcall: string };
  sessionId: string;
  error?: string;
}

export interface RuntimeMeta {
  id: string;
  profileId: string;
  domain: { mode: "cross" } | { mode: "channel"; platform: string; selfId: string; channelId: string };
  createdAt: number;
  home?: string;
  model?: string;
  engines?: { context: string; wakeup: string; toolcall: string };
}

export interface RuntimeWakeResult {
  runtimeId: string;
  queued: boolean;
  turnId?: string;
}

/* Session */

export interface SessionSummary {
  id: string;
  profileId: string;
  runtimeId: string;
  domainLabel: string;
  mode: "channel" | "cross";
  state: RuntimeState;
  entries: number;
  messages: number;
  turns: number;
  tokens: number;
  lastActivity?: number;
  file: string;
  corrupt: number;
}

export interface SessionFilters {
  profileId?: string;
  keyword?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface LogEntry {
  id: string;
  type: "event" | "message" | "state";
  data: unknown;
  timestamp: number;
  turnId?: string;
}

export interface CorruptLine {
  line: number;
  error: string;
}

export interface SessionEntries {
  sessionId: string;
  entries: LogEntry[];
  corrupt: CorruptLine[];
  nextCursor?: string;
  stats: { entries: number; messages: number; turns: number; tokens: number; corrupt: number };
}

export interface SessionEntryFilters {
  role?: string;
  keyword?: string;
  from?: number;
  to?: number;
}

/* Observability */

export interface UsageRecord {
  id: string;
  timestamp: number;
  profileId: string;
  runtimeId: string;
  sessionId: string;
  provider: string;
  modelId: string;
  reference: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  source: "message" | "turn" | "missing";
  cacheReported: boolean;
}

export interface UsageFilters {
  profileId?: string;
  model?: string;
  from?: number;
  to?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  calls: number;
}

export interface UsageQualityRow {
  reason: string;
  count: number;
}

export interface UsageSnapshot {
  records: UsageRecord[];
  totals: UsageTotals;
  byModel: Array<{ reference: string; input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }>;
  byDay: Array<{ day: string; input: number; output: number; total: number; calls: number }>;
  quality: UsageQualityRow[];
  syncedAt: number;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  kind: string;
  operator: string;
  summary: string;
  result: "ok" | "failed";
  profileId?: string;
  runtimeId?: string;
  sessionId?: string;
  turnId?: string;
  target?: string;
  revision?: string;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface AuditFilters {
  kind?: string;
  profileId?: string;
  operator?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface AuditSnapshot {
  records: AuditRecord[];
  capacity: number;
}

export interface PromptCacheRow {
  reference: string;
  modelId: string;
  calls: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReported: boolean;
}

export interface ResourceCacheRow {
  runtimeId: string;
  profileId: string;
  status: "ok" | "empty" | "error";
  assets: number;
  artifacts: number;
  bytes: number;
  error?: string;
}

export interface CacheSnapshot {
  status: "ok" | "empty" | "unavailable";
  collectedAt: number;
  prompt: PromptCacheRow[];
  resources: ResourceCacheRow[];
  reason?: string;
}

/* 引擎与扩展目录 */

export interface EngineDescriptor {
  name: string;
  label: string;
  schema?: SchemaNode;
  /** 当前上下文里已注册可用的服务名。 */
  available: boolean;
}

export interface EnginesDirectory {
  context: EngineDescriptor[];
  wakeup: EngineDescriptor[];
  toolcall: EngineDescriptor[];
}

export interface ExtensionDescriptor {
  name: string;
  schema?: SchemaNode;
  known: boolean;
}

export interface ExtensionsDirectory {
  extensions: ExtensionDescriptor[];
  schemas: {
    base: SchemaNode;
    profile: SchemaNode;
    failover: SchemaNode;
    codemode: SchemaNode;
    pacing: SchemaNode;
    typing: SchemaNode;
    attachment: SchemaNode;
  };
}
