import type { Context } from "koishi";

import type Ishiki from "../index.js";
import { registerChannelCommands } from "./channels.js";
import { registerEngineCommands } from "./engines.js";
import { registerModelCommands } from "./models.js";
import { registerProfileCommands } from "./profiles.js";
import { registerRuntimeCommands } from "./runtimes.js";

export { IshikiCommands, expectRuntime, type ExtensionCommandDecl } from "./contribute.js";
export * from "./targets.js";

export interface CommandsSettings {
  enable: boolean;
  authority: number;
}

/** 装配全部内置指令组；贡献指令注册入口是宿主的 commands 子模块（host.commands）。 */
export function installCommands(ctx: Context, host: Ishiki, config: CommandsSettings): () => void {
  const write = config.authority;
  const root = ctx.command("ishiki", "ishiki 管理指令", { authority: 1 });
  // 贡献指令先注册时，ishiki 根指令已由路径展开隐式创建，ctx.command 会丢弃描述参数，这里显式补上
  const disposeDescription = ctx.i18n.define("", "commands.ishiki.description", "ishiki 管理指令");
  registerModelCommands(ctx, host, root, write);
  registerProfileCommands(ctx, host, root, write);
  registerRuntimeCommands(ctx, host, root, write);
  registerChannelCommands(ctx, host, root, write);
  registerEngineCommands(ctx, host, root, write);
  return () => {
    disposeDescription();
    root.dispose();
  };
}
