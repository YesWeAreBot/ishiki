import {
  APICallError,
  MockLanguageModelV4,
  generateText,
  streamText,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type ProviderV4,
} from "@yesimagent/core";
import { createGateway, type ProviderConfig } from "@yesimagent/gateway";
import type { Logger } from "koishi";
import { describe, expect, it } from "vitest";

import { FailoverModel } from "../src/failover.js";

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

const PROMPT: LanguageModelV4CallOptions["prompt"] = [{ role: "user", content: [{ type: "text", text: "在吗" }] }];

/** 合法的 v4 用量：字段齐全，值都是 0。 */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** 一台端点的脚本：每一步要么整次调用失败（Error），要么按 part 序列作答（Error 元素是流断的位置）。 */
type Step = Error | ReadonlyArray<LanguageModelV4StreamPart | Error>;

/**
 * 把 part 序列铺成流；Error 的位置就是流断的地方，之前的部分已经交出去了。
 * 逐块按需投递：一次性 enqueue 再 error 会让已排队的块被丢掉，那样就测不到「交出去之后才断」。
 */
function streamOf(parts: ReadonlyArray<LanguageModelV4StreamPart | Error>): ReadableStream<LanguageModelV4StreamPart> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) controller.close();
      else if (part instanceof Error) controller.error(part);
      else controller.enqueue(part);
    },
  });
}

/** 一次正常作答：开头两个只是元数据的 part，正文，然后 finish。 */
function answer(text: string): ReadonlyArray<LanguageModelV4StreamPart | Error> {
  return [
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "resp" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
}

/** 非流式也照同一份脚本：第一步整次失败的端点，doGenerate 一样失败；其余用正文作答。 */
function generateOf(script: readonly Step[]): { text: string } | { error: Error } {
  const first = script[0]!;
  if (first instanceof Error) return { error: first };
  return { text: first.map((part) => (part instanceof Error ? "" : part.type === "text-delta" ? part.delta : "")).join("") };
}

/** 按调用次序给出脚本里的那一步；脚本用尽后一直重复最后一步。 */
function endpoint(steps: readonly Step[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    provider: "stub",
    modelId: "m",
    doStream: async () => {
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      if (step instanceof Error) throw step;
      return { stream: streamOf(step) };
    },
    doGenerate: async () => {
      const generated = generateOf(steps);
      if ("error" in generated) throw generated.error;
      return { content: [{ type: "text", text: generated.text }], finishReason: { unified: "stop", raw: "stop" }, usage: USAGE, warnings: [] };
    },
  });
}

/**
 * 真网关加桩端点：组的顺序、熔断器、候选过滤全走 gateway 自己的代码，只有 HTTP 那一层是假的。
 * `scripts` 的键是端点 id，每个端点各声明一个名为 `m` 的模型，于是引用是 `<id>:m`。
 */
function environment(scripts: Record<string, readonly Step[]>) {
  const providers: Record<string, ProviderConfig> = {};
  const endpoints: Record<string, MockLanguageModelV4> = {};
  for (const [id, steps] of Object.entries(scripts)) {
    endpoints[id] = endpoint(steps);
    providers[id] = { api: "stub", apiKey: "unused", models: [{ id: "m" }] };
  }

  const gateway = createGateway({
    config: {
      providers,
      groups: {
        fast: { strategy: "failover", models: Object.keys(scripts).map((id) => `${id}:m`), circuitBreaker: { failureThreshold: 9, cooldownSeconds: 60 } },
      },
    },
    apis: {
      stub: (setup) => {
        // 桩端点只伺候 languageModel；另两个接口用不到，直接抛，不假装能返回。
        const provider: ProviderV4 = {
          specificationVersion: "v4",
          languageModel: () => endpoints[setup.id]!,
          embeddingModel: () => {
            throw new Error("这台桩端点不管 embedding");
          },
          imageModel: () => {
            throw new Error("这台桩端点不管 image");
          },
        };
        return provider;
      },
    },
  });

  return { gateway, breaker: (reference: string) => gateway.group("fast").status()[reference]! };
}

/** 读完整条流，返回读到的文本；中途断了就把错误一并带回。 */
async function drain(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<{ text: string; error?: unknown }> {
  const reader = stream.getReader();
  let text = "";

  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) return { text };
      if (value.type === "text-delta") text += value.delta;
    } catch (error) {
      return { text, error };
    }
  }
}

/** 缺省配置：退避压到 1ms，免得用例真的等。 */
const CONFIG = { backoffMs: 1, failoverOn: "unavailable" } as const;

