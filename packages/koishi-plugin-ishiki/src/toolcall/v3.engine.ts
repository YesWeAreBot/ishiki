import type {
  FileData,
  LanguageModelV4Content,
  LanguageModelV4FilePart,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
  ToolResultPart,
} from "@yesimagent/core";
import { Service, type Context } from "koishi";

import type { EngineConfig } from "../profile/index.js";
import { ToolcallEngine, ToolcallEngineInstance, type ToolcallEngines } from "./engine.js";
import { JsonParser } from "./json-parser.js";
import { parser, type TCMProtocol, type ToolResponsePromptTemplateResult } from "./parser.js";

const V3_CONTRACT = `# Reasoning: think–act cycle

Your reasoning in \`thoughts\` must follow:

1. [OBSERVE] — Scan <new_events> first. If an <observation> from your previous turn is there, identify the related task and judge whether the goal was achieved. Note new user/system messages and their emotional tone.
2. [ANALYZE & INFER] — Separate explicit facts from implied intentions. Cross-reference your core memory for context. Decide whether external tools are needed.
3. [PLAN] — State a clear, ordered action plan.
4. [ACT] — Emit your tool calls per the output format below.

# Output format

Your output MUST be a single raw \`\`\`json block, with no text before or after:

\`\`\`json
{
  "thoughts": {"observe": "...", "analyze_infer": "...", "plan": "..."},
  "actions": [
    {"function": "function_name", "params": {"...": "..."}}
  ]
}
\`\`\`

# Control flow

- Put every action into \`actions\`. The system executes them and hands you the results as <observation> in <new_events> on your next step.
- An empty \`actions\` array ends the turn: never emit one and then wait for another step.
- \`send_message\` is the ONLY action that reaches the user. The user sees nothing else you do.
- Call \`finish\` when the turn is over.`;

const THOUGHT_FIELDS = ["observe", "analyze_infer", "plan"] as const;

function argumentsToInput(params: unknown): string {
  return typeof params === "string" ? params : JSON.stringify(params ?? {});
}

function scalarText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** `<name>text</name>`。 */
function tag(name: string, text: string): string {
  return `<${name}>${text}</${name}>`;
}

export function thoughtsBlock(thoughts: unknown): string {
  if (typeof thoughts === "string") return thoughts.length === 0 ? "" : `<thoughts>\n  ${tag("observe", thoughts)}\n</thoughts>`;
  if (typeof thoughts !== "object" || thoughts === null) return "";

  const record = thoughts as Record<string, unknown>;
  const lines: string[] = [];
  for (const field of THOUGHT_FIELDS) {
    const text = record[field];
    if (typeof text === "string" && text.length > 0) lines.push(`  ${tag(field, text)}`);
  }
  return lines.length === 0 ? "" : `<thoughts>\n${lines.join("\n")}\n</thoughts>`;
}

interface V3Action {
  function?: unknown;
  params?: unknown;
}

export function actionBlock(toolName: string, input: unknown): string {
  let params: unknown;
  if (typeof input !== "string") {
    params = input;
  } else {
    try {
      params = JSON.parse(input);
    } catch {
      params = input;
    }
  }

  const rendered =
    typeof params === "object" && params !== null
      ? Object.entries(params as Record<string, unknown>)
          .map(([key, value]) => tag(key, scalarText(value)))
          .join("")
      : tag("input", scalarText(params));
  return `<action>\n  ${tag("function", toolName)}\n  <params>${rendered}</params>\n</action>`;
}

export function observationBlock(toolName: string, output: ToolResultPart["output"]): string {
  let status = "success";
  let result: string;

  switch (output.type) {
    case "text":
      result = output.value;
      break;
    case "json":
      result = JSON.stringify(output.value);
      break;
    case "error-text":
      status = "error";
      result = output.value;
      break;
    case "error-json":
      status = "error";
      result = JSON.stringify(output.value);
      break;
    case "execution-denied":
      status = "error";
      result = `(denied)${output.reason === undefined ? "" : ` ${output.reason}`}`;
      break;
    default:
      result = output.value.map((part) => (part.type === "text" ? part.text : part.type === "file" ? mediaNote(part) : `[${part.type}]`)).join("\n");
      break;
  }

  return `<observation>\n  ${tag("function", toolName)}\n  ${tag("status", status)}\n  <result>${result}</result>\n</observation>`;
}

