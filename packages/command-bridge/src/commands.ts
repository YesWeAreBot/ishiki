import { Channel, User, type Argv, type Command, type Context, type Session } from "koishi";

export interface CommandPolicy {
  allow: readonly string[];
  effects: readonly string[];
  deny?: readonly string[];
}

export interface CommandEntry {
  name: string;
  aliases: string[];
  description: string;
  mode: "manual" | "execute" | "confirm";
}

const hardDeny = [
  "admin",
  "auth",
  "authority",
  "bind",
  "broadcast",
  "command",
  "commands",
  "config",
  "database",
  "echo",
  "eval",
  "exec",
  "help",
  "ishiki",
  "loader",
  "market",
  "order-notifier",
  "plugin",
  "restart",
  "role",
  "shutdown",
  "sudo",
];
const plainDomains = new Set(["string", "text", "rawtext", "number", "integer", "posint", "natural", "bigint", "date", "boolean"]);
const unavailable = () => new Error("Command unavailable for this request.");

function denied(name: string, policy: CommandPolicy): boolean {
  const value = name
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/^(?:@[^/]+\/)?koishi-plugin-/, "");
  return [...hardDeny, ...(policy.deny ?? [])].some((item) => {
    const key = item.trim().toLowerCase().replace(/_/g, "-");
    return key && (value === key || [".", "/", "-"].some((separator) => value.startsWith(key + separator)));
  });
}

function hidden(session: Session, config: { hidden?: unknown }): boolean {
  return Boolean(session.resolve(config.hidden as boolean | ((session: Session) => boolean)));
}

function usableAlias(command: Command, name: string, session: Session): boolean {
  if (!Object.hasOwn(command._aliases, name)) return false;
  const alias = command._aliases[name];
  return !alias.args?.length && !Object.keys(alias.options ?? {}).length && (session.resolve(alias.filter) ?? true);
}

type Actor = Session<"authority" | "permissions" | "flag", "permissions" | "flag" | "assignee">;

function verified(session: Actor): boolean {
  if (!session.userId || !session.selfId || !session.channelId || !session.messageId || session.userId === session.selfId) return false;
  if (session.bot.selfId !== session.selfId || session.bot.platform !== session.platform || !["message-created", "message"].includes(session.event.type))
    return false;
  if (!session.user || !Number.isInteger(session.user.authority) || session.user.authority < 0 || session.user.flag & User.Flag.ignore) return false;
  return (
    session.isDirect ||
    Boolean(
      session.channel &&
      !(session.channel.flag & (Channel.Flag.ignore | Channel.Flag.silent)) &&
      (session.channel.assignee === session.selfId || session.stripped.atSelf),
    )
  );
}

// Evaluate the numeric ceiling independently of the caller's real grants. Unknown
// permission schemes cannot establish that a command is a level-0/1 operation.
function ordinary(ctx: Context, permission: string): boolean {
  for (const dependency of ctx.permissions.subgraph("depends", [permission])) {
    let ordinaryGrant = false;
    for (const grant of ctx.permissions.subgraph("inherits", [dependency])) {
      if (grant === dependency && grant.startsWith("command:")) continue;
      if (grant !== "authority:0" && grant !== "authority:1") return false;
      ordinaryGrant = true;
    }
    if (!ordinaryGrant) return false;
  }
  return true;
}

function visible(ctx: Context, session: Session, policy: CommandPolicy, command: Command): boolean {
  if (!ctx.filter(session) || !verified(session as Actor)) return false;
  for (let node: Command | null = command; node; node = node.parent) {
    if (ctx.$commander.get(node.name, session) !== node || !usableAlias(node, node.name, session)) return false;
    if (!node.match(session) || hidden(session, node.config as { hidden?: unknown })) return false;
    if (denied(node.ctx.name ?? "", policy) || Object.keys(node._aliases).some((name) => denied(name, policy))) return false;
    if (node.config.authority !== undefined && (!Number.isInteger(node.config.authority) || node.config.authority > 1)) return false;
  }
  return ordinary(ctx, `command:${command.name}`);
}

function supported(declaration: Argv.Declaration): boolean {
  return plainDomains.has(declaration.type === undefined ? "string" : String(declaration.type));
}

function mode(command: Command, policy: CommandPolicy): CommandEntry["mode"] {
  if (!command.ctx.get("database") || !policy.allow.includes(command.name) || command._arguments.some((arg) => arg.required && !supported(arg)))
    return "manual";
  return policy.effects.includes(command.name) ? "confirm" : "execute";
}

function entry(command: Command, session: Session, policy: CommandPolicy): CommandEntry {
  return {
    name: command.name,
    aliases: Object.keys(command._aliases).filter((name) => name !== command.name && usableAlias(command, name, session)),
    description: session
      .text([`commands.${command.name}.description`, ""])
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
    mode: mode(command, policy),
  };
}

async function accessible(ctx: Context, session: Session, policy: CommandPolicy, command: Command): Promise<boolean> {
  if (!visible(ctx, session, policy, command) || !(await ctx.permissions.test(`command:${command.name}`, session))) return false;
  for (const option of Object.values(command._options)) {
    if (option.fallback !== undefined && !(await optionAllowed(ctx, session, command, option))) return false;
  }
  return visible(ctx, session, policy, command);
}

function lookup(ctx: Context, session: Session, name: string): Command | undefined {
  // Only accept an exact registered spelling. Do not interpret an alias's
  // pre-filled arguments/options or feed the tool's command name to a parser.
  const command = ctx.$commander.get(name, session);
  return command && usableAlias(command, name, session) ? command : undefined;
}

