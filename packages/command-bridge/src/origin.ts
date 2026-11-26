import { AsyncLocalStorage } from "node:async_hooks";

import type { Context, Session } from "koishi";
import type { AgentRuntime, ExtensionHost, IshikiMessageCreated } from "koishi-plugin-ishiki";

export interface BoundOrigin {
  readonly session: Session;
  readonly turnId: string;
  readonly platform: string;
  readonly selfId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly userId: string;
  readonly content: string;
}

export interface RuntimeOrigin {
  attach(runtime: AgentRuntime): () => void;
  current(): BoundOrigin | undefined;
  valid(origin: BoundOrigin): boolean;
}

type InboundIdentity = Omit<BoundOrigin, "session" | "turnId"> & { timestamp: number };
interface Inbound {
  session: WeakRef<Session>;
  identity: InboundIdentity;
  observed: boolean;
  revoked: boolean;
}

function sameMessage(identity: InboundIdentity, data: IshikiMessageCreated): boolean {
  return (
    identity.platform === data.platform &&
    identity.selfId === data.selfId &&
    identity.channelId === data.channelId &&
    identity.messageId === data.messageId &&
    identity.userId === data.user.id &&
    identity.timestamp === data.timestamp
  );
}

export function createOriginTracker(ctx: Context) {
  // Keep the original text, including QQ segments. Ishiki may rewrite attachment URLs during delivery.
  // A timer descended from unrelated Koishi middleware must not keep its whole session alive.
  const inbound = new AsyncLocalStorage<Inbound>();
  // Cordis can expose the same adapter event through differently scoped Session proxies.
  const received = new WeakMap<Session["event"], Inbound>();
  const latest = new Map<string, WeakRef<Inbound>>();
  function record(session: Session): Inbound | undefined {
    const existing = received.get(session.event);
    if (existing) return existing;
    const { platform, selfId, channelId, messageId, userId, timestamp, content } = session;
    if (
      session.type !== "message-created" ||
      !platform ||
      !selfId ||
      !channelId ||
      !messageId ||
      !userId ||
      typeof content !== "string" ||
      selfId === userId ||
      session.event.user?.isBot
    )
      return;
    const id = ctx.ishiki.findSessionId({ platform, selfId, channelId });
    if (!id) return;
    const previous = latest.get(id)?.deref();
    if (previous) previous.revoked = true;
    const identity = { platform, selfId, channelId, messageId, userId, timestamp, content };
    const source = { session: new WeakRef(session), identity, observed: false, revoked: false };
    received.set(session.event, source);
    latest.delete(id);
    if (latest.size >= 2048) {
      const oldest = latest.keys().next().value!;
      const evicted = latest.get(oldest)?.deref();
      if (evicted) evicted.revoked = true;
      latest.delete(oldest);
    }
    latest.set(id, new WeakRef(source));
    return source;
  }
  // Joined messages and deletions can be persisted at the end of an SDK step.
  // Invalidate at adapter reception, even while an earlier model request is still running.
  ctx.on("internal/session", (session) => {
    if (session.type === "message-created") {
      record(session);
    } else if (session.type === "message-deleted" && session.channelId && session.messageId) {
      const { platform, selfId, channelId, messageId } = session;
      const key = ctx.ishiki.findSessionId({ platform, selfId, channelId });
      const source = key && latest.get(key)?.deref();
      if (
        source &&
        source.identity.platform === platform &&
        source.identity.selfId === selfId &&
        source.identity.channelId === channelId &&
        source.identity.messageId === messageId
      )
        source.revoked = true;
    }
  });
  ctx.middleware((session, next) => {
    const source = record(session);
    if (!source || source.revoked) return next();
    source.session = new WeakRef(session);
    return inbound.run(source, next);
  }, true);

  function forRuntime(host: ExtensionHost): RuntimeOrigin {
    let runtime: AgentRuntime | undefined;
    let active: BoundOrigin | undefined;
    let armed: ReturnType<typeof inbound.getStore>;

    function valid(origin: BoundOrigin): boolean {
      const session = origin.session;
      return (
        active === origin &&
        runtime !== undefined &&
        runtime.agent.getActiveTurnId() === origin.turnId &&
        inbound.getStore()?.revoked === false &&
        inbound.getStore()?.session.deref() === session &&
        session.platform === origin.platform &&
        session.selfId === origin.selfId &&
        session.channelId === origin.channelId &&
        session.messageId === origin.messageId &&
        session.userId === origin.userId &&
        ctx.ishiki.findRuntimeByAddress(origin) === runtime
      );
    }

    return {
      current: () => (active && valid(active) ? active : undefined),
      valid,
      attach(handle) {
        if (handle.id !== host.runtimeId) throw new Error("Ishiki runtime identity changed");
        runtime = handle;
        const { agent } = handle;
        const unsubscribe = agent.channel.subscribe("agent", (event) => {
          const source = inbound.getStore();
          const session = source?.session.deref();
          if (event.type === "message.appended") {
            const message = event.message;
            if (message.role !== "custom") return;
            if (
              message.type === "ishiki.message.deleted" &&
              active &&
              active.platform === message.data.platform &&
              active.selfId === message.data.selfId &&
              active.channelId === message.data.channelId &&
              active.messageId === message.data.messageId
            ) {
              active = undefined;
            }
            if (message.type !== "ishiki.message.created") return;
            // A second message joined the conversation. Future steps may respond to its author.
            active = undefined;
            armed = undefined;
            if (
              !source ||
              source.revoked ||
              source.observed ||
              !session ||
              !sameMessage(source.identity, message.data) ||
              ctx.ishiki.findRuntimeByAddress(message.data) !== handle
            )
              return;
            source.observed = true;
            if (!agent.isIdle()) return;
            armed = source;
            // core 0.0.9 invokes message listeners synchronously; standard/willingness enqueue
            // the turn in this dispatch. A later trigger (including a timer) has no proven actor.
            queueMicrotask(() => {
              if (armed === source) armed = undefined;
            });
          } else if (event.type === "turn.queued" && source && !source.revoked && armed === source && session) {
            armed = undefined;
            if (agent.getActiveTurnId() !== event.turnId) return;
            active = Object.freeze({ ...source.identity, session, turnId: event.turnId });
          } else if ((event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted") && active?.turnId === event.turnId) {
            active = undefined;
          }
        });
        return () => {
          unsubscribe();
          armed = undefined;
          active = undefined;
          runtime = undefined;
        };
      },
    };
  }

  return { forRuntime };
}
