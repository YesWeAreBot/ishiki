import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "koishi";

export interface DumpFetchOptions {
  readonly logger: Logger;
  /** Directory raw exchanges are written to. */
  readonly directory: string;
}

/** The `/chat/completions` request, as far as a dump reads it. */
interface ChatRequest {
  tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>;
}

/** The `/chat/completions` stream chunk, as far as a dump reads it. */
interface ChatChunk {
  choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { arguments?: string } }> } }>;
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

  options.logger.debug(`[dump] ${stamp} tools ${toolSchemas(payload)}`);
  for (const delta of argumentDeltas(raw)) options.logger.debug(`[dump] ${stamp} ${delta}`);
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

/** The schema order the request actually carried, e.g. `send_message(inner_thought|mode|channel|messages)`. */
function toolSchemas(payload: string): string {
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return "(unparsed)";
  }
  const tools = (body as ChatRequest | null)?.tools;
  if (!Array.isArray(tools)) return "(no tools)";
  const schemas = tools.map((tool) => {
    const fn = tool?.function;
    return `${fn?.name ?? "?"}(${Object.keys(fn?.parameters?.properties ?? {}).join("|")})`;
  });
  return schemas.join(" ") || "(none)";
}

/** Every `tool_calls[].function.arguments` fragment in arrival order, verbatim. */
function argumentDeltas(raw: string): string[] {
  const deltas: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choices = (chunk as ChatChunk | null)?.choices;
    if (!Array.isArray(choices)) continue;
    for (const call of choices.flatMap((choice) => choice?.delta?.tool_calls ?? [])) {
      const args = call?.function?.arguments;
      if (typeof args !== "string") continue;
      deltas.push(`call#${call.index ?? 0} ${call.id ? `${call.id} ` : ""}${JSON.stringify(args)}`);
    }
  }
  return deltas;
}
