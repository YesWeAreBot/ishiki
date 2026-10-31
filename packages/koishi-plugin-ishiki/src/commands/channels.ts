import path from "node:path";

import type { Command, Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import { overlaps, readProfileRaw, resolveProfile, type ChannelFilter } from "../profile/index.js";
import { CONFIRM_OPTION, confirm, hasAuthority, optionText, positional } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatChannelClaim, formatChannelList } from "./format.js";
import { resolveChannelAddress } from "./targets.js";

const READ = 2;

export function registerChannelCommands(_ctx: Context, host: Ishiki, root: Command, write: number): void {
  const channels = host.management.channels;
  const logger = host.logger;
  const channel = root.subcommand(".channel", "频道归属查询与变更", { authority: 1 });

  channel.subcommand(".show [address]", "查询频道归属（缺省为本频道）", { authority: 1 }).action(
    wrapAction(logger, async (argv) => {
      const explicit = positional(argv, 0);
      if (explicit !== undefined && !hasAuthority(argv.session, READ)) return "权限不足";
      return formatChannelClaim(await channels.lookup(resolveChannelAddress(explicit, argv.session)));
    }),
  );

  channel
    .subcommand(".check [address]", "列出会认领该频道的全部 Profile 并标记重叠", { authority: READ })
    .option("profile", "--profile <id>")
    .action(
      wrapAction(logger, async (argv) => {
        const explicit = positional(argv, 0);
        const address = resolveChannelAddress(explicit, argv.session);
        const sid = `${address.platform}:${address.selfId}`;
        const view = await channels.lookup(address);

        const filters = new Map<string, ChannelFilter>();
        const profilesRoot = path.join(host.dataPath, "profiles");
        for (const claimant of view.savedClaimants) {
          const raw = await readProfileRaw(profilesRoot, claimant);
          if (raw === undefined) continue;
          try {
            const filter = resolveProfile(raw, claimant, path.join(profilesRoot, claimant)).channels.get(sid);
            if (filter !== undefined) filters.set(claimant, filter);
          } catch {
            continue;
          }
        }
        const candidate = optionText(argv, "profile");
        if (candidate !== undefined) {
          const raw = await readProfileRaw(profilesRoot, candidate);
          if (raw === undefined) throw new ManagementError("not-found", `Profile ${candidate} 不存在`);
          const filter = resolveProfile(raw, candidate, path.join(profilesRoot, candidate)).channels.get(sid);
          if (filter !== undefined) filters.set(candidate, filter);
        }

        const names = [...filters.keys()];
        const conflicting = new Set<string>();
        for (let left = 0; left < names.length; left += 1) {
          for (let right = left + 1; right < names.length; right += 1) {
            if (overlaps(filters.get(names[left])!, filters.get(names[right])!)) {
              conflicting.add(names[left]);
              conflicting.add(names[right]);
            }
          }
        }
        const lines = names.map((name) =>
          conflicting.has(name) ? `⚠ ${name}（与其他 Profile 重叠）` : `${name}${name === view.profileId ? "（当前归属）" : ""}`,
        );
        return [`频道 ${view.address} 的认领名单：`, ...(lines.length > 0 ? lines : ["（没有任何 Profile 的磁盘配置会认领该频道）"])].join("\n");
      }),
    );

  channel
    .subcommand(".list", "频道归属列表（RuntimeMeta 反查）", { authority: READ })
    .option("profile", "--profile <id>")
    .action(wrapAction(logger, async (argv) => formatChannelList(await channels.list({ profileId: optionText(argv, "profile") }))));

  channel.subcommand(".claim <profileId> [address]", "把频道精确认领给 Profile（完成后立即重应用）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const profileId = positional(argv, 0);
      const explicit = positional(argv, 1);
      if (profileId === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      const address = resolveChannelAddress(explicit, argv.session);
      const view = await channels.claim(profileId, address);
      return `${formatChannelClaim(view)}\n归属变更完成，受影响的激活 Profile 已重应用。`;
    }),
  );

  channel
    .subcommand(".release [address]", "从当前归属 Profile 移除精确认领（通配模式请用 ishiki.profile.channel.remove）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const explicit = positional(argv, 0);
        const address = resolveChannelAddress(explicit, argv.session);
        const current = await channels.lookup(address);
        const proceed = await confirm(argv, `将把 ${current.address} 从 Profile ${current.profileId ?? "（无归属）"} 的认领表移除，其 Runtime 将停止并重应用`);
        if (proceed !== true) return proceed;
        const view = await channels.release(address);
        return `${formatChannelClaim(view)}\n释放完成。`;
      }),
    );

  channel
    .subcommand(".move <profileId> [address]", "把频道从当前归属迁移到目标 Profile（释放 + 认领的原子组合）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const profileId = positional(argv, 0);
        const explicit = positional(argv, 1);
        if (profileId === undefined) throw new ManagementError("invalid", "请提供目标 Profile 标识");
        const address = resolveChannelAddress(explicit, argv.session);
        const current = await channels.lookup(address);
        if (current.profileId === undefined) throw new ManagementError("not-found", `频道 ${current.address} 当前没有激活的归属`);
        const affected = (await host.management.profiles.status(current.profileId)).runtimes.length;
        const proceed = await confirm(
          argv,
          `频道 ${current.address}：Profile ${current.profileId} → Profile ${profileId}，${current.profileId} 的 ${affected} 个 Runtime 将停止重建`,
        );
        if (proceed !== true) return proceed;
        const view = await channels.move(profileId, address);
        return `${formatChannelClaim(view)}\n迁移完成。`;
      }),
    );
}
