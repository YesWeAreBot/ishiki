import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEntry, createUserMessage, jsonSchema, tool, type AgentEntry, type AgentMessage, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createFinish } from "../src/builtin-tools/finish.js";
import { collapse } from "../src/context/standard.engine.js";
import { CodemodeConfig, resolveProfile } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime, type AgentRuntimeConfig } from "../src/runtime.js";

const logger = {
  level: 1,
  debug: (message: string) => void message,
  info: (message: string) => void message,
  warn: (message: string) => void message,
  error: (message: string) => void message,
};

const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

type Call = { name: string; input: unknown; id?: string };

function reply(calls: Call[]): Response {
  const chunks =
    calls.length > 0
      ? [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id ?? `call-${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "vision", ...chunk })}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 2000; index += 1) {
    if (await condition()) return;
    await sleep(5);
  }
  throw new Error("condition not reached");
}

interface Probe {
  runtime: AgentRuntime;
  bodies: Array<{ messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }>;
  turn: () => Promise<AgentMessage[]>;
}

async function probe(options: {
  home?: string;
  steps: (index: number) => Call[];
  tools?: ToolSet;
  direct?: string[];
  prepareEntries?: () => readonly AgentEntry[];
}): Promise<Probe> {
  const home = options.home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-codemode-")));
  homes.push(home);
  const bodies: Probe["bodies"] = [];
  let calls = 0;
  const gateway = createGateway({
    config: {
      providers: {
        mock: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "test-only",
          models: [{ id: "vision", type: "language", input: ["text"] }],
        },
      },
      groups: { vision: { models: ["mock:vision"] } },
    },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return reply(options.steps(calls++));
    },
  });
  const runtime = new AgentRuntime({
    id: "codemode",
    home,
    model: gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { finish: createFinish(), ...options.tools },
    extensions: [],
    context: {
      renderMessages: (messages) => collapse(messages),
      ...(options.prepareEntries === undefined ? {} : { prepareEntries: options.prepareEntries }),
    },
    wakeup: { attach: () => () => {} },
    codemode: CodemodeConfig({ enable: true, direct: options.direct ?? [] } as never),
    pacing: { maxSteps: 20, wrapUpSteps: 0, progressAt: 0 },
    debugStream: false,
    logger: logger as never,
    resources: new ResourceCenter("codemode", home),
    attachment: { imageInput: false } as never,
  } satisfies AgentRuntimeConfig);
  runtimes.push(runtime);
  let turns = 0;
  const turn = async (): Promise<AgentMessage[]> => {
    const expected = (turns += 1);
    runtime.wake("run");
    await until(async () => {
      const entries = await runtime.storage.read();
      const terminal = entries.filter(
        (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
      );
      return terminal.length >= expected;
    });
    return (await runtime.storage.read()).flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
  };
  return { runtime, bodies, turn };
}

function toolTexts(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "tool" ? message.content.flatMap((part) => (part.output.type === "text" ? [part.output.value] : [])) : [],
  );
}

function script(input: string, id?: string): Call {
  return { name: "codemode", id, input: { js: input } };
}

function names(body: Probe["bodies"][number]): Array<string | undefined> {
  return (body.tools ?? []).map((entry) => entry.function?.name);
}

const echo: ToolSet = {
  echo: tool({
    description: "Echo a value back.",
    inputSchema: jsonSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"] }),
    execute: async (input) => ({ echoed: input.value }),
  }),
};

const nestedIds: string[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const odd: ToolSet = {
  "weird name.v2": tool({
    description: "Name that needs quoting.",
    inputSchema: jsonSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"] }),
    execute: async (input, options) => {
      nestedIds.push(options.toolCallId);
      return input;
    },
  }),
};

describe("codemode session state", () => {
  it("commits successful writes, skips failed ones, and restores them after a reload", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-codemode-state-"));
    homes.push(home);
    const first = await probe({
      home,
      steps: (index) =>
        index === 0
          ? [script("store('counter', 1); return load('counter');", "write")]
          : index === 1
            ? [script("store('counter', 2); throw new Error('no commit');", "failing")]
            : index === 2
              ? [script("return load('counter');", "read")]
              : [{ name: "finish", input: {} }],
    });
    const messages = await first.turn();
    const texts = toolTexts(messages);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("=== RESULT ===\n1");
    expect(texts[1]).toContain("=== STATUS ===\nfailed");
    expect(texts[2]).toContain("=== RESULT ===\n1");
    const entries = await first.runtime.storage.read();
    const stored = entries.filter((entry) => entry.type === "ishiki.codemode.store");
    expect(stored.map((entry) => (entry.data as { toolCallId: string }).toolCallId)).toEqual(["write"]);
    expect(stored[0]!.data).toMatchObject({ set: { counter: 1 }, delete: [] });
    await first.runtime.stop();

    const reloaded = await probe({
      home,
      steps: (index) => (index === 0 ? [script("return load('counter');", "again")] : [{ name: "finish", input: {} }]),
    });
    const after = await reloaded.turn();
    expect(toolTexts(after)[0]).toContain("=== RESULT ===\n1");
  }, 20000);

  it("merges parallel writes per key by persistence order", async () => {
    const run = await probe({
      steps: (index) =>
        index === 0
          ? [script("store('a', 1); store('k', 'first');", "one"), script("store('b', 2); store('k', 'second');", "two")]
          : index === 1
            ? [script("return [load('a'), load('b'), load('k')];", "read")]
            : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    expect(toolTexts(messages)[2]).toContain('=== RESULT ===\n[1,2,"second"]');
    const stored = (await run.runtime.storage.read()).filter((entry) => entry.type === "ishiki.codemode.store");
    expect(stored.map((entry) => (entry.data as { toolCallId: string }).toolCallId)).toEqual(["one", "two"]);
  }, 20000);

  it("restores committed state before context compaction drops the entries", async () => {
    const run = await probe({
      prepareEntries: () => [createEntry("message", createUserMessage("compacted"), { turnId: "compacted" })],
      steps: (index) =>
        index === 0 ? [script("store('kept', 'yes');", "write")] : index === 1 ? [script("return load('kept');", "read")] : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    expect(toolTexts(messages)[1]).toContain('=== RESULT ===\n"yes"');
  }, 20000);

  it("saves null and deletes a key with undefined", async () => {
    const run = await probe({
      steps: (index) =>
        index === 0
          ? [script("store('n', null); store('temp', 1); store('temp', undefined); return [load('n'), typeof load('temp')];", "writes")]
          : [{ name: "finish", input: {} }],
    });
    expect(toolTexts(await run.turn())[0]).toContain('=== RESULT ===\n[null,"undefined"]');
  }, 20000);

  it("rejects a merged store over the sandbox limits and appends nothing", async () => {
    const value = "x".repeat(250000);
    const run = await probe({
      steps: (index) =>
        index === 0
          ? [
              script(`for (let i = 0; i < 3; i += 1) store('a' + i, ${JSON.stringify(value)});`, "left"),
              script(`for (let i = 0; i < 3; i += 1) store('b' + i, ${JSON.stringify(value)});`, "right"),
            ]
          : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    const entries = await run.runtime.storage.read();
    expect(entries.some((entry) => entry.type === "ishiki.codemode.store")).toBe(false);
    expect(entries.some((entry) => entry.type === "event" && entry.data.type === "turn.failed")).toBe(true);
    expect(messages.some((message) => message.role === "tool")).toBe(false);
  }, 60000);
});

describe("codemode discovery", () => {
  it("answers queries without changing the callable set or the model schema", async () => {
    const run = await probe({
      tools: echo,
      steps: (index) =>
        index === 0
          ? [script("const first = searchTools('echo'); return searchTools('echo');", "search")]
          : index === 1
            ? [script("return describeTool('echo');", "describe")]
            : index === 2
              ? [script("return await tools.echo({value: 'hi'});", "call")]
              : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    const texts = toolTexts(messages);
    expect(texts[0]).toContain('=== RESULT ===\n[{"name":"echo"');
    expect(texts[1]).toContain("declare const tools");
    expect(texts[1]).toContain("echo(args: { value: string; }): Promise<unknown>");
    expect(texts[2]).toContain('=== RESULT ===\n{"echoed":"hi"}');
    expect(names(run.bodies[0]!)).toEqual(names(run.bodies[1]!));
    expect(names(run.bodies[2]!)).toEqual(names(run.bodies[0]!));
    expect(names(run.bodies[0]!)).not.toContain("echo");
    expect(names(run.bodies[0]!)).toContain("codemode");
    expect(names(run.bodies[0]!)).toEqual(expect.arrayContaining(["finish", "wait"]));
  }, 20000);

  it("fails a source parse error without leaking it into the next call", async () => {
    const run = await probe({
      steps: (index) =>
        index === 0 ? [script('// @options: {"bogus": 1}\nreturn 1;', "bad")] : index === 1 ? [script("return 2;", "good")] : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    const outputs = messages.flatMap((message) => (message.role === "tool" ? message.content.map((part) => part.output) : []));
    expect(outputs[0]?.type).toBe("error-text");
    expect(JSON.stringify(outputs[0])).toContain("@options only supports");
    expect(outputs[1]?.type).toBe("text");
    expect(toolTexts(messages)[0]).toContain("=== RESULT ===\n2");
  }, 20000);
});

describe("codemode routing", () => {
  it("keeps tools listed in codemode.direct visible to the model", async () => {
    const run = await probe({
      tools: echo,
      direct: ["echo"],
      steps: () => [{ name: "finish", input: {} }],
    });
    await run.turn();
    expect(names(run.bodies[0]!)).toContain("echo");
  }, 20000);
});

describe("codemode output sections", () => {
  it("separates console output and treats null, undefined and exit", async () => {
    const run = await probe({
      steps: (index) =>
        index === 0
          ? [script("console.log('out'); return null;", "console")]
          : index === 1
            ? [script("return undefined;", "void")]
            : index === 2
              ? [script("text('bye'); exit();", "exit")]
              : [{ name: "finish", input: {} }],
    });
    const texts = toolTexts(await run.turn());
    expect(texts[0]).toContain("=== RESULT ===\nnull");
    expect(texts[0]).toContain("=== CONSOLE ===\nout");
    expect(texts[0]).not.toContain("=== TEXT ===");
    expect(texts[1]).not.toContain("=== RESULT ===");
    expect(texts[2]).toContain("=== TEXT ===\nbye");
    expect(texts[2]).not.toContain("=== RESULT ===");
  }, 20000);

  it("quotes tool names and numbers nested calls", async () => {
    const run = await probe({
      tools: odd,
      steps: (index) => (index === 0 ? [script('return await tools["weird name.v2"]({value: "x"});', "outer")] : [{ name: "finish", input: {} }]),
    });
    expect(toolTexts(await run.turn())[0]).toContain('=== RESULT ===\n{"value":"x"}');
    expect(nestedIds).toEqual(["outer:tool-0"]);
  }, 20000);

  it("times out from a per-call option while keeping attached images", async () => {
    const run = await probe({
      steps: (index) =>
        index === 0
          ? [script(`// @options: {"timeout_ms": 1000}\nimage({type: "image", data: "${PNG}", mimeType: "image/png"}); while (true) {}`, "loop")]
          : [{ name: "finish", input: {} }],
    });
    const messages = await run.turn();
    const text = toolTexts(messages)[0]!;
    expect(text).toContain("=== STATUS ===\nfailed");
    expect(text).toContain("timeout");
    expect(text).toContain("=== ATTACHMENTS ===");
    const attachments = messages.filter((message) => message.role === "custom" && message.type === "ishiki.attachment");
    expect(attachments).toHaveLength(1);
  }, 30000);
});

describe("profile validation", () => {
  it("rejects removed toolsearch and codemode fields", () => {
    expect(() => resolveProfile({ toolsearch: { enable: true } }, "test", homes[0] ?? os.tmpdir())).toThrow("toolsearch was removed");
    expect(() => resolveProfile({ codemode: { maxToolOutputBytes: 1024 } }, "test", os.tmpdir())).toThrow("codemode.maxToolOutputBytes were removed");
    expect(() =>
      resolveProfile({ model: "mock:vision", mode: "channel", channels: { "test:bot": ["*"] }, codemode: { enable: false } }, "test", os.tmpdir()),
    ).not.toThrow();
  });
});
