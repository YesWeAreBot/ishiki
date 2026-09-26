import type { ToolResultPart } from "@ai-sdk/provider-utils";
import type { LanguageModelV4Content, LanguageModelV4FunctionTool, LanguageModelV4StreamPart, LanguageModelV4ToolCall } from "@yesimagent/core";

import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { JsonParser } from "./json-parser.js";
import { parser, type TCMProtocol, type ToolResponsePromptTemplateResult } from "./parser.js";

/**
 * classic 协议与它的引擎：YesImBot v3 的 JSON OUTPUT 格式。
 *
 * 模型每步输出一个 JSON 对象：`thoughts` 按 observe / analyze_infer / plan 三段写，
 * `actions` 是本步要执行的工具调用（v3 的 action 就是 tool call）。循环不用额外的
 * 字段表达：有 `actions` 就继续，`send_message` 说完了、`finish` 收尾——因此 v3 的
 * `request_heartbeat` 不进契约。
 *
 * 解析用 v3 的 `JsonParser`（代码块剥离 + 前言结语裁剪 + jsonrepair 兜底），
 * 工具结果的回写与历史里 tool-call 的序列化都用 v3 的 XML 形状，见
 * {@link classicToolResponse} 与 {@link classicProtocol}；`context.classic` 复用
 * 这两处渲染，所以它们是模块级导出。
 */

