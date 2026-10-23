/** 管理域之间共享的通知总线，控制台只需要把它转成 console 广播。 */
export interface ManagementEvents {
  "models.changed": { revision: string; providers: string[]; groups: string[]; models: string[] };
  "profiles.changed": { profileId?: string; revision?: string };
  "runtimes.changed": { runtimeId?: string };
  "sessions.appended": { sessionId: string; profileId: string; runtimeId: string; timestamp: number };
}

type Listener<K extends keyof ManagementEvents> = (payload: ManagementEvents[K]) => void;

export class ManagementEventBus {
  private readonly listeners = new Map<keyof ManagementEvents, Set<Listener<never>>>();

  on<K extends keyof ManagementEvents>(event: K, listener: Listener<K>): () => void {
    let group = this.listeners.get(event);
    if (group === undefined) {
      group = new Set();
      this.listeners.set(event, group);
    }
    group.add(listener as Listener<never>);
    return () => group.delete(listener as Listener<never>);
  }

  emit<K extends keyof ManagementEvents>(event: K, payload: ManagementEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as Listener<K>)(payload);
  }
}
