import type { Command, Context } from "koishi";

import type Ishiki from "../index.js";
import type { RuntimeState } from "../management/types.js";
import { optionNumber, optionText } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatEnginesDirectory, formatExtensionsDirectory, formatSessionList, formatStatusOverview } from "./format.js";

const READ = 2;

export function registerEngineCommands(_ctx: Context, host: Ishiki, root: Command, _write: number): void {
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

  root
    .subcommand(".session", "会话查询")
    .subcommand(".list", "会话只读列表（条目级检查请在控制台）", { authority: READ })
    .option("profile", "--profile <id>")
    .option("limit", "--limit <n:number>")
    .action(
      wrapAction(logger, async (argv) => {
        const limit = optionNumber(argv, "limit") ?? 20;
        return formatSessionList(await host.management.sessions.list({ profileId: optionText(argv, "profile"), limit }));
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
