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

import type { FailoverConfig } from "./profile.js";

/** 换候选前的等待上限：再久不如让这一轮失败，把取舍交回调用方。 */
const MAX_BACKOFF_MS = 8_000;

/** 只是元数据的开头 part：不代表模型已经开始作答，此时换人重来仍然安全。 */
const PREAMBLE_PARTS: Record<string, true> = { "stream-start": true, "response-metadata": true, raw: true };

/** 端点自己的问题：换一个候选可能就通了，同时也该记它一次失败。 */
const UNAVAILABLE_STATUS: Record<number, true> = { 401: true, 403: true, 404: true, 408: true, 409: true, 429: true };

/**
 * 一个组上的降级重试。组在 gateway 那边只管选（顺序与熔断），这里补上调用方那一半：挨个试、什么时候放弃。
 *
 * 重试落在模型调用这一层，而不是 turn 或 step 那一层：core 要等整个流结束才把消息落盘，
 * 但流里的工具已经真的执行过了（`send_message` 已经发出去），整步重跑会重发消息。
 *
 * 只重试「首块语义 part 之前」的失败：一旦有 text/tool part 交给下游就不能重来，
 * 否则会得到上一个候选的半句接上下一个候选的补全。
 *
 * 这里是唯一一层重试：core 给 streamText 传的是 `maxRetries: 0`，AI SDK 自己的重试是关掉的。
 * 那边一旦打开，两层会相乘。
 */
export class FailoverModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  /** 身份只给日志与遥测看；真正接手的候选每次尝试现取。 */
  readonly provider = "failover";
  readonly modelId: string;
  /** ishiki 的 prompt 全是文本、没有 URL part，所以不转发候选的 URL 支持表。 */
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
      // 空组取不出候选；坏配置在构造期报，不留到第一次调用。
      if (Object.keys(gateway.group(modelId).status()).length === 0) throw new Error(`model group "${modelId}" declares no members`);
      this.group = modelId;
      return;
    }

    // 不是组就只有一个候选：`attempts` 于是退化成同一个端点上的退避重试。
    // 未声明的引用在这里抛，由上层按 spec 记日志并跳过。
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
      // 换人的时机在这里定死：流还没交出去，失败就还能重来。
      return { ...result, stream: await guard(candidate, result.stream, options.abortSignal) };
    });
  }

  /** 本次尝试的候选：组走 gateway 的策略与熔断，单引用只有它自己。每次现取，`reconfigure()` 后不会用旧的 provider。 */
  private candidates(): readonly Candidate[] {
    const group = this.group;
    return group === undefined ? [this.single] : this.gateway.group(group).candidates();
  }

  /**
   * 依次尝试候选；一轮用尽仍有余额（`attempts`）就再取一轮，此时熔断器已经生效。
   *
   * 只有「端点不可用」记候选一次失败：abort 是调用方取消，请求本身的问题换谁都一样，都不算它的账。
   * `failoverOn: "any"` 下请求本身的问题也换人，但依旧不记账。
   */
  private async attempt<T>(options: LanguageModelV4CallOptions, run: (candidate: Candidate) => Promise<T>): Promise<T> {
    const configured = this.config.attempts;
    // 缺省跑完一轮候选：一轮就是「每个成员各试一次」，所以不数次数。
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

/**
 * 押住首块再交出流，并在流上记成功与失败。
 *
 * 首块语义 part 之前抛出的错误交给调用方换人；之后一律原样透传，只是顺手记一次失败。
 * 见到 `finish` 才算这次成功；中途断掉、或没吐任何语义 part 就结束，都记失败 —— 端点健康与否正是这些事说明的。
 */
async function guard(
  candidate: Candidate,
  source: ReadableStream<LanguageModelV4StreamPart>,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  const reader = source.getReader();
  const head: LanguageModelV4StreamPart[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    // 还没开始就结束：同样是「首块之前失败」，可以换人。
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
          // 流断在路上：这一轮救不回来，但端点该记一次失败。取消不算它的账。
          if (!isAbortError(error) && signal?.aborted !== true) settle(false);
          throw error;
        }
        if (next.done) {
          // 见到 finish 时已经记过成功，这里的收尾不再重复；没见到就是被截断。
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

/**
 * 失败归类：abort 立刻放弃，unavailable 换人，其余是请求本身的问题、默认原样抛出。
 *
 * 主判据是 statusCode 而不是 `APICallError.isRetryable`：本项目 relay 走的 openai-compatible
 * 方言从不设那个字段，只认它会把所有端点故障都判成不可重试。
 */
function classify(error: unknown, signal: AbortSignal | undefined): "abort" | "unavailable" | "invalid" {
  if (signal?.aborted === true || isAbortError(error)) return "abort";
  // 没有 HTTP 响应：网络层、流断、body 解析失败，都是端点这一侧的事。
  if (!APICallError.isInstance(error)) return "unavailable";
  if (error.isRetryable === true) return "unavailable";
  const status = error.statusCode;
  if (status === undefined) return "unavailable";
  return status >= 500 || UNAVAILABLE_STATUS[status] === true ? "unavailable" : "invalid";
}

/** 等一次退避；被取消就立刻返回，让下一次尝试自己撞上取消，不在这里造一种只有它认识的中断错误。 */
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
