import type { Command, Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import type { RuntimeState } from "../management/types.js";
import { CONFIRM_OPTION, confirm, operatorOf, optionNumber, optionText, positional } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatEnginesDirectory, formatExtensionsDirectory, formatSessionList, formatStatusOverview } from "./format.js";
import { sessionAddress } from "./targets.js";

const READ = 2;

export function registerEngineCommands(_ctx: Context, host: Ishiki, root: Command, write: number): void {
  const logger = host.logger;

  root.subcommand(".status", "全局概览", { authority: READ }).action(
    wrapAction(logger, async () => {
      const views = host.management.runtimes.list();
      const counts: Record<RuntimeState, number> = { idle: 0, running: 0, stopped: 0, failed: 0 };
      for (const view of views) counts[view.state] += 1;
      const lastFailed = (await host.management.audit.query({ limit: 100 })).records.find((record) => record.result === "failed");
      const providers = (await host.management.models.read()).providers.length;
      return formatStatusOverview({
        activeProfiles: [...host.profiles.keys()],
        runtimeCounts: counts,
        providers,
        lastFailed: lastFailed === undefined ? undefined : { summary: lastFailed.summary, error: lastFailed.error, timestamp: lastFailed.timestamp },
      });
    }),
  );

  const session = root.subcommand(".session", "会话管理与查询");

  session
    .subcommand(".list", "会话只读列表（条目级检查请在控制台）", { authority: READ })
    .option("profile", "--profile <id>")
    .option("limit", "--limit <n:number>")
    .action(
      wrapAction(logger, async (argv) => {
        const limit = optionNumber(argv, "limit") ?? 20;
        return formatSessionList(await host.management.sessions.list({ profileId: optionText(argv, "profile"), limit }));
      }),
    );

  session
    .subcommand(".archive [runtimeId]", "归档会话日志与资源（缺省为当前频道的会话）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const address = sessionAddress(argv.session);
        const fallback = address === undefined ? undefined : host.findSessionId(address);
        const id = positional(argv, 0) ?? fallback;
        if (id === undefined) {
          throw new ManagementError(
            "invalid",
            address === undefined ? "请提供 Runtime 标识，或在频道会话内执行" : "当前频道没有归属的 Profile，请提供 Runtime 标识",
          );
        }
        const plan = await host.management.sessions.planArchive(id);
        const proceed = await confirm(argv, `将把会话 ${id} 的 ${plan.files.join("、")} 移到实例 archives 目录，归档后该会话不再出现在会话列表`);
        if (proceed !== true) return proceed;
        const result = await host.management.sessions.archive(plan, operatorOf(argv.session));
        return `已归档会话 ${id}（${result.files.join("、")}）到 ${result.path}`;
      }),
    );

  root
    .subcommand(".engine", "引擎目录")
    .subcommand(".list", "三族引擎一览", { authority: READ })
    .action(wrapAction(logger, async () => formatEnginesDirectory(host.management.engines())));

  root
    .subcommand(".ext", "扩展目录")
    .subcommand(".list", "已加载与已知的扩展", { authority: READ })
    .action(wrapAction(logger, async () => formatExtensionsDirectory(host.management.extensions())));
}
