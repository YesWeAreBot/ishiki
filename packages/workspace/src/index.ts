import { Logger, Schema, Service, type Context } from "koishi";
import { Extension, type ExtensionContext, type ToolSet } from "koishi-plugin-ishiki";

import { WorkspaceConfig } from "./config.js";
import { createNativeShell } from "./native.js";
import { workspaceInstructions } from "./prompt.js";
import { SkillHandler, WorkspaceHandler } from "./resource-schemes.js";
import { createSandbox } from "./sandbox.js";
import { resolveLayout, type WorkspaceShell } from "./shell.js";
import { skillCatalog } from "./skills.js";
import { createWorkspaceTools } from "./tools.js";

class WorkspaceExtension extends Extension<WorkspaceConfig> {
  static inject = ["ishiki"];
  public readonly Schema = WorkspaceConfig;

  private readonly dataPath: string;

  constructor(ctx: Context, config: WorkspaceExtension.Config) {
    super(ctx, "workspace");
    this.logger.level = config.logLevel;
    this.dataPath = ctx.ishiki.dataPath;
  }

  public [Service.invoke](config: WorkspaceConfig, context: ExtensionContext) {
    const shellOptions = {
      config,
      home: context.home,
      root: context.root,
      dataPath: this.dataPath,
      logger: this.logger,
      resources: context.resources,
    };
    const layout = resolveLayout(shellOptions);

    let shell: Promise<WorkspaceShell> | undefined;
    let tools: ToolSet | undefined;
    // 懒加载单例：tools 与 instructions 共用同一个 shell。
    const box = (): Promise<WorkspaceShell> => (shell ??= layout.backend === "native" ? createNativeShell(layout) : createSandbox(layout, shellOptions));
    const disposers: Array<() => void> = [];
    // 资源 URL 面：技能内容与 workspace 持久根，与沙箱挂载同源。
    disposers.push(context.resources?.attach(new SkillHandler(layout.skills)));
    disposers.push(context.resources?.attach(new WorkspaceHandler(context.home)));
    return {
      name: "ishiki.workspace",
      extendTools: async () => (tools ??= createWorkspaceTools(await box())),
      extendInstructions: async () => {
        const built = await box();
        return [workspaceInstructions(built), skillCatalog(built.skills, built.backend === "native")].filter((text) => text.length > 0).join("\n\n");
      },
      stop: async () => {
        for (const dispose of disposers) {
          dispose?.();
        }
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