describe("failover", () => {
  it("首块之前失败就换下一个候选，并把这次失败记到它头上", async () => {
    const { gateway, breaker } = environment({ a: [new Error("a 挂了")], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("b 说的");
    expect(breaker("a:m")).toEqual({ state: "closed", failures: 1 });
    expect(breaker("b:m")).toEqual({ state: "closed", failures: 0 });
  });

  it("已经交出正文之后断流就不再重试：上一个候选的半句不会接上下一个候选的补全", async () => {
    const cut = new Error("connection reset");
    const { gateway, breaker } = environment({ a: [[...answer("a 的半句").slice(0, 4), cut]], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    const result = await drain((await model.doStream({ prompt: PROMPT })).stream);
    expect(result.text).toBe("a 的半句");
    expect(result.error).toBe(cut);
    // 端点该记一次失败，但没有换人
    expect(breaker("a:m").failures).toBe(1);
    expect(breaker("b:m").failures).toBe(0);
  });

  it("首块之前就结束（没有 finish）算这次失败，可以换人", async () => {
    const { gateway, breaker } = environment({ a: [[{ type: "stream-start", warnings: [] }]], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("b 说的");
    expect(breaker("a:m").failures).toBe(1);
  });

  it("流到 finish 才算成功：截断的流记失败，不记成功", async () => {
    const { gateway, breaker } = environment({
      a: [
        [
          { type: "stream-start", warnings: [] },
          { type: "text-delta", id: "t", delta: "半句" },
        ],
      ],
    });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("半句");
    expect(breaker("a:m").failures).toBe(1);
  });

  it("取消不算任何候选的账：abort 之后不再往下试", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gateway, breaker } = environment({ a: [new Error("随便什么错")], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    await expect(model.doStream({ prompt: PROMPT, abortSignal: controller.signal })).rejects.toThrow("随便什么错");
    expect(breaker("a:m").failures).toBe(0);
    expect(breaker("b:m").failures).toBe(0);
  });

  it("请求本身的问题默认不换人，也不记在端点头上", async () => {
    const bad = new APICallError({ message: "参数不对", url: "https://stub.invalid/v1/chat", requestBodyValues: {}, statusCode: 400, isRetryable: false });
    const { gateway, breaker } = environment({ a: [bad], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    await expect(model.doStream({ prompt: PROMPT })).rejects.toThrow("参数不对");
    expect(breaker("a:m").failures).toBe(0);
    expect(breaker("b:m").failures).toBe(0);
  });

  it("failoverOn: any 时请求本身的问题也换人，但依旧不记账", async () => {
    const bad = new APICallError({ message: "参数不对", url: "https://stub.invalid/v1/chat", requestBodyValues: {}, statusCode: 400, isRetryable: false });
    const { gateway, breaker } = environment({ a: [bad], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", { ...CONFIG, failoverOn: "any" }, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("b 说的");
    expect(breaker("a:m").failures).toBe(0);
  });

  it("端点自己的错误算它头上：401 与 5xx 都换人", async () => {
    const unauthorized = new APICallError({
      message: "key 不对",
      url: "https://stub.invalid/v1/chat",
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
    const { gateway, breaker } = environment({ a: [unauthorized], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("b 说的");
    expect(breaker("a:m").failures).toBe(1);
  });

  it("attempts 用尽就抛最后一个错误", async () => {
    const { gateway } = environment({ a: [new Error("a 挂了")], b: [new Error("b 挂了")], c: [new Error("c 挂了")] });
    const model = new FailoverModel(gateway, "fast", { ...CONFIG, attempts: 2 }, logger);

    // 第三个候选根本没被碰到，抛的是第二个候选那一次
    await expect(model.doStream({ prompt: PROMPT })).rejects.toThrow("b 挂了");
  });

  it("attempts: 1 只试第一个候选", async () => {
    const { gateway } = environment({ a: [new Error("a 挂了")], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", { ...CONFIG, attempts: 1 }, logger);

    await expect(model.doStream({ prompt: PROMPT })).rejects.toThrow("a 挂了");
  });

  it("不是组引用时只有一个候选：attempts 退化成同一个端点上的退避重试", async () => {
    const { gateway } = environment({ a: [new Error("a 挂了"), new Error("a 又挂了"), answer("a 终于说了")] });
    const model = new FailoverModel(gateway, "a:m", { ...CONFIG, attempts: 3 }, logger);

    expect((await drain((await model.doStream({ prompt: PROMPT })).stream)).text).toBe("a 终于说了");
  });

  it("空组与未声明的引用都在构造期抛", () => {
    const { gateway } = environment({ a: [answer("a 说的")] });

    expect(() => new FailoverModel(gateway, "a:m", CONFIG, logger)).not.toThrow();
    expect(() => new FailoverModel(gateway, "nobody:m", CONFIG, logger)).toThrow(/Unknown provider/);
  });

  it("空组不能当模型用", () => {
    const gateway = createGateway({ config: { groups: { empty: { models: [] } } } });
    expect(() => new FailoverModel(gateway, "empty", CONFIG, logger)).toThrow(/declares no members/);
  });

  it("非流式调用同样换人：上下文压缩走的就是这条路", async () => {
    const { gateway, breaker } = environment({ a: [new Error("a 挂了")], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    const result = await model.doGenerate({ prompt: PROMPT });
    expect(result.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["b 说的"]);
    expect(breaker("a:m").failures).toBe(1);
  });

  it("接在 AI SDK 上：候选失败之后，generateText 与 streamText 照样拿到第二个候选的作答", async () => {
    const { gateway } = environment({ a: [new Error("a 挂了")], b: [answer("b 说的")] });
    const model = new FailoverModel(gateway, "fast", CONFIG, logger);

    // maxRetries: 0 与 core 一致：不然 AI SDK 会在我这一层之外再重试一遍，两层相乘。
    expect((await generateText({ model, prompt: "在吗", maxRetries: 0 })).text).toBe("b 说的");
    expect(await streamText({ model, prompt: "在吗", maxRetries: 0 }).text).toBe("b 说的");
  });
});