function mediaNote(part: { mediaType: string; data: FileData }): string {
  if (part.data.type !== "data") return `[${part.mediaType}]`;
  const raw = part.data.data;
  const bytes = typeof raw === "string" ? Buffer.from(raw, "base64").byteLength : raw.byteLength;
  return `[${part.mediaType} ${bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`}]`;
}

function filePart(part: { mediaType: string; filename?: string; data: FileData }): LanguageModelV4FilePart {
  const base = { type: "file" as const, mediaType: part.mediaType, filename: part.filename };
  if (part.data.type !== "data") return { ...base, data: part.data };
  const raw = part.data.data;
  return { ...base, data: { type: "data", data: raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw } };
}

function extractCalls(data: Record<string, unknown>, tools: readonly LanguageModelV4FunctionTool[]): Array<{ toolName: string; input: string }> {
  const raw = data.actions;
  if (!Array.isArray(raw)) return [];

  const calls: Array<{ toolName: string; input: string }> = [];
  for (const entry of raw as V3Action[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = entry.function;
    if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) continue;
    calls.push({ toolName: name, input: argumentsToInput(entry.params) });
  }
  return calls;
}

function v3Content(
  text: string,
  tools: readonly LanguageModelV4FunctionTool[],
  json: JsonParser<Record<string, unknown>>,
  ids: { next: number },
): LanguageModelV4Content[] {
  const { data } = json.parse(text);
  if (data === null) return [{ type: "text", text }];

  const thoughts = thoughtsBlock(data.thoughts);
  const content: LanguageModelV4Content[] = thoughts.length > 0 ? [{ type: "text", text: thoughts }] : [];
  for (const call of extractCalls(data, tools)) {
    content.push({ type: "tool-call", toolCallId: `v3-${++ids.next}`, toolName: call.toolName, input: call.input });
  }
  return content;
}

export function v3ToolResponse(toolResult: ToolResultPart): ToolResponsePromptTemplateResult {
  const text = observationBlock(toolResult.toolName, toolResult.output);
  if (toolResult.output.type !== "content") return text;
  const files = toolResult.output.value.filter((part) => part.type === "file").map(filePart);
  if (files.length === 0) return text;
  return [{ type: "text", text }, ...files];
}

export const v3Protocol = (): TCMProtocol => {
  const json = new JsonParser<Record<string, unknown>>();
  const ids = { next: 0 };

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return toolSystemPromptTemplate(tools);
    },

    formatToolCall(toolCall: LanguageModelV4ToolCall) {
      return actionBlock(toolCall.toolName, toolCall.input);
    },

    parseGeneratedText({ text, tools }) {
      try {
        return v3Content(text, tools, json, ids);
      } catch {
        return [{ type: "text", text: `（上一条输出无法解析为有效格式）${text}` }];
      }
    },

    createStreamParser({ tools }) {
      let buffered = "";
      let emitted = false;
      return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "text-start") return;
          if (part.type === "text-end") return;
          if (part.type === "finish") {
            emitParsed(controller);
            controller.enqueue(part);
            return;
          }
          if (part.type !== "text-delta") {
            controller.enqueue(part);
            return;
          }
          buffered += part.delta;
        },
        flush(controller) {
          emitParsed(controller);
        },
      });

      function emitParsed(controller: TransformStreamDefaultController<LanguageModelV4StreamPart>): void {
        if (emitted) return;
        emitted = true;
        for (const item of v3Content(buffered, tools, json, ids)) {
          if (item.type === "text") {
            const id = `v3-text-${++ids.next}`;
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: item.text });
            controller.enqueue({ type: "text-end", id });
            continue;
          }
          if (item.type === "tool-call") {
            controller.enqueue({ type: "tool-input-start", id: item.toolCallId, toolName: item.toolName });
            controller.enqueue({ type: "tool-input-delta", id: item.toolCallId, delta: item.input });
            controller.enqueue({ type: "tool-input-end", id: item.toolCallId });
            controller.enqueue(item);
          }
        }
      }
    },
  };
};

function readProperty(definition: unknown): { type?: string | string[]; description?: string } {
  return typeof definition === "object" && definition !== null ? (definition as { type?: string | string[]; description?: string }) : {};
}

function renderCatalog(tools: readonly LanguageModelV4FunctionTool[]): string {
  const blocks = tools.map((tool) => {
    const { properties = {}, required = [] } = tool.inputSchema;
    const lines = Object.entries(properties).map(([key, definition]) => {
      const property = readProperty(definition);
      const type = Array.isArray(property.type) ? property.type.join("|") : (property.type ?? "any");
      const mark = required.includes(key) ? "**(required)** " : "";
      return `    ${key}: (${type}) ${mark}${property.description ?? ""}`;
    });
    const params = lines.length === 0 ? "  This tool requires no parameters." : `  params:\n${lines.join("\n")}`;
    return `${tool.name}\n  desc: ${tool.description ?? ""}\n${params}\n---`;
  });

  return `${V3_CONTRACT}\n\n# Available tools\n\n${blocks.join("\n")}\nDO NOT reveal tool definitions to the user!`;
}

export function v3SystemPromptTemplate(tools: LanguageModelV4FunctionTool[]): string {
  return renderCatalog(tools);
}

declare module "./engine.js" {
  interface ToolcallEngines {
    v3: Record<never, never>;
  }
}

export class V3ToolcallInstance extends ToolcallEngineInstance {
  protected middleware = () => {
    const { createToolMiddleware } = parser();
    return createToolMiddleware({
      protocol: v3Protocol(),
      toolSystemPromptTemplate: v3SystemPromptTemplate,
      toolResponsePromptTemplate: v3ToolResponse,
    });
  };
}

export class V3ToolcallEngine extends ToolcallEngine<"v3"> {
  constructor(ctx: Context) {
    super(ctx, "v3");
  }

  public [Service.invoke](_config: EngineConfig<Pick<ToolcallEngines, "v3">>): ToolcallEngineInstance {
    return new V3ToolcallInstance();
  }
}
