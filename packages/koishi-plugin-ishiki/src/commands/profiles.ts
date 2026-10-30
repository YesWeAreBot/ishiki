import type { Command, Context } from "koishi";

import { Extension } from "../extension.js";
import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import { serviceName } from "../registry.js";
import { CONFIRM_OPTION, confirm, hasAuthority, operatorOf, optionText, parseJsonArgument, positional, positionalText, restArguments } from "./context.js";
import { wrapAction } from "./errors.js";
import { formatCheckReport, formatPersona, formatProfileList, formatProfileView } from "./format.js";

const READ = 2;

export function registerProfileCommands(ctx: Context, host: Ishiki, root: Command, write: number): void {
  const profiles = host.management.profiles;
  const logger = host.logger;
  const profile = root.subcommand(".profile", "Profile 管理", { authority: READ });

  const savedNotApplied = (id: string): string => (host.profiles.has(id) ? `\n已保存未应用，执行 ishiki.profile.apply ${id} 生效。` : "");

  profile.subcommand(".list", "Profile 一览", { authority: READ }).action(wrapAction(logger, async () => formatProfileList(await profiles.list())));

  profile.subcommand(".show <id>", "Profile 详情", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      return formatProfileView(await profiles.read(id));
    }),
  );

  profile
    .subcommand(".create <id>", "创建最小草稿（认领表为空，需补全后才能应用）", { authority: write })
    .option("model", "--model <ref>")
    .option("mode", "--mode <mode>")
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
        const mode = optionText(argv, "mode");
        if (mode !== undefined && mode !== "channel" && mode !== "cross") throw new ManagementError("invalid", "mode 只能是 channel 或 cross");
        await profiles.create(id, { model: optionText(argv, "model"), mode }, operatorOf(argv.session));
        return `已创建 Profile ${id}，执行 ishiki.profile.check ${id} 查看补全建议`;
      }),
    );

  profile.subcommand(".check <id>", "干跑校验：配置、引擎、模型引用、指令文件与认领重叠", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      return formatCheckReport(await profiles.check(id));
    }),
  );

  profile.subcommand(".set <id> <field> <value...>", "修改标量字段（model/mode/instructions）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const field = positional(argv, 1);
      const text = positionalText(argv, 2);
      if (id === undefined || field === undefined || text === undefined) throw new ManagementError("invalid", "用法：ishiki.profile.set <id> <field> <value>");
      if (field !== "model" && field !== "mode" && field !== "instructions") {
        throw new ManagementError("invalid", "field 只能是 model、mode 或 instructions，嵌套段落请在控制台编辑");
      }
      await profiles.setField(id, field, text, operatorOf(argv.session));
      return `已修改 Profile ${id} 的 ${field}。${savedNotApplied(id).trim()}`;
    }),
  );

  const channel = profile.subcommand(".channel", "频道认领表编辑");

  channel.subcommand(".add <id> <account> <pattern...>", "为账号添加认领模式（支持 * 与 ! 排除）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const account = positional(argv, 1);
      const patterns = restArguments(argv, 2);
      if (id === undefined || account === undefined || patterns.length === 0) {
        throw new ManagementError("invalid", "用法：ishiki.profile.channel.add <id> <platform:selfId> <pattern...>");
      }
      await profiles.addChannels(id, account, patterns, operatorOf(argv.session));
      return `Profile ${id} 已认领 ${account} 的 ${patterns.join(" ")}。${savedNotApplied(id).trim()}`;
    }),
  );

  channel.subcommand(".remove <id> <account> <pattern...>", "移除账号下的认领模式", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const account = positional(argv, 1);
      const patterns = restArguments(argv, 2);
      if (id === undefined || account === undefined || patterns.length === 0) {
        throw new ManagementError("invalid", "用法：ishiki.profile.channel.remove <id> <platform:selfId> <pattern...>");
      }
      await profiles.removeChannels(id, account, patterns, operatorOf(argv.session));
      return `Profile ${id} 已移除 ${account} 的 ${patterns.join(" ")}。${savedNotApplied(id).trim()}`;
    }),
  );

  profile.subcommand(".persona <id> [text:text]", "查看或整体覆盖首个指令文件", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      const text = positionalText(argv, 1);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      if (text === undefined) return formatPersona((await profiles.read(id)).persona);
      if (!hasAuthority(argv.session, write)) return "权限不足";
      await profiles.setPersona(id, text, operatorOf(argv.session));
      return `已更新 Profile ${id} 的人格。${savedNotApplied(id).trim()}`;
    }),
  );

  const extension = profile.subcommand(".ext", "Profile 扩展配置");

  extension.subcommand(".enable <id> <name>", "启用扩展", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const [id, name] = [positional(argv, 0), positional(argv, 1)];
      if (id === undefined || name === undefined) throw new ManagementError("invalid", "用法：ishiki.profile.ext.enable <id> <name>");
      await profiles.setExtension(id, name, { enable: true }, operatorOf(argv.session));
      return `Profile ${id} 已启用扩展 ${name}。${savedNotApplied(id).trim()}`;
    }),
  );

  extension.subcommand(".disable <id> <name>", "停用扩展", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const [id, name] = [positional(argv, 0), positional(argv, 1)];
      if (id === undefined || name === undefined) throw new ManagementError("invalid", "用法：ishiki.profile.ext.disable <id> <name>");
      await profiles.setExtension(id, name, { enable: false }, operatorOf(argv.session));
      return `Profile ${id} 已停用扩展 ${name}。${savedNotApplied(id).trim()}`;
    }),
  );

  extension.subcommand(".config <id> <name> [json:text]", "查看或写入扩展配置（JSON，写入前经扩展 Schema 校验）", { authority: READ }).action(
    wrapAction(logger, async (argv) => {
      const [id, name] = [positional(argv, 0), positional(argv, 1)];
      const text = positionalText(argv, 2);
      if (id === undefined || name === undefined) throw new ManagementError("invalid", "用法：ishiki.profile.ext.config <id> <name> [json]");
      if (text === undefined) {
        const current = (await profiles.read(id)).config.extends as Record<string, { config?: unknown }> | undefined;
        const config = current?.[name]?.config;
        return config === undefined ? `Profile ${id} 未配置扩展 ${name}` : JSON.stringify(config, null, 2);
      }
      if (!hasAuthority(argv.session, write)) return "权限不足";
      const value = parseJsonArgument(text, "扩展配置");
      const loaded = Extension.list(ctx).find((entry) => serviceName(entry) === name);
      if (loaded?.Schema !== undefined) {
        try {
          loaded.Schema(value);
        } catch (error) {
          throw new ManagementError("invalid", `扩展 ${name} 的配置校验未通过: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await profiles.setExtension(id, name, { config: value }, operatorOf(argv.session));
      return `Profile ${id} 的扩展 ${name} 配置已写入。${savedNotApplied(id).trim()}`;
    }),
  );

  profile.subcommand(".apply <id>", "应用 Profile（停止现有 Runtime 并按新配置激活）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      await profiles.apply(id, operatorOf(argv.session));
      return `已应用 Profile ${id}`;
    }),
  );

  profile.subcommand(".reload <id>", "从磁盘重新激活（全部 Runtime 重建）", { authority: write }).action(
    wrapAction(logger, async (argv) => {
      const id = positional(argv, 0);
      if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
      await profiles.reload(id, operatorOf(argv.session));
      return `已重新加载 Profile ${id}，全部 Runtime 将按需重建`;
    }),
  );

  profile
    .subcommand(".stop <id>", "停用 Profile（Runtime 停止，磁盘保留）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
        const runtimes = (await profiles.status(id)).runtimes.length;
        const proceed = await confirm(argv, `将停止 Profile ${id}（当前 ${runtimes} 个 Runtime），磁盘记录保留`);
        if (proceed !== true) return proceed;
        const status = await profiles.stop(id, operatorOf(argv.session));
        return `已停用 Profile ${id}（状态 ${status.state}）`;
      }),
    );

  profile
    .subcommand(".remove <id>", "删除 Profile（仅停用状态允许）", { authority: write })
    .option(CONFIRM_OPTION.name, CONFIRM_OPTION.decl)
    .action(
      wrapAction(logger, async (argv) => {
        const id = positional(argv, 0);
        if (id === undefined) throw new ManagementError("invalid", "请提供 Profile 标识");
        const proceed = await confirm(argv, `将删除 Profile ${id} 的全部文件（含 Runtime 记录与会话日志），不可恢复`);
        if (proceed !== true) return proceed;
        await profiles.remove(id, operatorOf(argv.session));
        return `已删除 Profile ${id}`;
      }),
    );
}
