import { send } from "@koishijs/client";

import type { ConsoleResult } from "./types";

/** 控制台接口返回的业务错误。 */
export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * 调用控制台写入接口。服务端以 `{ ok, value | error }` 包装结果，
 * 这里统一拆包，失败时抛出携带错误码的 ApiError。
 */
export async function call<T>(event: string, ...args: unknown[]): Promise<T> {
  const dispatch = send as unknown as (type: string, ...args: unknown[]) => Promise<unknown>;
  const result = (await dispatch(event, ...args)) as ConsoleResult<T> | undefined;
  if (result === undefined) throw new ApiError("offline", "控制台连接已断开");
  if (!result.ok) throw new ApiError(result.error.code, result.error.message, result.error.details);
  return result.value;
}
