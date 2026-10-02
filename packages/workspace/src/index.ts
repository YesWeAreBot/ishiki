import { Context, Logger, Schema } from "koishi";
// 引入这个包才看得见 `ctx.ishiki` 与 `ishiki.ext.*` 的类型增强。
import {} from "koishi-plugin-ishiki";

import { parseWorkspaceConfig } from "./config.js";
import { workspaceInstructions } from "./prompt.js";
import { createSandbox, resolveLayout, type WorkspaceSandbox } from "./sandbox.js";
import { skillCatalog } from "./skills.js";
import { createWorkspaceTools } from "./tools.js";

/**
 * 工作区扩展包：按实例给一个宿主目录支撑的沙箱，以及沙箱内的文件读写、编辑与 bash。
 *
 * 只做加法（工具与提示词），装配点在内核的 `provide` 上。装配分两段：静态部分（配置、挂载、技能、
 * 目录）在 handler 里同步落定，写错就在这一实例诞生时报出来；解释器的装载是异步的，放在两个钩子里等。
 * 配置写在 profile 的 `extends.workspace.config` 里，见 ./config.ts。
 */
class IshikiWorkspace {
  public static name = "ishiki-workspace";
  public static usage = "工作区扩展包：沙箱内的文件读写、编辑与 bash";
  // 用到 ctx.ishiki 就得在 inject 里写明，否则 cordis 每次取用都记一条 not-registered 警告。
  public static inject = ["ishiki"];

  constructor(ctx: Context, config: IshikiWorkspace.Config) {
    const logger = ctx.logger(IshikiWorkspace.name);
    logger.level = config.logLevel;
    // 数据根的技能目录基准：`<dataPath>/skills` 是所有 profile 共享的那一份。
    const dataPath = ctx.ishiki.dataPath;

    // 扩展服务要在 profile 的 fiber 里就位，所以不挂 ready。
    const dispose = ctx.ishiki.provide("workspace", (profileConfig, runtime) => {
      const layout = resolveLayout({ config: parseWorkspaceConfig(profileConfig), home: runtime.home, root: runtime.root, dataPath, logger });
      // 解释器只装一次；失败也留在同一个 promise 上，不反复重试——装不起来就是配置或依赖的问题。
      let sandbox: Promise<WorkspaceSandbox> | undefined;
      let tools: ReturnType<typeof createWorkspaceTools> | undefined;
      const box = (): Promise<WorkspaceSandbox> => (sandbox ??= createSandbox(layout, runtime.home));
      return {
        extendTools: async () => (tools ??= createWorkspaceTools(await box())),
        extendInstructions: async () => {
          const built = await box();
          return [workspaceInstructions(built), skillCatalog(built.skills)].filter((text) => text.length > 0).join("\n\n");
        },
      };
    });

    ctx.on("dispose", dispose);
  }
}

namespace IshikiWorkspace {
  export interface Config {
    logLevel: number;
  }

  export const Config: Schema<Config> = Schema.object({
    // 其余配置都在 profile 的 extends 里：它们逐 profile 生效，控制台只留进程级的那一项。
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

export default IshikiWorkspace;