export async function listCommands(ctx: Context, session: Session, policy: CommandPolicy): Promise<CommandEntry[]> {
  const result: CommandEntry[] = [];
  const registered = ctx.$commander._commandList.slice();
  for (const command of registered) {
    try {
      if (await accessible(ctx, session, policy, command)) result.push(entry(command, session, policy));
    } catch {
      // A third-party visibility predicate can require data unavailable on this adapter.
      ctx.logger("ishiki-command-bridge").debug("Could not evaluate command %s for this session", command.name);
    }
  }
  return result;
}

async function optionAllowed(ctx: Context, session: Session, command: Command, option: Argv.OptionDeclaration): Promise<boolean> {
  const key = `command:${command.name}:option:${option.name}`;
  return !hidden(session, option as { hidden?: unknown }) && (option.authority ?? 0) <= 1 && ordinary(ctx, key) && (await ctx.permissions.test(key, session));
}

export async function commandHelp(ctx: Context, session: Session, policy: CommandPolicy, name: string): Promise<(CommandEntry & { usage: string }) | null> {
  const command = lookup(ctx, session, name);
  if (!command || !(await accessible(ctx, session, policy, command))) return null;
  const lines = [[command.name, command.declaration.trim()].filter(Boolean).join(" ")];
  for (const option of Object.values(command._options)) {
    if (await optionAllowed(ctx, session, command, option)) {
      lines.push(`${option.syntax}  ${session.text([`commands.${command.name}.options.${option.name}`, ""])}`);
    }
  }
  return { ...entry(command, session, policy), usage: lines.join("\n") };
}

export function validArguments(args: unknown): args is string[] {
  return (
    Array.isArray(args) &&
    args.length <= 16 &&
    args.every((value: unknown) => typeof value === "string" && value.length <= 2000 && !/[<>\p{Cc}]|\$\(|&(?:#|[a-z]+;)|^\s*-/iu.test(value))
  );
}

function parseArgs(ctx: Context, session: Session, command: Command, input: readonly string[]): Argv {
  const declarations = command._arguments;
  const last = declarations.at(-1);
  if (!validArguments(input)) throw new Error("Unsupported positional argument.");
  if ((input.length > declarations.length && !last?.variadic) || declarations.slice(input.length).some((arg) => arg.required))
    throw new Error("Invalid positional argument count.");
  const argv: Argv = { command, session, args: [], options: {} };
  for (const [index, value] of input.entries()) {
    const declaration = declarations[index] ?? last;
    // No command interpolation, markup, encoded markup, option syntax, or
    // caller-supplied entity/target types can enter a delegated command.
    if (!declaration || !supported(declaration)) throw new Error("Unsupported positional argument.");
    const parsed = ctx.$commander.parseValue(value, "argument", argv, declaration);
    if (argv.error) throw new Error("Invalid positional argument.");
    argv.args!.push(parsed);
  }
  // Koishi supplies declared option defaults even for a command without flags.
  return command.parse(argv);
}

export async function executeCommand(
  ctx: Context,
  source: Session,
  policy: CommandPolicy,
  name: string,
  args: readonly string[],
  guard: (entry: CommandEntry) => boolean,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (!verified(source as Actor) || !ctx.get("database")) throw unavailable();
  const originalCommand = lookup(ctx, source, name);
  if (!originalCommand || !(await accessible(ctx, source, policy, originalCommand))) throw unavailable();
  // Koishi turns may outlive message middleware. Use the same authentic event
  // and adapter, re-observe current records and flush this execution's changes.
  const session = source.bot.session(source.event);
  // Only this dispatcher keeps the native entry point. A plugin may retain
  // its session after returning, so never restore execute on the delegated one.
  const dispatch = session.execute.bind(session);
  Object.defineProperty(session, "execute", {
    value: async () => {
      throw unavailable();
    },
  });
  session.locales = source.locales;
  await session.observeUser(["authority", "permissions", "flag", "locales"]);
  if (!session.isDirect) await session.observeChannel(["permissions", "flag", "assignee", "locales"]);
  const command = lookup(ctx, session, name);
  if (command !== originalCommand || !(await accessible(ctx, session, policy, command)) || mode(command, policy) === "manual") throw unavailable();
  const argv = parseArgs(ctx, session, command, args);
  for (const name of Object.keys(argv.options ?? {})) {
    if (!(await optionAllowed(ctx, session, command, command._options[name]))) throw unavailable();
  }
  if (lookup(ctx, session, name) !== command || !visible(ctx, session, policy, command)) throw unavailable();
  const current = entry(command, session, policy);
  if (current.mode === "manual" || !stillCurrent() || !guard(current)) throw unavailable();
  // Native execution asynchronously loads command-specific fields. Check the
  // exact registration again after that await, before it runs its action.
  const unhook = ctx.root.on(
    "command/before-execute",
    (candidate) => {
      if (
        candidate === argv &&
        (lookup(ctx, source, name) !== command || !visible(ctx, source, policy, command) || mode(command, policy) !== current.mode || !stillCurrent())
      )
        throw unavailable();
    },
    true,
  );
  try {
    // Native delivery handles both returned elements and a plugin's own sends.
    // The bridge returns no content for the model to relay.
    await dispatch(argv);
  } finally {
    unhook();
    await session.user?.$update();
    await session.channel?.$update();
    if (session.guild !== session.channel) await session.guild?.$update();
  }
}
