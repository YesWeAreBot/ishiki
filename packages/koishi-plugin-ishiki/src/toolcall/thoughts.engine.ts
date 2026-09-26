import type { ToolResultPart } from "@ai-sdk/provider-utils";
import type { LanguageModelV4Content, LanguageModelV4FunctionTool, LanguageModelV4StreamPart, LanguageModelV4ToolCall } from "@yesimagent/core";

import { ToolcallEngine, registerToolcallEngine } from "./engine.js";
import { parser, type TCMProtocol, type ToolResponsePromptTemplateResult } from "./parser.js";

/**
 * thoughts 协议与它的引擎：ishiki 自有的 JSON OUTPUT 格式。
 *
 * 模型每步输出一个 JSON 对象：`thoughts` 是固定的幕后流（按 think_guide 书写），
 * `calls` 是本步要执行的工具调用。设计参考 YesImBot v3：幕后流不再依赖模型自觉
 * 调用 think 工具，而是由输出契约保证每步必有。
 *
 * 实现为库的 `TCMProtocol`，与 hermes 等协议共用 `createToolMiddleware` 的请求
 * 改写与流包装骨架；本文件补格式相关的部分，并在末尾把它登记成一个引擎。
 */

/** 输出契约：thoughts 恒在，calls 可空。 */
const THOUGHTS_CONTRACT = `# 输出格式

你的每一步输出都必须是一个 JSON 对象（不要包裹 markdown 代码块），形状如下：

{
  "thoughts": "<幕后流，按 think_guide 书写>",
  "calls": [
    { "name": "<工具名>", "arguments": { <参数> } }
  ]
}

- "thoughts" 必填：写下你此刻的念头与判断，这些内容别人看不到。
- "calls" 可以为空数组：只想、不做时留空。
- 需要行动时，把要调用的工具列入 "calls"；多个调用可以并列。
- 只输出这一个 JSON 对象，不要输出别的文字。`;

/** 从混入了杂讯的全文里提取第一个平衡的 JSON 对象；找不到返回 null。 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, at + 1);
  }
  return null;
}

/** 宽容 JSON：直接 parse 失败后剥尾逗号再试；仍失败抛错，由调用方降级为纯文本。 */
function tolerantParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 常见畸形只有尾随逗号，剥掉重试一次；更多畸形不值得引入完整修复器。
    const repaired = raw.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired) as Record<string, unknown>;
  }
}

/** 把解析出的参数序列化成 tool-call 需要的 JSON 字符串。 */
function argumentsToInput(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

interface ThoughtsCall {
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
}

/** 从契约对象的 calls 数组提取合法调用；未登记的名字在此处丢弃。 */
function extractCalls(data: Record<string, unknown>, tools: LanguageModelV4FunctionTool[]): Array<{ toolName: string; input: string }> {
  const raw = data.calls;
  if (!Array.isArray(raw)) return [];
  const calls: Array<{ toolName: string; input: string }> = [];
  for (const entry of raw as ThoughtsCall[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = entry.name;
    if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) continue;
    calls.push({ toolName: name, input: argumentsToInput(entry.arguments ?? entry.args ?? {}) });
  }
  return calls;
}

let callSequence = 0;

/** 非流式结果的内容面：thoughts 一段文本 + 每个调用一个 tool-call。 */
function thoughtsContent(text: string, tools: LanguageModelV4FunctionTool[]): LanguageModelV4Content[] {
  const raw = extractJsonObject(text);
  if (raw === null) return [{ type: "text", text }];
  const data = tolerantParse(raw);
  const thoughts = typeof data.thoughts === "string" ? data.thoughts : "";
  const content: LanguageModelV4Content[] = thoughts.length > 0 ? [{ type: "text", text: thoughts }] : [];
  for (const call of extractCalls(data, tools)) {
    content.push({ type: "tool-call", toolCallId: `thoughts-${++callSequence}`, toolName: call.toolName, input: call.input });
  }
  return content;
}

/** 工具结果的模板面：紧凑 JSON 文本，模型能直接读回自己上一轮的调用形态。 */
export function thoughtsToolResponse(toolResult: ToolResultPart): ToolResponsePromptTemplateResult {
  const output = toolResult.output;
  if (output.type === "text" || output.type === "error-text") return `${toolResult.toolName}: ${output.value}`;
  if (output.type === "json" || output.type === "error-json") return `${toolResult.toolName}: ${JSON.stringify(output.value)}`;
  if (output.type === "execution-denied") return `${toolResult.toolName}: (denied)${output.reason === undefined ? "" : ` ${output.reason}`}`;
  return `${toolResult.toolName}: ${output.value
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")}`;
}

/**
 * thoughts 协议实现。
 * ponytail: 流式侧用「缓冲到流末尾再整体解析」的偷懒实现，调用在整段输出结束
 * 后才执行；聊天场景没有逐 token 消费方，需要增量执行时再换扫描式解析器。
 */
export const thoughtsProtocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return toolSystemPromptTemplate(tools);
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall) {
    let args: unknown = {};
    try {
      args = JSON.parse(toolCall.input);
    } catch {
      args = toolCall.input;
    }
    return JSON.stringify({ name: toolCall.toolName, arguments: args });
  },

  parseGeneratedText({ text, tools }) {
    try {
      return thoughtsContent(text, tools);
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
      for (const item of thoughtsContent(buffered, tools)) {
        if (item.type === "text") {
          const id = `thoughts-text-${++callSequence}`;
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
});

/** thoughts 协议的系统提示词模板：契约 + 工具目录。 */
export function thoughtsSystemPromptTemplate(tools: LanguageModelV4FunctionTool[]): string {
  const catalog = tools.map((tool) => `- ${tool.name}: ${tool.description ?? ""} 参数(JSON Schema): ${JSON.stringify(tool.inputSchema)}`).join("\n");
  return `${THOUGHTS_CONTRACT}\n\n# 可用工具\n\n${catalog}`;
}

declare module "./engine.js" {
  interface ToolcallEngines {
    thoughts: Record<never, never>;
  }
}

/** thoughts 引擎：契约与工具目录由它注入，幕后流由输出契约保证。 */
class ThoughtsToolcallEngine extends ToolcallEngine<"thoughts"> {
  constructor(config: Record<never, never>) {
    super("thoughts", config);
  }

  protected middleware = () => {
    const { createToolMiddleware } = parser();
    return createToolMiddleware({
      protocol: thoughtsProtocol(),
      toolSystemPromptTemplate: thoughtsSystemPromptTemplate,
      toolResponsePromptTemplate: thoughtsToolResponse,
    });
  };
}

registerToolcallEngine("thoughts", (config) => new ThoughtsToolcallEngine(config));
