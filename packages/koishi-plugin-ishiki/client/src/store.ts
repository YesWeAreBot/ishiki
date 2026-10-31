import { store as remote } from "@koishijs/client";
import { reactive, ref } from "vue";

import type { EnginesDirectory, ExtensionsDirectory, JevSnapshot, ModelsDocument, ProfileSummary, RuntimeView, SessionSummary, UsageSnapshot } from "./types";

/** 控制台数据服务推送的只读快照。键名由服务端 Console.Services 声明。 */
interface RemoteStore {
  ishikiModels?: ModelsDocument;
  ishikiProfiles?: { profiles: ProfileSummary[]; engines: EnginesDirectory; extensions: ExtensionsDirectory };
  ishikiRuntimes?: { runtimes: RuntimeView[] };
  ishikiSessions?: { sessions: SessionSummary[] };
  ishikiUsage?: UsageSnapshot;
  ishikiJev?: JevSnapshot;
}

const data = remote as unknown as RemoteStore;

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

let toastSeed = 0;

export const toasts = ref<Toast[]>([]);

export function toast(tone: ToastTone, title: string, detail?: string): void {
  const id = ++toastSeed;
  toasts.value.push({ id, tone, title, detail });
  setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, 5000);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((item) => item.id !== id);
}

export const route = ref("/models");

export const store = reactive({
  get toasts() {
    return toasts.value;
  },
  get models(): ModelsDocument | undefined {
    return data.ishikiModels;
  },
  get providers() {
    return data.ishikiModels?.providers ?? [];
  },
  get groups() {
    return data.ishikiModels?.groups ?? [];
  },
  get options() {
    return data.ishikiModels?.options ?? [];
  },
  get modelSchemas() {
    return data.ishikiModels?.schemas;
  },
  get profiles(): ProfileSummary[] {
    return data.ishikiProfiles?.profiles ?? [];
  },
  get engines(): EnginesDirectory | undefined {
    return data.ishikiProfiles?.engines;
  },
  get extensions(): ExtensionsDirectory | undefined {
    return data.ishikiProfiles?.extensions;
  },
  get runtimes(): RuntimeView[] {
    return data.ishikiRuntimes?.runtimes ?? [];
  },
  get sessions(): SessionSummary[] {
    return data.ishikiSessions?.sessions ?? [];
  },
  get usage(): UsageSnapshot | undefined {
    return data.ishikiUsage;
  },
  get jev(): JevSnapshot | undefined {
    return data.ishikiJev;
  },
  get lastSyncAt(): number {
    return Math.max(data.ishikiModels?.readAt ?? 0, data.ishikiUsage?.syncedAt ?? 0);
  },
});

export function profileById(id: string | null | undefined): ProfileSummary | undefined {
  if (id === null || id === undefined) return undefined;
  return store.profiles.find((profile) => profile.id === id);
}

export function runtimeById(id: string | null | undefined): RuntimeView | undefined {
  if (id === null || id === undefined) return undefined;
  return store.runtimes.find((runtime) => runtime.id === id);
}

export function sessionById(id: string | null | undefined): SessionSummary | undefined {
  if (id === null || id === undefined) return undefined;
  return store.sessions.find((session) => session.id === id);
}

export function runtimesForProfile(profileId: string): RuntimeView[] {
  return store.runtimes.filter((runtime) => runtime.profileId === profileId);
}

export function sessionsForProfile(profileId: string): SessionSummary[] {
  return store.sessions.filter((session) => session.profileId === profileId);
}

export function referencesForModel(reference: string): { groups: string[] } {
  return { groups: store.groups.filter((group) => group.models.includes(reference)).map((group) => group.name) };
}

export function referencesForGroup(name: string): { groups: string[] } {
  return { groups: store.groups.filter((group) => group.name !== name && group.models.includes(name)).map((group) => group.name) };
}
