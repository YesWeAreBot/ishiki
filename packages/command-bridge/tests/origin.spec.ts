import type { Context, Session } from "koishi";
import {
  createAgent,
  createCustomMessage,
  createMemoryStorage,
  StandardWakeupInstance,
  WillingnessWakeupInstance,
  type Agent,
  type AgentRuntime,
  type ExtensionHost,
  type IshikiMessageCreated,
  type LanguageModelV4,
} from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

import { createOriginTracker, type BoundOrigin, type RuntimeOrigin } from "../src/origin.js";

const address = { platform: "mock", selfId: "bot", channelId: "room" };
const host = { runtimeId: "one", domain: { mode: "channel", ...address } } as ExtensionHost;

type MessageSession = Session & { channelId: string; messageId: string; userId: string; content: string };

function incoming(seq = 1): MessageSession {
  return {
    ...address,
    timestamp: seq,
    type: "message-created",
    event: { user: { id: `u${seq}` } },
    userId: `u${seq}`,
    messageId: `m${seq}`,
    content: `request ${seq}`,
  } as MessageSession;
}

function message(session: MessageSession, override: Partial<IshikiMessageCreated> = {}) {
  return createCustomMessage("ishiki.message.created", {
    platform: session.platform,
    selfId: session.selfId,
    channelId: session.channelId,
    messageId: session.messageId,
    timestamp: session.timestamp,
    content: session.content,
    isDirect: true,
    user: { id: session.userId },
    ...override,
  });
}

// Use the real core queue, message persistence, plugin init order and wakeup engines.
// End the synthetic turn in prompt assembly, before any model/network operation.
async function fixture(engine: { attach(agent: Agent): () => void }, inspect?: (origin: RuntimeOrigin) => Promise<void>) {
  let receive!: (session: Session, next: () => Promise<void>) => Promise<unknown>;
  let internal!: (session: Session) => void;
  let handle!: AgentRuntime;
  let routed = true;
  const ctx = {
    on(event: string, listener: typeof internal) {
      if (event === "internal/session") internal = listener;
    },
    middleware(fn: typeof receive, prepend: boolean) {
      expect(prepend).toBe(true);
      receive = fn;
    },
    ishiki: { findSessionId: () => (routed ? host.runtimeId : undefined), findRuntimeByAddress: () => (routed ? handle : undefined) },
  } as unknown as Context;
  const origin = createOriginTracker(ctx).forRuntime(host);
  const snapshots: Array<BoundOrigin | undefined> = [];
  let detachWakeup: (() => void) | undefined;
  const agent = createAgent({
    model: {} as LanguageModelV4,
    storage: createMemoryStorage(),
    plugins: [
      {
        name: "origin-fixture",
        init(agent) {
          detachWakeup = engine.attach(agent);
        },
        stop() {
          detachWakeup?.();
        },
        async extendInstructions() {
          snapshots.push(origin.current());
          await inspect?.(origin);
          throw new Error("offline fixture finished inspecting this turn");
        },
      },
    ],
  });
  handle = { id: host.runtimeId, agent } as AgentRuntime;
  const detach = origin.attach(handle);
  await agent.init();

  async function append(session: MessageSession, override: Partial<IshikiMessageCreated> = {}) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const unsubscribe = agent.channel.subscribe("agent", (event) => {
      if (
        event.type === "message.appended" &&
        event.message.role === "custom" &&
        event.message.type === "ishiki.message.created" &&
        event.message.data.messageId === (override.messageId ?? session.messageId)
      )
        resolve();
    });
    try {
      agent.send(message(session, override), { ifBusy: "join", trigger: false });
      await promise;
    } finally {
      unsubscribe();
    }
  }

  return {
    agent,
    internal,
    append,
    detach,
    origin,
    receive,
    snapshots,
    changeRoute() {
      routed = false;
    },
    async deliver(session: MessageSession, override?: Partial<IshikiMessageCreated>) {
      await receive(session, () => append(session, override));
      await agent.wait();
    },
  };
}

