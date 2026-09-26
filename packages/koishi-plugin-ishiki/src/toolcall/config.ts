/**
 * 工具调用引擎注册表：`toolcall.engine` 按名取用。
 *
 * - `native`：模型原生 function call，不包任何中间件（缺省）。
 * - `json`：由 `@ai-sdk-tool/parser` 协议解析纯文本输出。
 */

/** json 引擎的参数。 */
export interface JsonToolcallConfig {
  /** 输出协议；可用值见 engine.ts 的注册表（thoughts / hermes / qwen3coder / …）。 */
  protocol: string;
}

/** 工具调用引擎参数表：键即 `toolcall.<engine>` 的参数键。
 * `native` 引擎无参数，用 `never` 键让它只以 `{ engine: "native" }` 出现。
 */
export interface ToolcallEngines {
  json: JsonToolcallConfig;
  native: Record<never, never>;
}
