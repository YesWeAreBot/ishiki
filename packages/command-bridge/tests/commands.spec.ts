import memory from "@koishijs/plugin-database-memory";
import { App, Bot, h, type Context, type Fragment, type Session } from "koishi";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { commandHelp, executeCommand, listCommands, validArguments, type CommandPolicy } from "../src/commands.js";

class TestBot extends Bot {
  sent: string[] = [];
  constructor(ctx: Context) {
    super(ctx, {}, "test");
    this.selfId = "bot";
  }
  async start() {}
  async dispose() {}
  async sendMessage(_channel: string, content: Fragment) {
    this.sent.push(String(content));
    return ["delivered"];
  }
}

let app: App;
let bot: TestBot;
let source: Session;
const policy: CommandPolicy = { allow: ["roll", "claim"], effects: ["claim"] };

beforeEach(async () => {
  app = new App();
  app.plugin(memory);
  await app.start();
  await app.database.createUser("test", "human", { authority: 1, name: "original" });
  bot = new TestBot(app);
  // Vitest aliases Koishi to @koishijs/core. Mirror its session service
  // mixin on test adapters, as the upstream core command tests do.
  const sessionService = Object.getPrototypeOf(app.koishi.session);
  const create = bot.session.bind(bot);
  vi.spyOn(bot, "session").mockImplementation((event) => {
    const session = create(event);
    for (const name of Object.getOwnPropertyNames(sessionService)) {
      if (name !== "constructor") Object.defineProperty(session, name, Object.getOwnPropertyDescriptor(sessionService, name)!);
    }
    return session;
  });
  source = bot.session({
    type: "message-created",
    user: { id: "human" },
    channel: { id: "room", type: 1 },
    message: { id: "message-1", content: "roll" },
  });
  await source.observeUser(["authority", "flag", "permissions", "locales"]);
});
afterEach(async () => {
  await app.stop();
});

it("discovers live scoped registrations and omits hidden, high-authority, restricted aliases and whole denied trees", async () => {
  const roll = app
    .command("roll [sides:natural]", "Roll dice")
    .alias("dice")
    .alias("unlisted", { filter: () => false })
    .alias("preset", { options: { manage: true } });
  roll.option("detail", "-d Details").option("manage", "-m", { authority: 4 });
  const hidden = app.command("secret");
  Object.assign(hidden.config, { hidden: () => true });
  app.command("archive", { authority: 3 });
  app.command("auth/independent");
  app.guild("elsewhere").command("other-room");
  app.plugin({
    name: "order-notifier",
    apply(ctx: Context) {
      ctx.command("订单查询");
    },
  });
  const names = async () => (await listCommands(app, source, policy)).map((entry) => entry.name);
  expect(await names()).toEqual(["roll"]);
  expect(await commandHelp(app, source, policy, "dice")).toMatchObject({ name: "roll", mode: "execute", aliases: ["dice"], description: "Roll dice" });
  expect((await commandHelp(app, source, policy, "roll"))!.usage).toContain("-d");
  expect((await commandHelp(app, source, policy, "roll"))!.usage).not.toContain("-m");
  expect(await commandHelp(app, source, policy, "preset")).toBeNull();
  app.command("lottery", "New plugin");
  expect(await names()).toContain("lottery");
  expect(await commandHelp(app, source, policy, "lottery")).toMatchObject({ mode: "manual" });
  roll.dispose();
  expect(await names()).not.toContain("roll");
});

it("uses normal typed arguments, option defaults, the original actor, and exactly one adapter delivery", async () => {
  app
    .command("roll <sides:natural>")
    .option("base", "--base <n:natural>", { fallback: 1 })
    .action(({ session, options }, sides) => `${session!.userId}:${typeof sides}:${sides + options!.base!}`);
  const guard = vi.fn<() => boolean>(() => true);
  await executeCommand(app, source, policy, "roll", ["6"], guard);
  expect(guard).toHaveBeenCalledOnce();
  expect(bot.sent).toEqual(["human:number:7"]);
});

it("does not relay a plugin's own send and flushes observed state after the original middleware ended", async () => {
  app
    .command("claim")
    .userFields(["name"])
    .action(async ({ session }) => {
      session!.user!.name = "claimed";
      await session!.send(h.image("https://fixture.invalid/example.png"));
    });
  expect(await commandHelp(app, source, policy, "claim")).toMatchObject({ mode: "confirm" });
  await executeCommand(app, source, policy, "claim", [], (item) => item.mode === "confirm");
  expect(bot.sent).toHaveLength(1);
  expect(bot.sent[0]).toContain("https://fixture.invalid/example.png");
  expect(await app.database.getUser("test", "human", ["name"])).toMatchObject({ name: "claimed" });
});