describe("command request identity", () => {
  it.each([
    ["standard", new StandardWakeupInstance()],
    ["willingness", new WillingnessWakeupInstance({ directForce: true }, host)],
  ] as const)("binds the actual triggering Koishi session during a %s turn", async (_, engine) => {
    const f = await fixture(engine);
    const session = incoming();
    await f.deliver(session);
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]).toMatchObject({ platform: "mock", selfId: "bot", channelId: "room", userId: "u1", messageId: "m1", content: "request 1" });
    expect(f.snapshots[0]?.session).toBe(session);
    expect(f.origin.valid(f.snapshots[0]!)).toBe(false);
    f.detach();
    await f.agent.stop();
  });

  it.each([{ selfId: "other" }, { channelId: "elsewhere" }, { platform: "elsewhere" }, { user: { id: "other" } }, { messageId: "other" }, { timestamp: 99 }])(
    "refuses an Ishiki message with mismatched coordinates %o",
    async (override) => {
      const f = await fixture(new StandardWakeupInstance());
      await f.deliver(incoming(), override);
      expect(f.snapshots).toEqual([undefined]);
      await f.agent.stop();
    },
  );

  it("refuses a bot message or a channel routed to another runtime", async () => {
    const f = await fixture(new StandardWakeupInstance());
    const self = incoming();
    self.event.user!.isBot = true;
    await f.deliver(self);
    f.changeRoute();
    await f.deliver(incoming(2));
    expect(f.snapshots).toEqual([undefined, undefined]);
    await f.agent.stop();
  });

  it("refuses manual, delayed and replayed wakes even inside the original middleware lineage", async () => {
    const f = await fixture(new StandardWakeupInstance({ direct: false, keywords: ["wake"] }));
    const session = incoming();
    await f.receive(session, async () => {
      await f.append(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      f.agent.continue("manual");
      await f.agent.wait();
      await f.append(session, { content: "wake" });
      await f.agent.wait();
    });
    expect(f.snapshots).toEqual([undefined, undefined]);
    await f.agent.stop();
  });

  it("revokes authority once another user's message joins the turn", async () => {
    const notes: boolean[] = [];
    const f = await fixture(new StandardWakeupInstance(), async (origin) => {
      const bound = origin.current()!;
      notes.push(origin.valid(bound));
      await f.agent.channel.emit("agent", { type: "message.appended", message: message(incoming(2)) });
      notes.push(origin.valid(bound));
    });
    await f.deliver(incoming());
    expect(notes).toEqual([true, false]);
    await f.agent.stop();
  });

  it.each(["deleted", "superseded"])("keeps an inbound message %s before prompt assembly from acquiring authority", async (change) => {
    const f = await fixture(new StandardWakeupInstance());
    const first = incoming();
    f.internal(first);
    if (change === "superseded") f.internal(incoming(2));
    else f.internal({ ...first, type: "message-deleted" } as Session);
    await f.deliver(new Proxy(first, {}));
    expect(f.snapshots).toEqual([undefined]);
    await f.agent.stop();
  });

  it("rejects an older tool closure and a background callback running inside another user's turn", async () => {
    const later = Promise.withResolvers<void>();
    let old: BoundOrigin | undefined;
    let oldJob: Promise<void> | undefined;
    const notes: boolean[] = [];
    const f = await fixture(new StandardWakeupInstance(), async (origin) => {
      const current = origin.current()!;
      if (!old) {
        old = current;
        oldJob = later.promise.then(() => {
          notes.push(origin.valid(old!), origin.valid(currentSecond!));
        });
      } else {
        currentSecond = current;
        notes.push(origin.valid(current), origin.valid(old));
        later.resolve();
        await oldJob;
      }
    });
    let currentSecond: BoundOrigin | undefined;
    await f.deliver(incoming());
    await f.deliver(incoming(2));
    expect(notes).toEqual([true, false, false, false]);
    await f.agent.stop();
  });
});
