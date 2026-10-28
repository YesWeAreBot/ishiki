import type { Context } from "koishi";

import { confirm } from "../commands/context.js";
import { expectRuntime, type ExtensionCommandDecl } from "../commands/contribute.js";
import { ManagementError } from "../management/errors.js";
import type { RuntimeView } from "../management/types.js";
import type { AgentRuntime } from "../runtime.js";
import { lastCompact, StandardContextInstance } from "./standard.engine.js";

function instanceOf(runtime: RuntimeView & { instance: AgentRuntime }): StandardContextInstance {
  if (!(runtime.instance.context instanceof StandardContextInstance)) {
    throw new ManagementError("rejected", `Runtime ${runtime.id} 的 context 引擎是 ${runtime.engines.context}，该指令要求 standard`);
  }
  return runtime.instance.context;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（共 ${text.length} 字符）`;
}

/** StandardContextEngine 贡献的三条指令；作为贡献指令机制的首个实例走宿主的注册子模块与统一执行管线。 */
export function registerStandardCommands(ctx: Context): void {
  ctx.inject(["ishiki"], (fiber) => {
    const host = fiber.get("ishiki");
    if (host === undefined) throw new Error("ishiki service unavailable");
    if (!host.commands.enabled) return;
    const commands = host.commands;

    // 先建组指令：ctx.command 展开路径时只为末段定义描述，隐式创建的中间组会没有描述文本
    fiber.command("ishiki.standard", "上下文管理");
    const target = { kind: "runtime" } as const;
    const requires = { engines: { context: "standard" } } as const;

    const usage: ExtensionCommandDecl = {
      name: "ishiki.standard.usage",
      description: "上下文预算状态（装配量、估算、上限、压缩预览）",
      decl: "[runtimeId]",
      authority: 2,
      target,
      requires,
      action: async (_argv, runtime) => {
        const view = expectRuntime(runtime);
        const stats = await instanceOf(view).stats();
        const lines = [
          `Runtime ${view.id} 上下文预算：`,
          `已装配 ${stats.assembledChars} 字符，估算 ${stats.estimatedTokens} tokens${stats.rateCalibrated ? "" : "（估算率未标定，按 0.5 字符比）"}`,
          `上限 ${Math.round(stats.ceilingChars)} 字符，压缩阈值 ${Math.round(stats.targetChars)} 字符`,
          `状态：${stats.over ? "已超限" : "未超限"}${stats.compacting ? "，正在压缩" : ""}`,
          stats.lastCompact === undefined
            ? "尚无压缩历史"
            : `最近压缩：${new Date(stats.lastCompact.at).toLocaleString("zh-CN", { hour12: false })}，摘要 ${stats.lastCompact.summaryChars} 字符，锚点 ${stats.lastCompact.anchorEntryId}`,
        ];
        if (stats.plan !== undefined) {
          lines.push(
            `可压缩：${stats.plan.droppedEntries} 条消息约 ${stats.plan.droppedChars} 字符，保留最近 ${stats.plan.keptChars} 字符（ishiki.standard.compact 预览）`,
          );
        }
        return lines.join("\n");
      },
    };

    const summary: ExtensionCommandDecl = {
      name: "ishiki.standard.summary",
      description: "显示当前记忆摘要全文",
      decl: "[runtimeId]",
      authority: 2,
      target,
      requires,
      action: async (_argv, runtime) => {
        const view = expectRuntime(runtime);
        const entries = await view.instance.storage.read();
        const compact = lastCompact(entries);
        return compact === undefined ? "尚无记忆摘要" : truncate(compact.data.summary, 2000);
      },
    };

    const compact: ExtensionCommandDecl = {
      name: "ishiki.standard.compact",
      description: "手动压缩上下文（回显压缩计划，回复“确认”后执行）",
      decl: "[runtimeId]",
      authority: 2,
      target,
      requires,
      action: async (argv, runtime) => {
        const view = expectRuntime(runtime);
        const instance = instanceOf(view);
        const stats = await instance.stats();
        if (stats.ceilingChars <= 0) throw new ManagementError("rejected", "该 Profile 关闭了上下文预算，没有可压缩的内容");
        if (stats.plan === undefined) return "当前无需压缩";
        if (argv.session === undefined) throw new ManagementError("rejected", "该操作需要会话确认");
        const proceed = await confirm(
          argv.session,
          `将把约 ${stats.plan.droppedEntries} 条消息（${stats.plan.droppedChars} 字符）压入摘要，保留最近 ${stats.plan.keptChars} 字符`,
        );
        if (proceed !== true) return proceed;
        const result = await instance.forceCompact();
        return result.appended ? `压缩完成：摘要 ${result.summaryChars} 字符，锚点 ${result.throughEntryId}` : "当前无需压缩";
      },
    };

    commands.register(usage, "standard", fiber);
    commands.register(summary, "standard", fiber);
    commands.register(compact, "standard", fiber);
  });
}
