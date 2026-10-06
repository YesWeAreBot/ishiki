import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, type ExtensionContext, type ToolSet } from "koishi-plugin-ishiki";

import { WorkspaceConfig } from "./config.js";
import { workspaceInstructions } from "./prompt.js";
import { createSandbox, resolveLayout, type WorkspaceSandbox } from "./sandbox.js";
import { skillCatalog } from "./skills.js";
import { createWorkspaceTools } from "./tools.js";

class WorkspaceExtension extends Extension<WorkspaceConfig> {
  static inject = ["ishiki"];
  /** 扩展实例配置（profile 的 extends.workspace.config）的 Schema；插件自身的 Koishi 配置见下方 Config。 */
  static Schema = WorkspaceConfig;

  private readonly dataPath: string;

  constructor(ctx: Context, config: WorkspaceExtension.Config) {
    super(ctx, "workspace");
    this.logger.level = config.logLevel;
    this.dataPath = ctx.ishiki.dataPath;
  }

  public [Service.invoke](config: WorkspaceConfig, context: ExtensionContext) {
    const layout = resolveLayout({
      config,
      home: context.home,
      root: context.root,
      dataPath: this.dataPath,
      logger: this.logger,
    });

    let sandbox: Promise<WorkspaceSandbox> | undefined;
    let tools: ToolSet | undefined;
    // 懒加载单例：tools 与 instructions 共用同一个沙箱。
    const box = (): Promise<WorkspaceSandbox> => (sandbox ??= createSandbox(layout, context.home));
    return {
      name: "ishiki.workspace",
      extendTools: async () => (tools ??= createWorkspaceTools(await box())),
      extendInstructions: async () => {
        const built = await box();
        return [workspaceInstructions(built), skillCatalog(built.skills)].filter((text) => text.length > 0).join("\n\n");
      },
    };
  }
}

namespace WorkspaceExtension {
  export interface Config {
    logLevel: number;
  }

  export const Config: Schema<Config> = Schema.object({
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default WorkspaceExtension;
