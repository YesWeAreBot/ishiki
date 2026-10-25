import { reactive } from "vue";

import { call } from "../api";
import type { RemoteModelInfo, RemoteModelsDocument, RemoteModelsQuery } from "../types";

/** 一份在线名单的共享状态：加载中、失败可重试、成功后缓存到下次刷新。 */
export interface RemoteEntry {
  state: "loading" | "ready" | "error";
  models: RemoteModelInfo[];
  error: string;
  loadedAt?: number;
}

const entries = reactive(new Map<string, RemoteEntry>());

function keyOf(query: RemoteModelsQuery): string {
  if (query.providerId !== undefined) return `provider:${query.providerId}`;
  const draft = query.draft;
  return `draft:${draft?.api ?? ""}:${draft?.baseUrl ?? ""}`;
}

export function remoteEntry(query: RemoteModelsQuery | undefined): RemoteEntry | undefined {
  if (query === undefined) return undefined;
  return entries.get(keyOf(query));
}

/** 拉取在线名单；force 用于失败后的重试。同一目标进行中的请求只发一次。 */
export async function loadRemoteModels(query: RemoteModelsQuery, force = false): Promise<void> {
  const key = keyOf(query);
  const current = entries.get(key);
  if (current?.state === "loading") return;
  if (current?.state === "ready" && !force) return;
  entries.set(key, { state: "loading", models: [], error: "" });
  try {
    const result = await call<RemoteModelsDocument>("ishiki/models/remote", query);
    entries.set(key, { state: "ready", models: result.models, error: "", loadedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entries.set(key, { state: "error", models: [], error: message });
  }
}

export function describeQuery(query: RemoteModelsQuery): string {
  if (query.providerId !== undefined) return `供应商 ${query.providerId}`;
  return "未保存的供应商草稿";
}
