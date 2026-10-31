import type { ToolResultOutput } from "@yesimagent/core";

/** Failed tools normally invalidate their attachments; codemode can opt in for artifacts created before failure. */
export function keepsFailedToolAttachments(output: ToolResultOutput): boolean {
  switch (output.type) {
    case "error-text":
    case "error-json":
    case "execution-denied":
      break;
    default:
      return false;
  }
  const marker = output.providerOptions?.ishiki;
  return typeof marker === "object" && marker !== null && (marker as { keepAttachments?: unknown }).keepAttachments === true;
}
