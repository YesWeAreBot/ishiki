import type { Command, Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import { CONFIRM_OPTION, confirm, operatorOf, optionText, positional, restArguments } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatRuntimeList, formatRuntimeView } from "./format.js";
import { resolveRuntime, sessionAddress } from "./targets.js";

const READ = 2;

export function registerRuntimeCommands(_ctx: Context, host: Ishiki, root: Command, write: number): void {
  const runtimes = host.management.runtimes;
  const logger = host.logger;
  const runtime = root.subcommand(".runtime", "Runtime 查询与生命周期", { authority: READ });

  runtime
    .subcommand(".list", "Runtime 列表（含离线记录）", { authority: READ })
    .option("profile", "--profile <id>")
    .option("state", "--state <state>")
    .option("engine", "--engine <family:name>")
    .option("channel", "--channel <address>")
    .action(
      wrapAction(logger, async (argv) => {
        let views = runtimes.list();
        const profileId = optionText(argv, "profile");
        if (profileId !== undefined) views = views.filter((view) => view.profileId === profileId);
        const state = optionText(argv, "state");
        if (state !== undefined) {
          if (state !== "idle" && state !== "running" && state !== "stopped" && state !== "failed")
            throw new ManagementError("invalid", "state 只能是 idle、running、stopped 或 failed");
          views = views.filter((view) => view.state === state);
        }
        const engine = optionText(argv, "engine");
        if (engine !== undefined) {
          const [family, name] = [engine.slice(0, engine.indexOf(":")), engine.slice(engine.indexOf(":") + 1)];
          if (family !== "context" && family !== "wakeup" && family !== "toolcall")
            throw new ManagementError("invalid", "engine 过滤应为 context:name / wakeup:name / toolcall:name");
          views = views.filter((view) => view.engines[family] === name);
        }
        const address = optionText(argv, "channel");
        if (address !== undefined) {
          const slash = address.lastIndexOf("/");
          if (slash <= 0) throw new ManagementError("invalid", `频道坐标无效: ${address}`);
          const channelId = address.slice(slash + 1);
          views = views.filter((view) => view.channelId === channelId && address.startsWith(`${view.platform}:${view.selfId}/`));
        }
        return formatRuntimeList(views);
      }),
    );

  runtime.subcommand(".show <runtimeId>", "Runtime 详情", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Runtime 标识");
      return formatRuntimeView(runtimes.read(id));
    }),
  );

  runtime.subcommand(".wake [runtimeId] [prompt:text]", "唤醒 Runtime（离线且 Profile 激活时自动重建）", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const prompt = restArguments(argv, 1).join(" ");
      const operator = operatorOf(argv.session);
      if (id !== undefined) {
        const result = await runtimes.wake(id, prompt.length === 0 ? undefined : prompt, operator);
        return result.queued ? `Runtime ${id} 正忙，唤醒已合并进当前轮次` : `已唤醒 Runtime ${id}（轮次 ${result.turnId ?? "-"}）`;
      }
      const address = sessionAddress(argv.session);
      if (address === undefined) throw new ManagementError("invalid", "请提供 Runtime 标识，或在频道会话内执行");
      const existing = host.findRuntimeByAddress(address);
      if (existing !== undefined) {
        const result = await runtimes.wake(existing.id, prompt.length === 0 ? undefined : prompt, operator);
        return result.queued ? `Runtime ${existing.id} 正忙，唤醒已合并进当前轮次` : `已唤醒 Runtime ${existing.id}（轮次 ${result.turnId ?? "-"}）`;
      }
      const claim = host.findClaim(address);
      if (claim === undefined) throw new ManagementError("not-found", "当前频道没有归属的 Profile，无法唤醒");
      const domain = claim.profile.mode === "cross" ? { mode: "cross" as const, channels: claim.profile.channels } : { mode: "channel" as const, ...address };
      const spawned = host.ensureRuntime(claim.profile.id, domain);
      const result = await runtimes.wake(spawned.id, prompt.length === 0 ? undefined : prompt, operator);
      return result.queued ? `Runtime ${spawned.id} 正忙，唤醒已合并进当前轮次` : `已创建并唤醒 Runtime ${spawned.id}（轮次 ${result.turnId ?? "-"}）`;
    }),
  );

  runtime.subcommand(".interrupt [runtimeId]", "中断当前轮次", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const target = await resolveRuntime(host, positional(argv, 0), {}, argv.session);
      await runtimes.interrupt(target.view.id, operatorOf(argv.session));
      return `已请求中断 Runtime ${target.view.id} 的当前轮次`;
    }),
  );

  runtime
    .subcommand(".restart <runtimeId>", "重启 Runtime（停止后按原域重建）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        if (id === undefined) throw new ManagementError("invalid", "请提供 Runtime 标识");
        const proceed = await confirm(argv, `将重启 Runtime ${id}（会话中断后按原域重建，不读新配置）`);
        if (proceed !== true) return proceed;
        await runtimes.restart(id, operatorOf(argv.session));
        return `已重启 Runtime ${id}`;
      }),
    );

  runtime
    .subcommand(".stop [runtimeId]", "停止 Runtime（临时性：Profile 保持激活时下一条匹配消息会自动重建）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const target = await resolveRuntime(host, positional(argv, 0), {}, argv.session);
        const profileActive = host.profiles.has(target.view.profileId);
        const notice = profileActive
          ? `将停止 Runtime ${target.view.id}。Profile ${target.view.profileId} 仍处于激活状态，下一条匹配消息会自动重建；持久摘除请用 ishiki.channel.release`
          : `将停止 Runtime ${target.view.id}`;
        const proceed = await confirm(argv, notice);
        if (proceed !== true) return proceed;
        await runtimes.stop(target.view.id, operatorOf(argv.session));
        return `已停止 Runtime ${target.view.id}`;
      }),
    );

  runtime
    .subcommand(".reload <runtimeId>", "重载所属 Profile（全部 Runtime 重建）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        if (id === undefined) throw new ManagementError("invalid", "请提供 Runtime 标识");
        const view = runtimes.read(id);
        const proceed = await confirm(argv, `Runtime ${id} 属于 Profile ${view.profileId}，重载将重建该 Profile 的全部 Runtime`);
        if (proceed !== true) return proceed;
        await host.management.profiles.reload(view.profileId, operatorOf(argv.session));
        return `Profile ${view.profileId} 的全部 Runtime 已重建`;
      }),
    );
}
