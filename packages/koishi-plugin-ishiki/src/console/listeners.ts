import path from "node:path";

import type { Client } from "@koishijs/console";
import type { Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError, describeError } from "../management/errors.js";
import { getJevTrace } from "../wakeup/jev.engine.js";
import { CacheProvider, JevProvider, ModelsProvider, ProfilesProvider, RuntimesProvider, SessionsProvider, UsageProvider } from "./services.js";
import type { ConsoleResult } from "./types.js";

const READ = 1;
const WRITE = 3;

function operator(client: Client): string {
  return client.request?.socket.remoteAddress ?? client.id;
}

async function run<T>(task: () => T | Promise<T>): Promise<ConsoleResult<T>> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    const code = error instanceof ManagementError ? error.code : "failed";
    const details = error instanceof ManagementError ? error.details : undefined;
    return { ok: false, error: { code, message: describeError(error).message, details } };
  }
}

/** 注册控制台数据服务、写操作与广播；控制台只通过这里接触核心运行时。 */
export function installConsole(ctx: Context, host: Ishiki): void {
  const management = host.management;
  const jevTrace = getJevTrace(ctx);

  ctx.plugin(ModelsProvider, host);
  ctx.plugin(ProfilesProvider, host);
  ctx.plugin(RuntimesProvider, host);
  ctx.plugin(SessionsProvider, host);
  ctx.plugin(UsageProvider, host);
  ctx.plugin(CacheProvider, host);
  ctx.plugin(JevProvider, host);

  management.events.on("models.changed", (payload) => {
    ctx.get("console")?.broadcast("models.changed", payload, { authority: READ });
    void ctx.get("console.services.ishikiModels")?.refresh();
  });
  management.events.on("profiles.changed", (payload) => {
    ctx.get("console")?.broadcast("profiles.changed", payload, { authority: READ });
    void ctx.get("console.services.ishikiProfiles")?.refresh();
    void ctx.get("console.services.ishikiRuntimes")?.refresh();
    void ctx.get("console.services.ishikiSessions")?.refresh();
  });
  management.events.on("runtimes.changed", (payload) => {
    ctx.get("console")?.broadcast("runtimes.changed", payload, { authority: READ });
    void ctx.get("console.services.ishikiRuntimes")?.refresh();
    void ctx.get("console.services.ishikiProfiles")?.refresh();
  });
  management.events.on("sessions.appended", (payload) => {
    ctx.get("console")?.broadcast("sessions.appended", payload, { authority: READ });
    void ctx.get("console.services.ishikiSessions")?.refresh();
    void ctx.get("console.services.ishikiUsage")?.refresh();
  });

  // 每次唤醒判定都会刷新一次观测面板；判定本身已按 debounce 限流，这里不做额外采样。
  const disposeTrace = jevTrace.subscribe(() => {
    ctx.get("console")?.broadcast("jev.changed", {}, { authority: READ });
    void ctx.get("console.services.ishikiJev")?.refresh();
  });
  ctx.on("dispose", () => disposeTrace());

  ctx.console.addListener("ishiki/models/validate", (input) => run(() => host.management.models.validate(input)), { authority: READ });
  ctx.console.addListener("ishiki/models/remote", (query) => run(() => host.management.models.listRemote(query)), { authority: READ });
  ctx.console.addListener(
    "ishiki/models/save",
    function (this: Client, input) {
      return run(() => host.management.models.save(input.config, input.revision, operator(this)));
    },
    { authority: WRITE },
  );

  ctx.console.addListener("ishiki/profiles/read", (id) => run(() => host.management.profiles.read(id)), { authority: READ });
  ctx.console.addListener("ishiki/profiles/status", (id) => run(() => host.management.profiles.status(id)), { authority: READ });
  ctx.console.addListener(
    "ishiki/profiles/save",
    async function (this: Client, id, input, revision) {
      return run(() => host.management.profiles.save(id, input, revision, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/create",
    async function (this: Client, id, input) {
      return run(() => host.management.profiles.createFromInput(id, input, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/apply",
    async function (this: Client, id) {
      return run(() => host.management.profiles.apply(id, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/reload",
    async function (this: Client, id) {
      return run(() => host.management.profiles.reload(id, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/stop",
    async function (this: Client, id) {
      return run(() => host.management.profiles.stop(id, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/remove",
    async function (this: Client, id) {
      return run(async () => {
        await host.management.profiles.remove(id, operator(this));
        return null;
      });
    },
    { authority: WRITE },
  );

  ctx.console.addListener("ishiki/runtimes/read", (id) => run(() => host.management.runtimes.read(id)), { authority: READ });
  ctx.console.addListener(
    "ishiki/runtimes/wake",
    async function (this: Client, id, prompt) {
      return run(() => host.management.runtimes.wake(id, prompt, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/restart",
    async function (this: Client, id) {
      return run(() => host.management.runtimes.restart(id, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/stop",
    async function (this: Client, id) {
      return run(() => host.management.runtimes.stop(id, operator(this)));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/interrupt",
    async function (this: Client, id) {
      return run(() => host.management.runtimes.interrupt(id, operator(this)));
    },
    { authority: WRITE },
  );

  ctx.console.addListener("ishiki/sessions/list", (filters) => run(() => host.management.sessions.list(filters)), { authority: READ });
  ctx.console.addListener(
    "ishiki/sessions/entries",
    (id, cursor, limit, filters, direction) => run(() => host.management.sessions.read(id, cursor, limit, filters, direction)),
    { authority: READ },
  );

  ctx.console.addListener("ishiki/observability/usage", (filters) => run(() => host.management.usage.snapshot(filters)), { authority: READ });
  ctx.console.addListener("ishiki/observability/cache", () => run(() => host.management.cache.read()), { authority: READ });
  ctx.console.addListener("ishiki/jev/trace", () => run(() => jevTrace.snapshot()), { authority: READ });

  ctx.console.addEntry(path.join(ctx.baseDir, "node_modules", "koishi-plugin-ishiki", "dist"));
}