it("cancels a registration removed during Koishi's deferred field attachment", async () => {
  const action = vi.fn<() => string>(() => "removed");
  const command = app.command("roll").action(action);
  command.userFields(() => {
    command.dispose();
  });
  await expect(executeCommand(app, source, policy, "roll", [], () => true)).rejects.toThrow("unavailable");
  expect(action).not.toHaveBeenCalled();
  expect(bot.sent).toEqual([]);
});

it("blocks nested and deferred execution on a delegated session while preserving the sender's normal command access", async () => {
  await app.database.setUser("test", "human", { authority: 4 });
  source.user = undefined;
  await source.observeUser(["authority", "flag", "permissions"]);
  const restricted = vi.fn<() => string>(() => "admin result");
  const admin = app.command("admin-hidden", { authority: 3 }).action(restricted);
  Object.assign(admin.config, { hidden: true });
  const resume = Promise.withResolvers<void>();
  let nested: Error | undefined;
  let delayed: Promise<unknown> | undefined;
  app.command("roll").action(async ({ session }) => {
    const forward = session!.execute.bind(session!);
    delayed = resume.promise.then(() => forward("admin-hidden"));
    try {
      await forward({ command: admin, args: [], options: {} });
    } catch (error) {
      nested = error as Error;
    }
    return "top-level result";
  });

  await executeCommand(app, source, policy, "roll", [], () => true);
  expect(nested?.message).toContain("unavailable");
  expect(bot.sent).toEqual(["top-level result"]);
  resume.resolve();
  await expect(delayed).rejects.toThrow("unavailable");
  expect(restricted).not.toHaveBeenCalled();
  await source.execute("admin-hidden");
  expect(restricted).toHaveBeenCalledOnce();
  expect(bot.sent).toEqual(["top-level result", "admin result"]);
});

it("rechecks current actor grants, alias defaults, the action limit and untrusted arguments before running", async () => {
  const action = vi.fn<() => string>(() => "ok");
  app
    .command("roll [text]")
    .alias("preset", { args: ["sensitive"] })
    .action(action);
  for (const arg of ["--manage", "$(" + "eval)", "<execute>hidden</execute>", "&lt;execute&gt;", "a\nb"]) {
    expect(validArguments([arg])).toBe(false);
    await expect(executeCommand(app, source, policy, "roll", [arg], () => true)).rejects.toThrow("Unsupported positional argument");
  }
  await expect(executeCommand(app, source, policy, "preset", [], () => true)).rejects.toThrow("unavailable");
  await expect(executeCommand(app, source, policy, "roll", [], () => false)).rejects.toThrow("unavailable");
  await app.database.setUser("test", "human", { authority: 0 });
  await expect(executeCommand(app, source, policy, "roll", [], () => true)).rejects.toThrow("unavailable");
  expect(action).not.toHaveBeenCalled();
});

it("matches the actual group and refuses a newly reassigned or muted channel", async () => {
  const group = bot.session({
    type: "message-created",
    user: { id: "human" },
    guild: { id: "g" },
    channel: { id: "g", type: 0 },
    message: { id: "group-message", content: "roll", elements: [] },
  });
  await app.database.createChannel("test", "g", { assignee: "bot", guildId: "g" });
  await group.observeUser(["authority", "flag", "permissions"]);
  await group.observeChannel(["flag", "assignee", "permissions"]);
  app
    .guild("g")
    .command("roll")
    .action(() => "group result");
  expect(await listCommands(app, source, policy)).toEqual([]);
  await executeCommand(app, group, policy, "roll", [], () => true);
  await app.database.setChannel("test", "g", { assignee: "other-bot" });
  await expect(executeCommand(app, group, policy, "roll", [], () => true)).rejects.toThrow("unavailable");
  await app.database.setChannel("test", "g", { assignee: "bot", flag: 4 });
  await expect(executeCommand(app, group, policy, "roll", [], () => true)).rejects.toThrow("unavailable");
  expect(bot.sent).toEqual(["group result"]);
});

it("applies the maximum level even to administrators and rejects missing actor proof", async () => {
  await app.database.setUser("test", "human", { authority: 5 });
  source.user = undefined;
  await source.observeUser(["authority", "flag", "permissions"]);
  app.command("high", { permissions: ["authority:4"] });
  app.permissions.define("custom-power", { check: () => true });
  app.command("custom", { permissions: ["custom-power"] });
  app.command("default-flag").option("private", "--private", { authority: 3, fallback: true });
  app.command("lookup <who:user>");
  expect(await listCommands(app, source, { allow: ["high", "custom", "default-flag", "lookup"], effects: [] })).toEqual([
    expect.objectContaining({ name: "lookup", mode: "manual" }),
  ]);
  source.user = undefined;
  expect(await listCommands(app, source, policy)).toEqual([]);
});
