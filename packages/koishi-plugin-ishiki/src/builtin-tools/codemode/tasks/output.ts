import type { JSONValue, Tool, ToolResultOutput } from "@yesimagent/core";

import type { ResourceCenter } from "../../../resource/center.js";
import { processOutput } from "../../../resource/output.js";
import type { AttachmentItem } from "../../../types/messages.js";

export type TaskOutcome = { kind: "succeeded"; text: string; items: AttachmentItem[] } | { kind: "failed"; error: string };

export interface TaskOutputInput {
  center: ResourceCenter;
  tool: Tool;
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  imageInput: boolean;
}

/** The text a retrieval shows: the converted result, flattened to one string. */
function flatten(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          const mediaType = "mediaType" in part && typeof part.mediaType === "string" ? part.mediaType : part.type;
          const filename = "filename" in part && typeof part.filename === "string" ? part.filename : undefined;
          return `[${mediaType}${filename === undefined ? "" : ` ${filename}`}]`;
        })
        .join("\n");
    case "error-text":
      return output.value;
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ?? "tool execution denied";
    default:
      return JSON.stringify(output);
  }
}

/** Convert one background result exactly like a direct call, then separate text from archived references. */
export async function projectTaskOutput(input: TaskOutputInput): Promise<TaskOutcome> {
  const converted: ToolResultOutput =
    input.tool.toModelOutput === undefined
      ? typeof input.output === "string"
        ? { type: "text", value: input.output }
        : { type: "json", value: input.output as JSONValue }
      : await input.tool.toModelOutput.call(input.tool, { toolCallId: input.toolCallId, input: input.input, output: input.output });
  const processed = await processOutput(input.center, input.toolName, converted, input.output, input.imageInput);
  const text = flatten(processed.output);
  if (processed.output.type === "error-text" || processed.output.type === "error-json" || processed.output.type === "execution-denied") {
    return { kind: "failed", error: text };
  }
  return { kind: "succeeded", text, items: processed.items };
}
