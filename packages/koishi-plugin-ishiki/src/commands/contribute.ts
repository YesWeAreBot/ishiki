import type { Argv, Awaitable, Context } from "koishi";

import type Ishiki from "../index.js";
import { ManagementError } from "../management/errors.js";
import type { RuntimeView } from "../management/types.js";
import type { AgentRuntime } from "../runtime.js";
import { positional } from "./context.js";
import { renderError } from "./errors.js";
import { resolveRuntime } from "./targets.js";

export interface ExtensionCommandDecl {
  /** 必须形如 ishiki.<registrant>.<rest>，注册表校验前缀属于本扩展。 */
  name: string;
  description: string;
  /** Koishi 参数声明，如 "<skill> [text]"；target 为 runtime 时约定第一个位置参数是可选 runtimeId。 */
  decl?: string;
  options?: Array<{ name: string; decl: string; description?: string }>;
  /** 最低权限，默认 2。 */
  authority?: number;
  /** 目标要求：runtime 表示执行前必须解析出唯一且在运行的 Runtime。 */
  target: { kind: "runtime" } | { kind: "none" };
  /** 目标 Runtime 的能力要求：RuntimeMeta 的引擎三元组与 Profile 的扩展启用表。 */
  requires?: {
    engines?: Partial<Record<"context" | "wakeup" | "toolcall", string | string[]>>;
    extensions?: string[];
  };
  action: (argv: Argv, runtime: (RuntimeView & { instance: AgentRuntime }) | undefined) => Awaitable<string | void>;
}

/** 扩展与宿主引擎贡献指令的注册子模块，挂在宿主服务上（ctx.ishiki.commands）；
 * 贡献指令与内置指令走同一执行管线。 */
export class IshikiCommands {
  /** 指令层开关：commands.enable 为 false 时内置指令组不装配，注册入口拒绝。 */
  public readonly enabled: boolean;

  private readonly registered = new Map<string, { registrant: string; dispose: () => void }>();

  constructor(
    private readonly host: Ishiki,
    /** 无 fiber 的注册落在这个上下文上，随宿主一起销毁。 */
    private readonly context: Context,
  ) {
    this.enabled = host.config.commands.enable;
  }

  /**
   * 注册一条贡献指令。registrant 为注册者名字（扩展名或引擎名），decl.name 必须以
   * `ishiki.<registrant>.` 开头；fiber 传注册者自身上下文时，指令随其卸载自动注销。
   */
  public register(decl: ExtensionCommandDecl, registrant: string, fiber?: Context): void {
    if (!this.enabled) {
      throw new ManagementError("rejected", "管理指令层已停用（commands.enable=false），无法注册贡献指令");
    }
    const prefix = `ishiki.${registrant}.`;
    if (!decl.name.startsWith(prefix)) {
      throw new ManagementError("invalid", `贡献指令 ${decl.name} 必须以 ${prefix} 开头`);
    }
    const existing = this.registered.get(decl.name);
    if (existing !== undefined) {
      throw new ManagementError("conflict", `指令 ${decl.name} 已由 ${existing.registrant} 注册`);
    }

    const owner = fiber ?? this.context;
    const definition = `${decl.name}${decl.decl === undefined ? "" : ` ${decl.decl}`}`;
    const command = owner.command(definition, decl.description, { authority: decl.authority ?? 2 });
    for (const option of decl.options ?? []) {
      command.option(option.name, option.decl);
    }
    const run = this.pipeline(decl);
    command.action(async (argv) => run(argv));

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.registered.delete(decl.name);
      command.dispose();
    };
    this.registered.set(decl.name, { registrant, dispose });
    owner.on("dispose", dispose);
  }

  public list(): Array<{ name: string; registrant: string }> {
    return [...this.registered.entries()].map(([name, entry]) => ({ name, registrant: entry.registrant }));
  }

  /** 与内置指令共用的执行管线：目标解析 → 能力检查 → 动作。 */
  private pipeline(decl: ExtensionCommandDecl): (argv: Argv) => Promise<string | void> {
    return async (argv) => {
      try {
        let runtime: (RuntimeView & { instance: AgentRuntime }) | undefined;
        if (decl.target.kind === "runtime") {
          const target = await resolveRuntime(this.host, positional(argv, 0), (argv.options ?? {}) as { runtime?: string; profile?: string }, argv.session);
          this.checkRequirements(decl, target.view);
          if (target.instance === undefined) {
            throw new ManagementError("rejected", `Runtime ${target.view.id} 未运行，先执行 ishiki.runtime.wake`);
          }
          runtime = { ...target.view, instance: target.instance };
        }
        const result = await decl.action(argv, runtime);
        return result;
      } catch (error) {
        return renderError(error, this.host.logger);
      }
    };
  }

  private checkRequirements(decl: ExtensionCommandDecl, view: RuntimeView): void {
    for (const [family, wanted] of Object.entries(decl.requires?.engines ?? {}) as Array<["context" | "wakeup" | "toolcall", string | string[]]>) {
      const allowed = Array.isArray(wanted) ? wanted : [wanted];
      if (!allowed.includes(view.engines[family])) {
        throw new ManagementError("rejected", `Runtime ${view.id} 的 ${family} 引擎是 ${view.engines[family] || "未知"}，该指令要求 ${allowed.join("/")}`);
      }
    }
    const profile = this.host.findProfile(view.profileId);
    for (const name of decl.requires?.extensions ?? []) {
      if (profile === undefined || !(name in profile.extensions)) {
        throw new ManagementError("rejected", `Runtime ${view.id} 未启用扩展 ${name}，先执行 ishiki.profile.ext.enable ${view.profileId} ${name}`);
      }
    }
  }
}

/** 管线保证 target 为 runtime 的贡献指令一定拿到在运行的实例；此助手供动作收窄类型。 */
export function expectRuntime(runtime: (RuntimeView & { instance: AgentRuntime }) | undefined): RuntimeView & { instance: AgentRuntime } {
  if (runtime === undefined) throw new ManagementError("rejected", "该指令需要 Runtime 目标");
  return runtime;
}
