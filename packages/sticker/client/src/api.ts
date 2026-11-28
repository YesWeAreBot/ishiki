import { receive, send } from "@koishijs/client";

type ConsoleEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export class StickerApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function callApi<T>(event: string, ...args: unknown[]): Promise<T> {
  const dispatch = send as unknown as (type: string, ...args: unknown[]) => Promise<unknown>;
  const result = (await dispatch(event, ...args)) as ConsoleEnvelope<T> | undefined;
  if (result === undefined) throw new StickerApiError("offline", "控制台连接已断开");
  if (!result.ok) throw new StickerApiError(result.error.code, result.error.message);
  return result.value;
}

const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

export function onApiEvent<T = unknown>(event: string, listener: (payload: T) => void): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
    const subscribe = receive as unknown as (name: string, cb: (payload: unknown) => void) => void;
    subscribe(event, (payload: unknown) => {
      for (const fn of eventListeners.get(event) ?? []) {
        fn(payload);
      }
    });
  }
  const wrapped = listener as (payload: unknown) => void;
  listeners.add(wrapped);
  return () => {
    eventListeners.get(event)?.delete(wrapped);
  };
}
