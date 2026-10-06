import { promises as fs } from "node:fs";
import path from "node:path";

import { AgentPlugin, type AgentCustomEvent, type AgentEvent, type LanguageModelUsage } from "@yesimagent/core";
import type { Logger } from "koishi";

export interface DumpFetchOptions {
  readonly logger: Logger;
  readonly directory: string;
}

const PREFIX = "[ishiki:debug]";

export function createDebugPlugin(id: string, logger: Logger): AgentPlugin {
  let disposers: Array<() => void> = [];
  return {
    name: "debug-stream",
    init: (agent) => {
      disposers.push(agent.channel.subscribe("stream", createDeltaWriter()));
      disposers.push(agent.channel.subscribe("agent", createEventLogger({ id, logger })));
    },
    stop: () => {
      for (const dispose of disposers) dispose();
      disposers = [];
    },
  };
}

function createDeltaWriter(): (part: AgentCustomEvent["stream"]) => void {
  let open: string | undefined;
  const close = (): void => {
    if (open === undefined) return;
    open = undefined;
    process.stdout.write("\n");
  };
  return (part) => {
    const delta = deltaOf(part);
    if (delta === undefined) {
      close();
      process.stdout.write(`${PREFIX} ${fact(part)}\n`);
      return;
    }
    if (open !== delta.id) {
      close();
      open = delta.id;
      process.stdout.write(`${PREFIX} ${delta.label} > `);
    }
    process.stdout.write(delta.text);
  };
}

function deltaOf(part: AgentCustomEvent["stream"]): { id: string; label: string; text: string } | undefined {
  switch (part.type) {
    case "text-delta":
      return { id: part.id, label: `text ${part.id}`, text: part.text };
    case "reasoning-delta":
      return { id: part.id, label: `reasoning ${part.id}`, text: part.text };
    case "tool-input-delta":
      return { id: part.id, label: `tool-input ${part.id}`, text: part.delta };
    default:
      return undefined;
  }
}

function fact(part: AgentCustomEvent["stream"]): string {
  switch (part.type) {
    case "tool-input-start":
      return `tool-input-start ${part.id} ${part.toolName}`;
    case "tool-call":
      return `tool-call ${part.toolCallId} ${part.toolName} ${JSON.stringify(part.input)}`;
    case "tool-result":
      return `tool-result ${part.toolCallId} ${part.toolName} ${JSON.stringify(part.output)}`;
    case "tool-error":
      return `tool-error ${part.toolCallId} ${part.toolName} ${String(part.error)}`;
    case "finish-step":
      return `finish-step ${part.finishReason} ${JSON.stringify(part.usage)}`;
    case "finish":
      return `finish ${part.finishReason} ${JSON.stringify(part.totalUsage)}`;
    case "error":
      return `error ${String(part.error)}`;
    default:
      return part.type;
  }
}

/** 订阅 agent 事件，按 turn / tool / message 记账后逐条打日志。 */
function createEventLogger(options: { id: string; logger: Logger }): (event: AgentEvent) => void {
  const tag = `[${options.id}]`;
  const logger = options.logger;
  const stepStartedAt = new Map<string, number>();
  const toolStartedAt = new Map<string, number>();

  return (event) => {
    switch (event.type) {
      case "turn.start":
        stepStartedAt.set(event.turnId, Date.now());
        break;
      case "turn.step": {
        const startedAt = stepStartedAt.get(event.turnId);
        stepStartedAt.set(event.turnId, Date.now());
        logger.debug(`${tag} turn.step #${event.stepNumber} ${formatUsage(event.usage)} finish=${event.finishReason ?? "unknown"} ${formatElapsed(startedAt)}`);
        return;
      }
      case "turn.done":
        stepStartedAt.delete(event.turnId);
        break;
      case "turn.failed":
      case "turn.aborted":
        stepStartedAt.delete(event.turnId);
        break;
      case "tool.start":
        toolStartedAt.set(toolCallKey(event), Date.now());
        break;
      case "tool.done":
        logger.debug(`${tag} tool.done ${event.toolName} ${formatElapsed(toolStartedAt.get(toolCallKey(event)))}`);
        toolStartedAt.delete(toolCallKey(event));
        return;
      case "tool.failed":
        toolStartedAt.delete(toolCallKey(event));
        break;
      case "message.appended":
        if (event.message.role === "assistant" && Array.isArray(event.message.content)) {
          const text = event.message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
          logger.debug(`${tag} message.appended ${event.message.role} "${text}"`);
        }
        break;
      default:
        // 其余事件没有要算的量，落到下面统一记一行类型。
        break;
    }

    if (event.type === "turn.failed") {
      logger.warn(`${tag} turn failed: ${event.error?.message ?? "unknown error"}`);
      return;
    }
    logger.debug(`${tag} ${event.type}`);
  };
}

/** 一次工具调用的键：优先用 provider 给的 id，缺了就用轮次加名字兜底。 */
function toolCallKey(event: { turnId: string; toolName: string; toolCallId?: string }): string {
  return event.toolCallId ?? `${event.turnId}:${event.toolName}`;
}

/** 距离起点过了多少毫秒；起点缺席（没见到对应的 start 事件）时不报数。 */
function formatElapsed(startedAt: number | undefined): string {
  return startedAt === undefined ? "elapsed=?" : `elapsed=${Date.now() - startedAt}ms`;
}

/** 一步的用量。provider 少给字段就少报字段，不拿 0 冒充。 */
function formatUsage(usage: Partial<LanguageModelUsage> | undefined): string {
  if (usage === undefined) return "usage=?";
  const parts = [`in=${usage.inputTokens ?? "?"}`, `out=${usage.outputTokens ?? "?"}`, `total=${usage.totalTokens ?? "?"}`];
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  if (cached !== undefined) {
    parts.push(`cached=${cached}`);
    parts.push(`rate=${((cached / (usage.inputTokens ?? 1)) * 100).toFixed(2)}%`);
  }
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  if (reasoning !== undefined) parts.push(`reasoning=${reasoning}`);
  return `usage(${parts.join(" ")})`;
}

export function createDumpFetch(options: DumpFetchOptions): typeof globalThis.fetch {
  let sequence = 0;
  return async (input, init) => {
    const payload = await requestBody(input, init);
    const response = await globalThis.fetch(input, init);
    if (!response.body) return response;

    sequence += 1;
    const stamp = `${Date.now()}-${sequence}`;
    const [copy, body] = response.body.tee();
    void record(options, stamp, payload, copy);

    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}

async function requestBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request)
    return input
      .clone()
      .text()
      .catch(() => "");
  return "";
}

async function record(options: DumpFetchOptions, stamp: string, payload: string, body: ReadableStream<Uint8Array>): Promise<void> {
  const raw = await readAll(body);
  await fs.mkdir(options.directory, { recursive: true });
  await fs.writeFile(path.join(options.directory, `${stamp}-request.json`), payload, "utf-8");
  await fs.writeFile(path.join(options.directory, `${stamp}-response.sse`), raw, "utf-8");
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
