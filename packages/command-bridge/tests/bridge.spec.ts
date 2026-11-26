import { Bot, type Context, type Session } from "koishi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { startApp, writeProfile, type TestSetup } from "../../koishi-plugin-ishiki/tests/harness.js";
import CommandBridge from "../src/index.js";

class BridgePlugin {
  constructor(ctx: Context) {
    ctx.plugin(CommandBridge, { allow: ["draw-card", "second-only"], confirm: ["stamp"] });
  }
}

interface Call {
  name: string;
  args?: Record<string, unknown>;
}

function reply(calls: Call[]): Response {
  const tool_calls = calls.map((call, index) => ({
    index,
    id: `call-${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify({ i: "requested operation", ...call.args }) },
  }));
  const parts = [
    { delta: { role: "assistant", tool_calls }, finish_reason: null },
    { delta: {}, finish_reason: "tool_calls" },
  ];
  const stream = parts.map(
    (part) =>
      "data: " + JSON.stringify({ id: "answer", object: "chat.completion.chunk", model: "vision", created: 1, choices: [{ index: 0, ...part }] }) + "\n\n",
  );
  return new Response(stream.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

let setup: TestSetup;
let calls: Call[][], sent: string[], receipts: Array<{ name: string; value: unknown }>;
let beforeResponse: (() => void | Promise<void>) | undefined;
let serial = 0;

beforeEach(async () => {
  calls = [];
  sent = [];
  receipts = [];
  beforeResponse = undefined;
  vi.stubGlobal("fetch", async () => {
    const before = beforeResponse;
    beforeResponse = undefined;
    await before?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return reply(calls.shift() ?? [{ name: "finish" }]);
  });
  setup = await startApp({
    plugins: [BridgePlugin],
    users: [
      { id: "alice", authority: 1 },
      { id: "bob", authority: 1 },
    ],
  });
  const { app, bot } = setup;
  vi.spyOn(bot, "sendMessage").mockImplementation(async (_channelId, content) => {
    sent.push(String(content));
    return [`out-${sent.length}`];
  });
  app
    .command("draw-card <sides:natural>", "Draw a card")
    .alias("draw")
    .action(({ session }, sides) => `drawn:${session!.userId}:${typeof sides}:${sides}`);
  app
    .command("stamp", "Stamp the requesting account")
    .userFields(["name"])
    .action(({ session }) => {
      session!.user!.name = "stamped";
      return `stamped:${session!.userId}`;
    });
  await writeProfile(setup.dataPath, "demo", {
    model: "mock:vision",
    mode: "channel",
    channels: { "test:10001": ["*"] },
    codemode: { enable: false },
    wakeup: { engine: "willingness", willingness: { directForce: true } },
    extends: { "command-bridge": { enable: true, config: { restrictCommands: true, only: ["draw-card", "stamp"] } } },
  });
  await setup.host.management.profiles.apply("demo");
  setup.host.ensureRuntime("demo", { mode: "channel", platform: "test", selfId: "10001", channelId: "room1" });
});

afterEach(async () => {
  try {
    await setup?.stop();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function session(user: string, content: string, channelId = "room1", bot: Pick<TestSetup["bot"], "session"> = setup.bot): Session {
  const created = setup.app.reflect.trace(
    bot.session({
      type: "message-created",
      user: { id: user, name: user },
      channel: { id: channelId, type: 1 },
      message: { id: `in-${++serial}`, content },
      timestamp: Date.now(),
    }),
  ) as unknown as Session;
  created.content = content;
  return created;
}

function deliver(event: Session) {
  event.bot.dispatch(event);
}

async function turn(event: Session, tools: Call[]) {
  const rt = setup.host.findRuntimeByAddress({ platform: event.platform, selfId: event.selfId, channelId: event.channelId! })!;
  const done = Promise.withResolvers<string>();
  const unsubscribe = rt.agent.channel.subscribe("agent", (e) => {
    if (e.type === "tool.done") receipts.push({ name: e.toolName, value: e.result });
    if (e.type === "turn.done" || e.type === "turn.failed") done.resolve(e.type === "turn.failed" ? (e.error?.message ?? e.type) : e.type);
  });
  try {
    calls.push(tools);
    deliver(event);
    expect(await done.promise).toBe("turn.done");
    await rt.agent.wait();
  } finally {
    unsubscribe();
  }
}

it("discovers commands live, receives model-selected tool calls, and delivers exactly one typed command result under concurrent calls", async () => {
  await turn(session("alice", "Please draw me a card"), [
    { name: "koishi_command_list", args: { query: "draw" } },
    { name: "koishi_command_help", args: { name: "draw" } },
    { name: "koishi_execute", args: { name: "draw-card", args: ["6"] } },
    { name: "koishi_execute", args: { name: "draw-card", args: ["7"] } },
  ]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/^drawn:alice:number:[67]$/);
  expect(receipts).toContainEqual({ name: "koishi_command_help", value: expect.objectContaining({ name: "draw-card", mode: "execute", aliases: ["draw"] }) });
  expect(receipts).toContainEqual({ name: "koishi_command_list", value: expect.objectContaining({ total: 1 }) });
  const extra = setup.app.command("weather", "Forecast").action(() => "weather!");
  const lookup = { name: "koishi_command_list", args: { query: "weather" } };
  await turn(session("alice", "What can you do now?"), [lookup]);
  expect(receipts.filter((x) => x.name === lookup.name).at(-1)?.value).toMatchObject({ commands: [{ name: "weather", mode: "manual" }] });
  extra.dispose();
  await turn(session("alice", "Does that still exist?"), [lookup]);
  expect(receipts.filter((x) => x.name === lookup.name).at(-1)?.value).toMatchObject({ total: 0 });
});

it("requires a fresh confirmation from the same real sender and changes only that user's database record", async () => {
  const source = session("alice", "Please stamp my account");
  await turn(source, [{ name: "koishi_execute", args: { name: "stamp" } }]);
  expect(receipts).toContainEqual({ name: "koishi_execute", value: { status: "awaiting_confirmation" } });
  expect(sent).toHaveLength(1);
  const confirmation = sent[0].match(/确认执行 [a-f0-9]{16}/)?.[0];
  expect(confirmation).toBeDefined();
  await turn(session("bob", confirmation!), [{ name: "finish" }]);
  expect(sent).toHaveLength(1);
  const confirmationMessage = session("alice", confirmation!);
  expect(confirmationMessage.content).toBe(confirmation);
  deliver(confirmationMessage);
  await vi.waitFor(() => expect(sent.at(-1)).toBe("stamped:alice"));
  await turn(session("alice", confirmation!), [{ name: "finish" }]);
  expect(sent).toHaveLength(2);
  expect(await setup.app.database.getUser("test", "alice", ["name"])).toMatchObject({ name: "stamped" });
  expect((await setup.app.database.getUser("test", "bob", ["name"]))?.name).not.toBe("stamped");
});

it("uses the current bot's catalog, profile policy and adapter in a shared channel", async () => {
  class SecondBot extends Bot {
    async start() {}
    async dispose() {}
  }
  const second = new SecondBot(setup.app, {}, "test");
  second.selfId = "10002";
  const secondSend = vi.spyOn(second, "sendMessage").mockResolvedValue(["second-receipt"]);
  const { app, host } = setup;
  app.self("10001").command("first-only", "Available on the first bot");
  app
    .self("10002")
    .command("second-only", "Available on the second bot")
    .action(({ session }) => `served:${session!.platform}:${session!.selfId}:${session!.channelId}:${session!.userId}`);
  await writeProfile(setup.dataPath, "second", {
    model: "mock:vision",
    mode: "channel",
    channels: { "test:10002": ["room1"] },
    codemode: { enable: false },
    wakeup: { engine: "standard", standard: { direct: true } },
    extends: { "command-bridge": { enable: true, config: { restrictCommands: true, only: ["second-only"] } } },
  });
  await host.management.profiles.apply("second");
  host.ensureRuntime("second", { mode: "channel", platform: "test", selfId: "10002", channelId: "room1" });
  async function catalog(event: Session) {
    await turn(event, [{ name: "koishi_command_list" }]);
    const result = receipts.findLast((r) => r.name === "koishi_command_list")!.value as { commands: Array<{ name: string; mode: string }> };
    return Object.fromEntries(result.commands.map((cmd) => [cmd.name, cmd.mode]));
  }
  const firstCatalog = await catalog(session("alice", "Which commands can you run?"));
  const secondCatalog = await catalog(session("alice", "Which commands can you run?", "room1", second));
  expect(firstCatalog).toMatchObject({ "draw-card": "execute", "first-only": "manual", stamp: "confirm" });
  expect(firstCatalog).not.toHaveProperty("second-only");
  expect(secondCatalog).toMatchObject({ "draw-card": "manual", "second-only": "execute", stamp: "manual" });
  expect(secondCatalog).not.toHaveProperty("first-only");
  await turn(session("alice", "Please use the second bot's command"), [{ name: "koishi_execute", args: { name: "second-only" } }]);
  expect(receipts.filter((r) => r.name === "koishi_execute").at(-1)?.value).toEqual({ status: "unavailable" });
  await turn(session("alice", "Please use your special command", "room1", second), [{ name: "koishi_execute", args: { name: "second-only" } }]);
  expect(sent).toEqual([]);
  expect(secondSend).toHaveBeenCalledTimes(1);
  expect(secondSend.mock.calls[0]?.[0]).toBe("room1");
  expect(String(secondSend.mock.calls[0]?.[1])).toBe("served:test:10002:room1:alice");
});

it.each(["replaced command", "stopped profile"] as const)("does not redeem an old confirmation against a %s", async (change) => {
  await turn(session("alice", "Please stamp my account"), [{ name: "koishi_execute", args: { name: "stamp" } }]);
  const confirmation = sent[0]?.match(/确认执行 [a-f0-9]{16}/)?.[0];
  expect(confirmation).toBeDefined();
  const replacement = vi.fn<() => string>(() => "replacement ran");
  if (change === "replaced command") {
    setup.app.$commander.get("stamp")!.dispose();
    setup.app.command("stamp", "New plugin using the old name").action(replacement);
  } else {
    await setup.host.deactivate("demo");
  }
  deliver(session("alice", confirmation!));
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatch(/未能确认/);
  expect(replacement).not.toHaveBeenCalled();
  expect((await setup.app.database.getUser("test", "alice", ["name"]))?.name).not.toBe("stamped");
});

it("refuses the tool after the original sender changes during the asynchronous model call", async () => {
  const event = session("alice", "Please draw");
  beforeResponse = () => {
    event.event.user!.id = "bob";
  };
  await turn(event, [{ name: "koishi_execute", args: { name: "draw-card", args: ["6"] } }]);
  expect(sent).toEqual([]);
  expect(receipts).toContainEqual({ name: "koishi_execute", value: { status: "unavailable" } });
});

it.each(["withdraw", "new participant", "route change"] as const)("revokes the open turn on %s while the model reply is in flight", async (change) => {
  const event = session("alice", "Please draw");
  beforeResponse = () => {
    if (change === "withdraw") {
      const deletion = setup.bot.session({
        type: "message-deleted",
        channel: { id: event.channelId!, type: 1 },
        message: { id: event.messageId! },
      });
      setup.bot.dispatch(deletion);
    } else if (change === "new participant") {
      deliver(session("bob", "another message"));
    } else {
      vi.spyOn(setup.host, "findRuntimeByAddress").mockReturnValue(undefined);
    }
  };
  await turn(event, [{ name: "koishi_execute", args: { name: "draw-card", args: ["6"] } }]);
  expect(sent).toEqual([]);
  expect(receipts).toContainEqual({ name: "koishi_execute", value: { status: "unavailable" } });
});
