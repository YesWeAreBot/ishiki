import path from "node:path";

import type { Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError, describeError } from "../management/errors.js";
import { JEV_TRACE_SERVICE, requireJevTrace } from "../wakeup/jev.engine.js";
import { JevProvider, ModelsProvider, ProfilesProvider, RuntimesProvider, SessionsProvider, UsageProvider } from "./services.js";
import type { ConsoleResult } from "./types.js";

const READ = 1;
const WRITE = 3;

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

  ctx.plugin(ModelsProvider, host);
  ctx.plugin(ProfilesProvider, host);
  ctx.plugin(RuntimesProvider, host);
  ctx.plugin(SessionsProvider, host);
  ctx.plugin(UsageProvider, host);
  // JEV 面板依赖 jev 引擎注册的轨迹服务；引擎缺席时只少这一块面板，其余控制台照常工作。
  ctx.inject(["console", JEV_TRACE_SERVICE], (injected) => installJevConsole(injected, host));

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

  ctx.console.addListener("ishiki/models/validate", (input) => run(() => host.management.models.validate(input)), { authority: READ });
  ctx.console.addListener("ishiki/models/remote", (query) => run(() => host.management.models.listRemote(query)), { authority: READ });
  ctx.console.addListener(
    "ishiki/models/save",
    function (input) {
      return run(() => host.management.models.save(input.config, input.revision));
    },
    { authority: WRITE },
  );

  ctx.console.addListener("ishiki/profiles/read", (id) => run(() => host.management.profiles.read(id)), { authority: READ });
  ctx.console.addListener("ishiki/profiles/status", (id) => run(() => host.management.profiles.status(id)), { authority: READ });
  ctx.console.addListener(
    "ishiki/profiles/save",
    async function (id, input, revision) {
      return run(() => host.management.profiles.save(id, input, revision));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/create",
    async function (id, input) {
      return run(() => host.management.profiles.createFromInput(id, input));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/apply",
    async function (id) {
      return run(() => host.management.profiles.apply(id));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/reload",
    async function (id) {
      return run(() => host.management.profiles.reload(id));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/stop",
    async function (id) {
      return run(() => host.management.profiles.stop(id));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/profiles/remove",
    async function (id) {
      return run(async () => {
        await host.management.profiles.remove(id);
        return null;
      });
    },
    { authority: WRITE },
  );

  ctx.console.addListener("ishiki/runtimes/read", (id) => run(() => host.management.runtimes.read(id)), { authority: READ });
  ctx.console.addListener(
    "ishiki/runtimes/wake",
    async function (id, prompt) {
      return run(() => host.management.runtimes.wake(id, prompt));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/restart",
    async function (id) {
      return run(() => host.management.runtimes.restart(id));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/stop",
    async function (id) {
      return run(() => host.management.runtimes.stop(id));
    },
    { authority: WRITE },
  );
  ctx.console.addListener(
    "ishiki/runtimes/interrupt",
    async function (id) {
      return run(() => host.management.runtimes.interrupt(id));
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

  ctx.console.addEntry(path.join(ctx.baseDir, "node_modules", "koishi-plugin-ishiki", "dist"));
}

/** 注册 JEV 观测面板：控制台与轨迹服务同时可用时装载，任一消失时随上下文清理。 */
function installJevConsole(ctx: Context, host: Ishiki): void {
  const jevTrace = requireJevTrace(ctx);

  ctx.plugin(JevProvider, host);

  // 每次唤醒判定都会刷新一次观测面板；判定本身已按 debounce 限流，这里不做额外采样。
  const disposeTrace = jevTrace.subscribe(() => {
    ctx.get("console")?.broadcast("jev.changed", {}, { authority: READ });
    void ctx.get("console.services.ishikiJev")?.refresh();
  });
  ctx.on("dispose", () => disposeTrace());

  ctx.console.addListener("ishiki/jev/trace", () => run(() => jevTrace.snapshot()), { authority: READ });
}
