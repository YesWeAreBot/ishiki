import type { BashOptions } from "just-bash";

import type { WorkspaceLayout } from "./shell.js";

type ExecutionLimits = NonNullable<BashOptions["executionLimits"]>;

export function sandboxExecutionLimits(layout: Pick<WorkspaceLayout, "timeoutMs" | "maxExecutionOutputBytes">): ExecutionLimits {
  return {
    maxOutputSize: layout.maxExecutionOutputBytes,
    maxExecutionTimeMs: layout.timeoutMs,
    maxSqliteTimeoutMs: layout.timeoutMs,
    maxPythonTimeoutMs: layout.timeoutMs,
    maxJsTimeoutMs: layout.timeoutMs,
  };
}
