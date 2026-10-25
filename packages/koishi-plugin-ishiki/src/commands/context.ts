import type { Argv, Session } from "koishi";

import { ManagementError } from "../management/errors.js";

/** 指令执行者：聊天会话记 platform:userId，无会话上下文时记 console。 */
export function operatorOf(session: Session | undefined): string {
  if (session === undefined) return "command:console";
  return `command:${session.platform}:${session.userId ?? "unknown"}`;
}

/** 破坏性操作二次确认：先回显影响范围，60 秒内回复"确认"返回 true，其余情况返回取消文案。 */
export async function confirm(session: Session, notice: string): Promise<true | string> {
  await session.send(`${notice}\n回复"确认"继续执行`);
  const reply = await session.prompt(60_000);
  if (reply?.includes("确认")) return true;
  return "操作已取消。";
}

/** 与 Koishi authority:N 权限一致的手工检查：无用户数据（未接数据库）时放行。 */
export function hasAuthority(session: Session | undefined, level: number): boolean {
  const user = session?.user as { authority?: number } | undefined;
  if (user === undefined) return true;
  return (user.authority ?? 1) >= level;
}

/** 位置参数（字符串、非空才算提供）。 */
export function positional(argv: Argv, index: number): string | undefined {
  const value = (argv.args ?? [])[index];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从 index 起的剩余文本（`<value...>` 形式的收尾参数），拼接成一个字符串。 */
export function positionalText(argv: Argv, index: number): string | undefined {
  const text = restArguments(argv, index).join(" ").trim();
  return text.length > 0 ? text : undefined;
}

/** 从 index 起的全部剩余位置参数，展开数组形式的收尾参数。 */
export function restArguments(argv: Argv, index: number): string[] {
  return (argv.args ?? [])
    .slice(index)
    .flatMap((item) => (Array.isArray(item) ? item.map(String) : [String(item)]))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 字符串选项（按声明的 camelCase 名取，空串视为未提供）。 */
export function optionText(argv: Argv, name: string): string | undefined {
  const value = (argv.options as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 数字选项。 */
export function optionNumber(argv: Argv, name: string): number | undefined {
  const value = (argv.options as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 布尔选项。 */
export function optionFlag(argv: Argv, name: string): boolean {
  return (argv.options as Record<string, unknown>)[name] === true;
}

/** JSON 文本参数；解析失败按 invalid 提示。 */
export function parseJsonArgument(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ManagementError("invalid", `${label} 不是合法的 JSON`);
  }
}