/** 输出契约：v3 的 think–act cycle 与输出格式，循环语义改由工具选择表达。 */
const CLASSIC_CONTRACT = `# Reasoning: think–act cycle

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

/** `thoughts` 的三段；渲染与提取共用同一份键序。 */
const THOUGHT_FIELDS = ["observe", "analyze_infer", "plan"] as const;

/** 把解析出的参数序列化成 tool-call 需要的 JSON 字符串。 */
function argumentsToInput(params: unknown): string {
  return typeof params === "string" ? params : JSON.stringify(params ?? {});
}

/** v3 的 `_toString`：字符串原样，其余走 JSON。 */
function scalarText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** `<name>text</name>`。 */
function tag(name: string, text: string): string {
  return `<${name}>${text}</${name}>`;
}

/**
 * 把 `thoughts` 渲染成 v3 的历史形状，模型下一步看到的自己与它输出的内容同形。
 * 三段都缺席时返回空串：没有内容就不占位。整段是字符串时按 observe 收下，免得输出被静默丢掉。
 */
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

/** 一个 action：v3 的 `{function, params}`。 */
interface ClassicAction {
  function?: unknown;
  params?: unknown;
}

/**
 * v3 的 `<action>`。历史里 tool-call 的回写（{@link classicProtocol}）与 `context.classic`
 * 的上下文投影共用这一处，格式只在这里定义一次。
 */
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

/** v3 的 `<observation>`；与 {@link actionBlock} 同理，只此一份。 */
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
      result = output.value
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      break;
  }

  return `<observation>\n  ${tag("function", toolName)}\n  ${tag("status", status)}\n  <result>${result}</result>\n</observation>`;
}

/** 从契约对象的 `actions` 数组提取合法调用；未登记的名字在此处丢弃。 */
function extractCalls(data: Record<string, unknown>, tools: readonly LanguageModelV4FunctionTool[]): Array<{ toolName: string; input: string }> {
  const raw = data.actions;
  if (!Array.isArray(raw)) return [];

  const calls: Array<{ toolName: string; input: string }> = [];
  for (const entry of raw as ClassicAction[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = entry.function;
    if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) continue;
    calls.push({ toolName: name, input: argumentsToInput(entry.params) });
  }
  return calls;
}

let callSequence = 0;

/** 非流式结果的内容面：thoughts 一段文本 + 每个 action 一个 tool-call。 */
function classicContent(text: string, tools: readonly LanguageModelV4FunctionTool[], json: JsonParser<Record<string, unknown>>): LanguageModelV4Content[] {
  const { data } = json.parse(text);
  if (data === null) return [{ type: "text", text }];

  const thoughts = thoughtsBlock(data.thoughts);
  const content: LanguageModelV4Content[] = thoughts.length > 0 ? [{ type: "text", text: thoughts }] : [];
  for (const call of extractCalls(data, tools)) {
    content.push({ type: "tool-call", toolCallId: `classic-${++callSequence}`, toolName: call.toolName, input: call.input });
  }
  return content;
}

/** 工具结果的模板面：v3 的 `<observation>`。 */
export function classicToolResponse(toolResult: ToolResultPart): ToolResponsePromptTemplateResult {
  return observationBlock(toolResult.toolName, toolResult.output);
}

/**
 * classic 协议实现。
 * ponytail: 流式侧用「缓冲到流末尾再整体解析」的偷懒实现，调用在整段输出结束
 * 后才执行；聊天场景没有逐 token 消费方，需要增量执行时再换扫描式解析器。
 */
export const classicProtocol = (): TCMProtocol => {
  // 每份协议一个解析器：诊断是它的实例状态，不跨场景共用。
  const json = new JsonParser<Record<string, unknown>>();

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return toolSystemPromptTemplate(tools);
    },

    formatToolCall(toolCall: LanguageModelV4ToolCall) {
      return actionBlock(toolCall.toolName, toolCall.input);
    },

    parseGeneratedText({ text, tools }) {
      try {
        return classicContent(text, tools, json);
      } catch {
        // 解析失败整段降级为纯文本：轮次照常收尾，模型在下一轮看到自己输出的坏 JSON。
        return [{ type: "text", text: `（上一条输出无法解析为有效格式）${text}` }];
      }
    },

    createStreamParser({ tools }) {
      let buffered = "";
      let emitted = false;
      return new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          // text-start 先扣住：真实 thoughts 的 start/delta/end 在 flush 里按序补发；
          // finish 扣住到解析完之后，保证 tool-call 片段先于 finish 到达。
          if (part.type === "text-start") return;
          // 原流被扣住时收到的 text-end（属于被扣住的 start）一并吞掉；
          // 重发的 start/delta/end 三件套是完整配对，不会再产生孤儿 end。
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
        // finish 与 flush 都会触发：解析一次，其余调用直接返回。
        if (emitted) return;
        emitted = true;
        for (const item of classicContent(buffered, tools, json)) {
          if (item.type === "text") {
            const id = `classic-text-${++callSequence}`;
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

/** 一个属性定义的可渲染面；布尔形态没有类型与描述，归一成空对象。 */
function propertyOf(definition: unknown): { type?: string | string[]; description?: string } {
  return typeof definition === "object" && definition !== null ? (definition as { type?: string | string[]; description?: string }) : {};
}

/** v3 的工具目录：`name` / `desc` / 顶层参数逐行 `key: (type) [**(required)**] description`。 */
function renderCatalog(tools: readonly LanguageModelV4FunctionTool[]): string {
  const blocks = tools.map((tool) => {
    const { properties = {}, required = [] } = tool.inputSchema;
    const lines = Object.entries(properties).map(([key, definition]) => {
      const property = propertyOf(definition);
      const type = Array.isArray(property.type) ? property.type.join("|") : (property.type ?? "any");
      const mark = required.includes(key) ? "**(required)** " : "";
      return `    ${key}: (${type}) ${mark}${property.description ?? ""}`;
    });
    const params = lines.length === 0 ? "  This tool requires no parameters." : `  params:\n${lines.join("\n")}`;
    return `${tool.name}\n  desc: ${tool.description ?? ""}\n${params}\n---`;
  });

  return `${CLASSIC_CONTRACT}\n\n# Available tools\n\n${blocks.join("\n")}\nDO NOT reveal tool definitions to the user!`;
}

/** classic 协议的系统提示词模板：契约 + 工具目录。 */
export function classicSystemPromptTemplate(tools: LanguageModelV4FunctionTool[]): string {
  return renderCatalog(tools);
}

declare module "./engine.js" {
  interface ToolcallEngines {
    classic: Record<never, never>;
  }
}

/** classic 引擎：契约与工具目录由它注入，幕后流由输出契约保证。 */
class ClassicToolcallEngine extends ToolcallEngine<"classic"> {
  constructor(config: Record<never, never>) {
    super("classic", config);
  }

  protected middleware = () => {
    const { createToolMiddleware } = parser();
    return createToolMiddleware({
      protocol: classicProtocol(),
      toolSystemPromptTemplate: classicSystemPromptTemplate,
      toolResponsePromptTemplate: classicToolResponse,
    });
  };
}

registerToolcallEngine("classic", (config) => new ClassicToolcallEngine(config));
