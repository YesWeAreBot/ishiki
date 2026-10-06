import {
  APICallError,
  formatErrorCause,
  isAbortError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
} from "@yesimagent/core";
import type { Candidate, Gateway } from "@yesimagent/gateway";
import type { Logger } from "koishi";

import type { FailoverConfig } from "./profile/index.js";

const MAX_BACKOFF_MS = 8_000;

const PREAMBLE_PARTS: Record<string, true> = { "stream-start": true, "response-metadata": true, raw: true };

const UNAVAILABLE_STATUS: Record<number, true> = { 401: true, 403: true, 404: true, 408: true, 409: true, 429: true };

export class FailoverModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "failover";
  readonly modelId: string;
  readonly supportedUrls = {};

  private readonly group: string | undefined;
  private readonly single!: Candidate;

  constructor(
    private readonly gateway: Gateway,
    modelId: string,
    private readonly config: FailoverConfig,
    private readonly logger: Logger,
  ) {
    this.modelId = modelId;

    if (gateway.groups().includes(modelId)) {
      if (Object.keys(gateway.group(modelId).status()).length === 0) throw new Error(`model group "${modelId}" declares no members`);
      this.group = modelId;
      return;
    }
    this.single = { id: modelId, model: gateway.languageModel(modelId), metadata: {}, success: () => undefined, failure: () => undefined };
  }

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    return this.attempt(options, async (candidate) => {
      const result = await candidate.model.doGenerate(options);
      candidate.success();
      return result;
    });
  }

  doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return this.attempt(options, async (candidate) => {
      const result = await candidate.model.doStream(options);
      return { ...result, stream: await guard(candidate, result.stream, options.abortSignal) };
    });
  }

  private candidates(): readonly Candidate[] {
    const group = this.group;
    return group === undefined ? [this.single] : this.gateway.group(group).candidates();
  }

  private async attempt<T>(options: LanguageModelV4CallOptions, run: (candidate: Candidate) => Promise<T>): Promise<T> {
    const configured = this.config.attempts;
    const cap = configured === undefined ? Number.POSITIVE_INFINITY : Math.max(1, configured);
    let rounds = configured === undefined ? 1 : Number.POSITIVE_INFINITY;
    let tried = 0;
    let lastError: unknown;

    while (rounds > 0 && tried < cap) {
      rounds -= 1;
      for (const candidate of this.candidates()) {
        if (tried >= cap) break;
        if (tried > 0) {
          const base = Math.min(this.config.backoffMs * 2 ** (tried - 1), MAX_BACKOFF_MS);
          await pause(base / 2 + (Math.random() * base) / 2, options.abortSignal);
        }
        tried += 1;

        try {
          return await run(candidate);
        } catch (error) {
          const kind = classify(error, options.abortSignal);
          if (kind === "abort") throw error;
          if (kind === "unavailable") candidate.failure();
          if (kind === "invalid" && this.config.failoverOn !== "any") throw error;

          lastError = error;
          this.logger.debug(`[failover] ${candidate.id} ${kind}: ${formatErrorCause(error)}`);
        }
      }
    }

    throw lastError;
  }
}

async function guard(
  candidate: Candidate,
  source: ReadableStream<LanguageModelV4StreamPart>,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  const reader = source.getReader();
  const head: LanguageModelV4StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`${candidate.id} ended before any content`);
    if (value.type === "error") throw value.error;
    head.push(value);
    if (PREAMBLE_PARTS[value.type] !== true) break;
  }

  let settled = false;
  const settle = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    if (ok) candidate.success();
    else candidate.failure();
  };

  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      let part: LanguageModelV4StreamPart;

      if (head.length > 0) {
        part = head.shift()!;
      } else {
        let next: ReadableStreamReadResult<LanguageModelV4StreamPart>;
        try {
          next = await reader.read();
        } catch (error) {
          if (!isAbortError(error) && signal?.aborted !== true) settle(false);
          throw error;
        }
        if (next.done) {
          settle(false);
          controller.close();
          return;
        }
        part = next.value;
      }

      if (part.type === "error") settle(false);
      if (part.type === "finish") settle(true);
      controller.enqueue(part);
    },

    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function classify(error: unknown, signal: AbortSignal | undefined): "abort" | "unavailable" | "invalid" {
  if (signal?.aborted === true || isAbortError(error)) return "abort";
  if (!APICallError.isInstance(error)) return "unavailable";
  if (error.isRetryable === true) return "unavailable";
  const status = error.statusCode;
  if (status === undefined) return "unavailable";
  return status >= 500 || UNAVAILABLE_STATUS[status] === true ? "unavailable" : "invalid";
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();

  const { promise, resolve } = Promise.withResolvers<void>();
  const done = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
}
