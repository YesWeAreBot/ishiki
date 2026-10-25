import type { Argv } from "koishi";
import type Logger from "reggol";

import { ManagementError, describeError } from "../management/errors.js";

export type CommandAction = (argv: Argv) => Promise<string | void>;

/** ManagementError 的文案已面向用户；其余异常归一为失败提示并写日志。 */
export function renderError(error: unknown, logger: Logger): string {
  if (error instanceof ManagementError) return error.message;
  const described = describeError(error);
  logger.warn(`command failed: ${described.name}: ${described.message}`);
  return "操作失败，请查看日志";
}

/** 内置指令与贡献指令共用的错误包装：任何异常都转成一条用户文案。 */
export function wrapAction(logger: Logger, action: CommandAction) {
  return async (argv: Argv): Promise<string | void> => {
    try {
      return await action(argv);
    } catch (error) {
      return renderError(error, logger);
    }
  };
}
