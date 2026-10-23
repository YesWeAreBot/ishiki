/** 管理接口可以交给界面展示的错误分类。 */
export type ManagementErrorCode = "invalid" | "conflict" | "not-found" | "rejected" | "busy" | "failed";

export class ManagementError extends Error {
  constructor(
    readonly code: ManagementErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

/** 把 OpenAI 风格密钥从文本里抹掉，配置错误和审计都走这里。 */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret.length >= 4).reduce((current, secret) => current.split(secret).join("***"), text);
}

export function collectSecrets(config: { providers?: Readonly<Record<string, { apiKey?: string }>> }): string[] {
  return Object.values(config.providers ?? {})
    .map((provider) => provider.apiKey)
    .filter((key): key is string => typeof key === "string" && !key.startsWith("${"));
}
