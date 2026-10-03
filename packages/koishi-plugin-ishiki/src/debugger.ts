import { promises as fs } from "node:fs";
import path from "node:path";

import { AgentPlugin, type AgentCustomEvent } from "@yesimagent/core";
import type { Logger } from "koishi";

export interface DumpFetchOptions {
  readonly logger: Logger;
  /** Directory raw exchanges are written to. */
  readonly directory: string;
}

const PREFIX = "[ishiki:debug]";

/**
 * 开发调试用：把 `stream` 通道的分片按到达顺序写到 `process.stdout`，不走 logger
 * （logger 的级别与格式会吃掉增量，控制台要的是一行行流出来的原文）。
 * 增量原地续写（同一 `id` 的分片接在一起），非增量分片自成一行；只排版，不拼装、不缓存，
 * 所以到达顺序、分段边界与分片本身一样都看得到。
 * 用法：`createAgent({ plugins: [createDebugStreamPlugin()] })`。
 */
export function createDebugStreamPlugin(): AgentPlugin {
  let unsubscribe: (() => void) | undefined;
  return {
    name: "debug-stream",
    init: (agent) => {
      const write = createDeltaWriter();
      unsubscribe = agent.channel.subscribe("stream", write);
    },
    stop: () => unsubscribe?.(),
  };
}

/** 续写状态只在监听器生命周期里活着：`open` 是当前那条没写换行的增量流，非增量分片先把它收尾。 */
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

/** 增量分片只认原文：`label` 是新开一条流时打的头部，之后同 `id` 的分片直接接在后面。 */
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

/** 非增量分片一行一条：只挑开发时要看的字段，其余类型只留判别式，避免把图片、原始块整段灌进终端。 */
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

/**
 * Wraps `fetch` to keep a copy of every provider exchange. A tool call's argument order only exists in
 * the raw text the provider streams — the parsed object a runtime logs has already lost the question,
 * so the request body (declared schema order) and the response body (generated order) are both kept.
 */
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
    // The body is handed over decoded, so the original encoding frames no longer describe it.
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

  // options.logger.debug(`[dump] ${stamp} tools ${toolSchemas(payload)}`);
  // for (const delta of argumentDeltas(raw)) options.logger.debug(`[dump] ${stamp} ${delta}`);
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
