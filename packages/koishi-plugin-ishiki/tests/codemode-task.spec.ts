import fs from "node:fs/promises";
import path from "node:path";

import { jsonSchema, tool, type AgentEntry, type AgentMessage, type ToolSet } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createTaskManager, type CodemodeTasks } from "../src/builtin-tools/codemode/tasks/manager.js";
import { createTaskStore, type TaskStore } from "../src/builtin-tools/codemode/tasks/store.js";
import { createFinish } from "../src/builtin-tools/finish.js";
import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { collapse } from "../src/context/render.js";
import { CodemodeConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime, type AgentRuntimeConfig } from "../src/runtime.js";
import type { AttachmentItem, IshikiTaskNotice } from "../src/types/messages.js";
import { startApp, type TestSetup } from "./harness.js";

const logger = {
  level: 1,
  debug: (message: string) => void message,
  info: (message: string) => void message,
  warn: (message: string) => void message,
  error: (message: string) => void message,
};

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TEST_ROOT = path.resolve(import.meta.dirname, "../../../.test-tmp");

const homes: string[] = [];
const runtimes: AgentRuntime[] = [];
const setups: TestSetup[] = [];

afterEach(async () => {
  for (const setup of setups.splice(0)) await setup.stop();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

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

async function tempHome(): Promise<string> {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const home = await fs.mkdtemp(path.join(TEST_ROOT, "task-"));
  homes.push(home);
  return home;
}

async function ledger(home: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await fs.readFile(path.join(home, "codemode-tasks.jsonl"), "utf8");
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { data: Record<string, unknown> }).data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const anyObject = jsonSchema({ type: "object", properties: {} });
const valueSchema = jsonSchema<{ value: string }>({ type: "object", properties: { value: { type: "string" } }, required: ["value"] });

const echo: ToolSet = {
  echo: tool({
    description: "Echo a value back.",
    inputSchema: valueSchema,
    execute: async (input) => ({ echoed: input.value }),
  }),
};

interface Fixture {
  home: string;
  store: TaskStore;
  tasks: CodemodeTasks;
  notices: Array<{ notice: IshikiTaskNotice; items: readonly AttachmentItem[] }>;
}

async function fixture(options: { home?: string; maxTasks?: number; open?: boolean } = {}): Promise<Fixture> {
  const home = options.home ?? (await tempHome());
  const store = createTaskStore(home);
  const notices: Fixture["notices"] = [];
  const tasks = createTaskManager({
    store,
    maxTasks: options.maxTasks ?? 4,
    resources: new ResourceCenter("tasks", home),
    imageInput: false,
    exclude: ["codemode", "finish", "wait"],
    onSettled: (notice, items) => notices.push({ notice, items }),
  });
  if (options.open !== false) await tasks.open();
  return { home, store, tasks, notices };
}

describe("task ledger", () => {
  it("restores settled results across a restart and writes nothing more", async () => {
    const home = await tempHome();
    const first = await fixture({ home });
    const { id, execution } = await first.tasks.start(echo, "echo", { value: "kept" }, "call");
    await execution;
    expect(first.tasks.result(id)).toMatchObject({ state: "succeeded", toolName: "echo", text: '{"echoed":"kept"}', items: [] });
    await first.tasks.close();
    const before = await ledger(home);
    expect(before.map((record) => record.kind)).toEqual(["start", "terminal"]);

    const second = await fixture({ home });
    expect(second.tasks.status(id)).toMatchObject({ state: "succeeded", toolName: "echo", startedAt: before[0]!.startedAt });
    expect(second.tasks.result(id).text).toBe('{"echoed":"kept"}');
    expect(second.notices).toEqual([]);
    await second.tasks.close();
    expect(await ledger(home)).toEqual(before);
  });

  it("marks a leftover start interrupted exactly once without a notice", async () => {
    const home = await tempHome();
    const first = await fixture({ home });
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { hang: tool({ inputSchema: anyObject, execute: () => gate.promise }) };
    const { id } = await first.tasks.start(tools, "hang", {}, "call");
    expect(first.tasks.status(id).state).toBe("running");

    const second = await fixture({ home });
    expect(second.tasks.result(id)).toMatchObject({ state: "interrupted" });
    expect(second.notices).toEqual([]);
    const records = await ledger(home);
    expect(records.map((record) => record.kind)).toEqual(["start", "terminal"]);
    expect(records[1]).toMatchObject({ id, state: "interrupted" });

    const third = await fixture({ home });
    expect(third.tasks.status(id).state).toBe("interrupted");
    expect(await ledger(home)).toEqual(records);
  });

  it("rejects a damaged ledger line instead of half-loading", async () => {
    const home = await tempHome();
    await fs.writeFile(
      path.join(home, "codemode-tasks.jsonl"),
      `${JSON.stringify({ type: "ishiki.task.record", id: "line", timestamp: 1, data: { kind: "start", id: "a", startedAt: 1 } })}\n`,
    );
    const broken = await fixture({ home, open: false });
    await expect(broken.tasks.open()).rejects.toThrow("codemode task ledger line 1: start record needs a tool name and a start time");
  });
});

describe("task admission", () => {
  it("bounds concurrent tasks and frees the slot when one settles", async () => {
    const fixture = await makeFixture({ maxTasks: 1 });
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { slow: tool({ inputSchema: anyObject, execute: () => gate.promise }) };
    const first = await fixture.tasks.start(tools, "slow", {}, "call");
    await expect(fixture.tasks.start(tools, "slow", {}, "call")).rejects.toThrow(
      "codemode.maxTasks (1) reached; wait for a background task to finish before starting another",
    );
    gate.resolve();
    await first.execution;
    const second = await fixture.tasks.start(echo, "echo", { value: "again" }, "call");
    await second.execution;
    expect(fixture.tasks.status(second.id).state).toBe("succeeded");
  });

  it("admits only one of two simultaneous starts for the last slot", async () => {
    const fixture = await makeFixture({ maxTasks: 1 });
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { slow: tool({ inputSchema: anyObject, execute: () => gate.promise }) };
    const settled = await Promise.allSettled([fixture.tasks.start(tools, "slow", {}, "call"), fixture.tasks.start(tools, "slow", {}, "call")]);
    const admitted = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry) => entry.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("codemode.maxTasks (1) reached");
    gate.resolve();
    await (admitted[0] as PromiseFulfilledResult<{ execution: Promise<void> }>).value.execution;
  });

  it("rejects excluded, unknown, bare, and invalid tools before writing anything", async () => {
    const fixture = await makeFixture();
    const plain = tool({ inputSchema: anyObject, execute: async () => "ok" });
    const tools: ToolSet = { codemode: plain, finish: plain, wait: plain, plain, bare: tool({ inputSchema: anyObject }) };
    await expect(fixture.tasks.start(tools, "missing", {}, "call")).rejects.toThrow('unknown host tool "missing"');
    await expect(fixture.tasks.start(tools, "finish", {}, "call")).rejects.toThrow('tool "finish" cannot run as a background task');
    await expect(fixture.tasks.start(tools, "codemode", {}, "call")).rejects.toThrow('tool "codemode" cannot run as a background task');
    await expect(fixture.tasks.start(tools, "bare", {}, "call")).rejects.toThrow('tool "bare" has no local implementation');
    const strictSchema = jsonSchema<{ value: string }>(
      { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      {
        validate: (value) =>
          typeof value === "object" && value !== null && "value" in value && typeof value.value === "string"
            ? { success: true, value: { value: value.value } }
            : { success: false, error: new Error("value must be a string") },
      },
    );
    await expect(fixture.tasks.start({ strict: tool({ inputSchema: strictSchema, execute: async () => "ok" }) }, "strict", {}, "call")).rejects.toThrow(
      "value must be a string",
    );
    expect(await ledger(fixture.home)).toEqual([]);
  });

  it("releases the reservation when the start record cannot be written", async () => {
    const fixture = await makeFixture();
    const target = path.join(fixture.home, "codemode-tasks.jsonl");
    await fs.mkdir(target);
    await expect(fixture.tasks.start(echo, "echo", { value: "lost" }, "call")).rejects.toThrow(/EISDIR/);
    await fs.rm(target, { recursive: true });
    const { id, execution } = await fixture.tasks.start(echo, "echo", { value: "kept" }, "call");
    await execution;
    expect(fixture.tasks.status(id).state).toBe("succeeded");
  });
});

describe("task settlement", () => {
  it("records text, attachments, and one notice for a successful task", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      shot: tool({
        inputSchema: anyObject,
        execute: async () => ({ summary: "screenshot", attachments: [{ type: "image", mimeType: "image/png", data: PNG }] }),
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "shot", {}, "call");
    await execution;
    const result = fixture.tasks.result(id);
    expect(result).toMatchObject({ state: "succeeded", toolName: "shot" });
    expect(result.finishedAt! >= result.startedAt).toBe(true);
    expect(result.text).toContain("screenshot");
    expect(result.items).toHaveLength(1);
    expect(result.items![0]!.mediaType).toBe("image/png");
    expect(result.items![0]!.url.length).toBeGreaterThan(0);
    expect(fixture.notices).toHaveLength(1);
    expect(fixture.notices[0]!.notice).toMatchObject({ taskId: id, toolName: "shot", state: "succeeded", summary: "1 个附件" });
    expect(fixture.notices[0]!.items).toHaveLength(1);
    expect(fixture.notices[0]!.items[0]!.url).toBe(result.items![0]!.url);
  });

  it("keeps the first text line as the notice summary", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = { lines: tool({ inputSchema: anyObject, execute: async () => "first line\nsecond line" }) };
    const { execution } = await fixture.tasks.start(tools, "lines", {}, "call");
    await execution;
    expect(fixture.notices[0]!.notice.summary).toBe("first line");
  });

  it("fails on a thrown error with the error summary and no attachments", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      broken: tool({
        inputSchema: anyObject,
        execute: async () => {
          throw new Error("tool exploded");
        },
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "broken", {}, "call");
    await execution;
    expect(fixture.tasks.result(id)).toMatchObject({ state: "failed", error: "tool exploded" });
    expect(fixture.tasks.result(id).text).toBeUndefined();
    expect(fixture.notices[0]!.notice).toMatchObject({ state: "failed", summary: "tool exploded" });
    expect(fixture.notices[0]!.items).toEqual([]);
  });

  it("fails when the converted output is an error and when conversion itself throws", async () => {
    const fixture = await makeFixture({ maxTasks: 1 });
    const tools: ToolSet = {
      refused: tool({
        inputSchema: anyObject,
        execute: async () => "ignored",
        toModelOutput: () => ({ type: "error-text", value: "tool said no" }),
      }),
      choppy: tool({
        inputSchema: anyObject,
        execute: async () => "ignored",
        toModelOutput: () => {
          throw new Error("conversion failed");
        },
      }),
    };
    const refused = await fixture.tasks.start(tools, "refused", {}, "call");
    await refused.execution;
    expect(fixture.tasks.result(refused.id)).toMatchObject({ state: "failed", error: "tool said no" });
    const choppy = await fixture.tasks.start(tools, "choppy", {}, "call");
    await choppy.execution;
    expect(fixture.tasks.result(choppy.id)).toMatchObject({ state: "failed", error: "conversion failed" });
    expect(fixture.tasks.status(choppy.id).state).toBe("failed");
    const after = await fixture.tasks.start(echo, "echo", { value: "next" }, "call");
    await after.execution;
  });

  it("pages oversized text through the normal artifact source", async () => {
    const fixture = await makeFixture();
    const big = "x".repeat(20_000);
    const tools: ToolSet = { big: tool({ inputSchema: anyObject, execute: async () => big }) };
    const { id, execution } = await fixture.tasks.start(tools, "big", {}, "call");
    await execution;
    const result = fixture.tasks.result(id);
    expect(result.state).toBe("succeeded");
    expect(result.text).toContain("artifact://big/");
    expect(result.text!.length).toBeLessThan(big.length);
  });

  it("rejects a failed terminal write with the original error and never notifies", async () => {
    const fixture = await makeFixture();
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { slow: tool({ inputSchema: anyObject, execute: async () => (await gate.promise, "late") }) };
    const { id, execution } = await fixture.tasks.start(tools, "slow", {}, "call");
    const target = path.join(fixture.home, "codemode-tasks.jsonl");
    await fs.rm(target);
    await fs.mkdir(target);
    gate.resolve();
    await expect(execution).rejects.toThrow(/EISDIR/);
    expect(fixture.notices).toEqual([]);
    expect(fixture.tasks.status(id).state).toBe("succeeded");
    await fs.rm(target, { recursive: true });
    expect(await ledger(fixture.home)).toEqual([]);
    const next = await fixture.tasks.start(echo, "echo", { value: "after" }, "call");
    await next.execution;
    expect(fixture.tasks.status(next.id).state).toBe("succeeded");
    expect((await ledger(fixture.home)).map((record) => record.kind)).toEqual(["start", "terminal"]);
  });
});

describe("task queries", () => {
  it("rejects unknown ids from every query and copies result items", async () => {
    const fixture = await makeFixture();
    expect(() => fixture.tasks.status("missing")).toThrow('unknown task "missing"');
    expect(() => fixture.tasks.cancel("missing")).toThrow('unknown task "missing"');
    expect(() => fixture.tasks.result("missing")).toThrow('unknown task "missing"');

    const tools: ToolSet = {
      shot: tool({
        inputSchema: anyObject,
        execute: async () => ({ attachments: [{ type: "image", mimeType: "image/png", data: PNG }] }),
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "shot", {}, "call");
    await execution;
    const first = fixture.tasks.result(id);
    first.items![0]!.url = "local://mutated";
    expect(fixture.tasks.result(id).items![0]!.url).not.toBe("local://mutated");
  });

  it("omits result fields that do not apply to the state", async () => {
    const fixture = await makeFixture();
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { slow: tool({ inputSchema: anyObject, execute: () => gate.promise }) };
    const { id } = await fixture.tasks.start(tools, "slow", {}, "call");
    expect(fixture.tasks.result(id)).toEqual({ id, toolName: "slow", state: "running", startedAt: fixture.tasks.status(id).startedAt });
    const cancelling = fixture.tasks.cancel(id);
    expect(cancelling.state).toBe("cancelling");
    expect(fixture.tasks.result(id)).not.toHaveProperty("text");
    expect(fixture.tasks.result(id)).not.toHaveProperty("error");
  });
});

describe("task cancellation", () => {
  it("settles cancelled when the tool stops on the abort signal", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      stopper: tool({
        inputSchema: anyObject,
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
          }),
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "stopper", {}, "call");
    expect(fixture.tasks.cancel(id).state).toBe("cancelling");
    expect(fixture.tasks.status(id).state).toBe("cancelling");
    await execution;
    expect(fixture.tasks.result(id).state).toBe("cancelled");
    expect(fixture.tasks.result(id).error).toBeUndefined();
    expect(fixture.notices[0]!.notice).toMatchObject({ taskId: id, state: "cancelled", summary: "" });
  });

  it("keeps a request pending until the tool actually settles", async () => {
    const fixture = await makeFixture();
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { stubborn: tool({ inputSchema: anyObject, execute: async () => (await gate.promise, { done: true }) }) };
    const { id, execution } = await fixture.tasks.start(tools, "stubborn", {}, "call");
    const requested = fixture.tasks.cancel(id);
    expect(requested.state).toBe("cancelling");
    expect(fixture.tasks.cancel(id)).toEqual(requested);
    gate.resolve();
    await execution;
    expect(fixture.tasks.result(id)).toMatchObject({ state: "succeeded", text: '{"done":true}' });
    expect(fixture.notices[0]!.notice.state).toBe("succeeded");
  });

  it("keeps task signals independent and settles iterable output at its last value", async () => {
    const fixture = await makeFixture();
    const signals: AbortSignal[] = [];
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = {
      waiting: tool({
        inputSchema: anyObject,
        execute: (_input, options) => {
          signals.push(options.abortSignal!);
          return gate.promise;
        },
      }),
      streaming: tool({
        inputSchema: anyObject,
        execute: async function* () {
          yield "first";
          yield "second";
        },
      }),
    };
    const first = await fixture.tasks.start(tools, "waiting", {}, "call");
    const second = await fixture.tasks.start(tools, "waiting", {}, "call");
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    fixture.tasks.cancel(first.id);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    gate.resolve();
    await Promise.all([first.execution, second.execution]);

    const third = await fixture.tasks.start(tools, "streaming", {}, "call");
    await third.execution;
    expect(fixture.tasks.result(third.id)).toMatchObject({ state: "succeeded", text: "second" });
  });

  it("treats any AbortError as cancelled once the request is pending", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      stopper: tool({
        inputSchema: anyObject,
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(new DOMException("unwound", "AbortError")), { once: true });
          }),
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "stopper", {}, "call");
    fixture.tasks.cancel(id);
    await execution;
    expect(fixture.tasks.result(id).state).toBe("cancelled");
  });

  it("fails an ordinary error raised after a cancellation request", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      breaker: tool({
        inputSchema: anyObject,
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(new Error("socket closed")), { once: true });
          }),
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "breaker", {}, "call");
    fixture.tasks.cancel(id);
    await execution;
    expect(fixture.tasks.result(id)).toMatchObject({ state: "failed", error: "socket closed" });
  });

  it("fails an AbortError thrown without a cancellation request", async () => {
    const fixture = await makeFixture();
    const tools: ToolSet = {
      abrupt: tool({
        inputSchema: anyObject,
        execute: async () => {
          throw new DOMException("stop now", "AbortError");
        },
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "abrupt", {}, "call");
    await execution;
    expect(fixture.tasks.result(id)).toMatchObject({ state: "failed", error: "stop now" });
  });

  it("keeps a terminal snapshot immutable", async () => {
    const fixture = await makeFixture();
    const { id, execution } = await fixture.tasks.start(echo, "echo", { value: "done" }, "call");
    await execution;
    const before = fixture.tasks.status(id);
    expect(fixture.tasks.cancel(id)).toEqual(before);
    expect(fixture.tasks.status(id)).toEqual(before);
    expect(fixture.notices).toHaveLength(1);
  });
});

describe("task shutdown", () => {
  it("marks tasks interrupted before aborting them and reports the state to the tool", async () => {
    const fixture = await makeFixture();
    const observed: string[] = [];
    const tools: ToolSet = {
      watch: tool({
        inputSchema: anyObject,
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener(
              "abort",
              () => {
                const id = options.toolCallId.slice(options.toolCallId.indexOf(":task-") + 6);
                observed.push(fixture.tasks.status(id).state);
                reject(options.abortSignal?.reason);
              },
              { once: true },
            );
          }),
      }),
    };
    const { id } = await fixture.tasks.start(tools, "watch", {}, "call");
    await fixture.tasks.close();
    expect(observed).toEqual(["interrupted"]);
    expect(fixture.notices).toEqual([]);
    const records = await ledger(fixture.home);
    expect(records.map((record) => record.state ?? "start")).toEqual(["start", "interrupted"]);
    await expect(fixture.tasks.start(echo, "echo", { value: "closed" }, "call")).rejects.toThrow("codemode is closing; no background task was started");
    expect(fixture.tasks.status(id).state).toBe("interrupted");
  });

  it("writes each interruption record after both start records", async () => {
    const fixture = await makeFixture();
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = {
      first: tool({ inputSchema: anyObject, execute: () => gate.promise }),
      second: tool({ inputSchema: anyObject, execute: () => gate.promise }),
    };
    const first = await fixture.tasks.start(tools, "first", {}, "call");
    const second = await fixture.tasks.start(tools, "second", {}, "call");
    await fixture.tasks.close();
    const records = await ledger(fixture.home);
    expect(records.map((record) => `${record.kind}:${record.id}`)).toEqual([
      `start:${first.id}`,
      `start:${second.id}`,
      `terminal:${first.id}`,
      `terminal:${second.id}`,
    ]);
    gate.resolve();
    await Promise.all([first.execution, second.execution]);
  });

  it("returns without waiting for a tool that ignores the abort and never rewrites its record", async () => {
    const fixture = await makeFixture();
    let runs = 0;
    const tools: ToolSet = {
      deaf: tool({
        inputSchema: anyObject,
        execute: () => {
          runs += 1;
          return new Promise(() => {});
        },
      }),
    };
    const { id, execution } = await fixture.tasks.start(tools, "deaf", {}, "call");
    const closed = fixture.tasks.close();
    await expect(Promise.race([closed.then(() => "closed"), sleep(1000).then(() => "timeout")])).resolves.toBe("closed");
    expect(fixture.tasks.status(id).state).toBe("interrupted");
    expect(fixture.notices).toEqual([]);
    expect(runs).toBe(1);
    const records = await ledger(fixture.home);
    expect(records.filter((record) => record.kind === "terminal")).toHaveLength(1);
    void execution.catch(() => {});
  });

  it("ignores a completion that arrives after shutdown", async () => {
    const fixture = await makeFixture();
    const gate = Promise.withResolvers<void>();
    const tools: ToolSet = { late: tool({ inputSchema: anyObject, execute: async () => (await gate.promise, "late result") }) };
    const { id, execution } = await fixture.tasks.start(tools, "late", {}, "call");
    await fixture.tasks.close();
    gate.resolve();
    await execution;
    expect(fixture.notices).toEqual([]);
    expect(fixture.tasks.status(id).state).toBe("interrupted");
    const records = await ledger(fixture.home);
    expect(records.filter((record) => record.kind === "terminal")).toHaveLength(1);
  });
});

async function makeFixture(options: { home?: string; maxTasks?: number } = {}): Promise<Fixture & { tasks: CodemodeTasks }> {
  return fixture(options);
}

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

interface Probe {
  runtime: AgentRuntime;
  bodies: Array<{ messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }>;
  turn: () => Promise<AgentMessage[]>;
}

function script(js: string, id?: string): Call {
  return { name: "codemode", id, input: { i: "执行脚本", js } };
}

function finish(): Call {
  return { name: "finish", input: { i: "结束" } };
}

function toolTexts(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.output.type === "text" || part.output.type === "error-text" ? [part.output.value] : []))
      : [],
  );
}

async function probe(options: { home: string; tools?: ToolSet; steps: (index: number) => Call[] }): Promise<Probe> {
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
    home: options.home,
    model: gateway.languageModel("mock:vision"),
    instructions: "test",
    tools: { finish: createFinish(), ...options.tools },
    extensions: [],
    context: { renderMessages: (messages) => collapse(messages) },
    wakeup: { attach: () => () => {} },
    codemode: CodemodeConfig({ enable: true, direct: [] } as never),
    pacing: { maxSteps: 20, wrapUpSteps: 0, progressAt: 0 },
    debugStream: false,
    logger: logger as never,
    resources: new ResourceCenter("codemode", options.home),
    attachment: { imageInput: false } as never,
  } satisfies AgentRuntimeConfig);
  runtimes.push(runtime);
  const turn = async (): Promise<AgentMessage[]> => {
    const before = (await runtime.storage.read()).filter(
      (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
    ).length;
    runtime.wake("run");
    await until(async () => {
      const entries = await runtime.storage.read();
      const terminal = entries.filter(
        (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
      );
      return terminal.length > before;
    });
    return (await runtime.storage.read()).flatMap((entry) => (entry.type === "message" ? [entry.data] : []));
  };
  return { runtime, bodies, turn };
}

function customMessages<T>(entries: readonly AgentEntry[], type: string): T[] {
  const found: T[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message: unknown = entry.data;
    if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) continue;
    if (!("data" in message)) continue;
    const payload: unknown = message.data;
    found.push(payload as T);
  }
  return found;
}

async function noticesOf(runtime: AgentRuntime): Promise<IshikiTaskNotice[]> {
  return customMessages<IshikiTaskNotice>(await runtime.storage.read(), "ishiki.task");
}

function taskIdOf(messages: AgentMessage[]): string {
  const match = /"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(toolTexts(messages)[0] ?? "");
  if (match === null) throw new Error("script result did not contain a task id");
  return match[1]!;
}

describe("task namespace", () => {
  it("starts tasks, reports shapes, and rejects bad names from inside the sandbox", async () => {
    const home = await tempHome();
    const tools: ToolSet = {
      slow: tool({
        inputSchema: anyObject,
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
          }),
      }),
      plain: tool({ inputSchema: anyObject, execute: async () => "plain" }),
    };
    const run = await probe({
      home,
      tools,
      steps: (index) =>
        index === 0
          ? [
              script(
                [
                  'const id = await task.start("slow", {});',
                  "const running = await task.status(id);",
                  "const pending = await task.result(id);",
                  "const cancelled = await task.cancel(id);",
                  "return { kind: typeof id, id, running, pending, cancelled };",
                ].join("\n"),
                "lifecycle",
              ),
              script(
                [
                  "const failures = [];",
                  'for (const name of ["missing", "finish", "codemode"]) {',
                  "  try { await task.start(name, {}); } catch (error) { failures.push(String(error)); }",
                  "}",
                  'try { await task.status("missing"); } catch (error) { failures.push(String(error)); }',
                  "return failures;",
                ].join("\n"),
                "failures",
              ),
            ]
          : [finish()],
    });
    const messages = await run.turn();
    const texts = toolTexts(messages);
    const payload = JSON.parse(/=== RESULT ===\n(.+)$/m.exec(texts[0]!)![1]!) as {
      kind: string;
      running: { state: string };
      pending: Record<string, unknown>;
      cancelled: { state: string };
    };
    expect(payload.kind).toBe("string");
    expect(payload.running.state).toBe("running");
    expect(payload.pending).not.toHaveProperty("text");
    expect(payload.cancelled.state).toBe("cancelling");
    const failures = JSON.parse(/=== RESULT ===\n(.+)$/m.exec(texts[1]!)![1]!) as string[];
    expect(failures[0]).toContain('unknown host tool "missing"');
    expect(failures[1]).toContain('tool "finish" cannot run as a background task');
    expect(failures[2]).toContain('tool "codemode" cannot run as a background task');
    expect(failures[3]).toContain('unknown task "missing"');
    await until(async () => (await noticesOf(run.runtime)).some((notice) => notice.state === "cancelled"));
    const cancelled = (await noticesOf(run.runtime))[0]!;
    expect(cancelled).toMatchObject({ toolName: "slow", state: "cancelled" });
  }, 20000);

  it("keeps a task running after the script's own deadline fails it", async () => {
    const home = await tempHome();
    let runs = 0;
    const tools: ToolSet = {
      slow: tool({
        inputSchema: anyObject,
        execute: async () => {
          runs += 1;
          await sleep(150);
          return "background done";
        },
      }),
    };
    const run = await probe({
      home,
      tools,
      steps: (index) =>
        index === 0
          ? [
              script(
                ['// @options: {"timeout_ms": 1000}', 'await task.start("slow", {});', "await new Promise((resolve) => setTimeout(resolve, 3000));"].join("\n"),
                "timeout",
              ),
            ]
          : [finish()],
    });
    const messages = await run.turn();
    expect(toolTexts(messages)[0]).toMatch(/timed out|timeout/i);
    await until(async () => (await noticesOf(run.runtime)).length >= 1);
    const notice = (await noticesOf(run.runtime))[0]!;
    expect(notice).toMatchObject({ toolName: "slow", state: "succeeded", summary: "background done" });
    expect(runs).toBe(1);
  }, 20000);

  it("keeps the model-facing tool list free of task entries", async () => {
    const home = await tempHome();
    const run = await probe({ home, steps: (index) => (index === 0 ? [script("return 1;")] : [finish()]) });
    await run.turn();
    const listed = (run.bodies[0]!.tools ?? []).map((entry) => entry.function?.name);
    expect(listed).toEqual(["finish", "wait", "codemode"]);
    const codemode = run.bodies[0]!.tools?.find((entry) => entry.function?.name === "codemode");
    expect(JSON.stringify(codemode?.function?.parameters)).not.toContain("task");
  }, 20000);
});

describe("task delivery", () => {
  it("delivers one notice with its attachment and wakes the session", async () => {
    const home = await tempHome();
    const tools: ToolSet = {
      shot: tool({
        inputSchema: anyObject,
        execute: async () => ({ summary: "screenshot", attachments: [{ type: "image", mimeType: "image/png", data: PNG }] }),
      }),
    };
    const run = await probe({
      home,
      tools,
      steps: (index) => (index === 0 ? [script('const id = await task.start("shot", {}); return id;')] : [finish()]),
    });
    const messages = await run.turn();
    const id = taskIdOf(messages);
    await until(async () => (await noticesOf(run.runtime)).length >= 1);
    const notice = (await noticesOf(run.runtime))[0]!;
    expect(notice).toMatchObject({ taskId: id, toolName: "shot", state: "succeeded", summary: "1 个附件" });
    const attachment = customMessages<{ source: string; taskId: string; items: AttachmentItem[] }>(await run.runtime.storage.read(), "ishiki.attachment")[0]!;
    expect(attachment).toMatchObject({ source: "task", taskId: id });
    expect(attachment.items).toHaveLength(1);
    await until(async () => run.bodies.length >= 3);
    const wake = JSON.stringify(run.bodies.at(-1)!.messages);
    expect(wake).toContain("后台任务");
    expect(wake).toContain(`task.result(\\"${id}\\")`);
  }, 20000);

  it("notifies failures with the error summary and no attachment", async () => {
    const home = await tempHome();
    const tools: ToolSet = {
      boom: tool({
        inputSchema: anyObject,
        execute: async () => {
          throw new Error("disk on fire");
        },
      }),
    };
    const run = await probe({
      home,
      tools,
      steps: (index) => (index === 0 ? [script('const id = await task.start("boom", {}); return id;')] : [finish()]),
    });
    const id = taskIdOf(await run.turn());
    await until(async () => (await noticesOf(run.runtime)).length >= 1);
    const notice = (await noticesOf(run.runtime))[0]!;
    expect(notice).toMatchObject({ taskId: id, toolName: "boom", state: "failed", summary: "disk on fire" });
    expect(customMessages(await run.runtime.storage.read(), "ishiki.attachment")).toEqual([]);
    await until(async () => run.bodies.length >= 3);
    const wake = JSON.stringify(run.bodies.at(-1)!.messages);
    expect(wake).toContain(`task.result(\\"${id}\\")`);
  }, 20000);

  it("delivers chat messages from a background send_message task", async () => {
    const setup = await startApp();
    setups.push(setup);
    const sendMessage = createSendMessage({
      ctx: setup.app,
      logger: logger as never,
      domain: { mode: "channel", platform: "test", selfId: "10001", channelId: "room" },
      typing: { baseDelay: 0, charPerSecond: 1000, minDelay: 0, maxDelay: 0 },
    });
    const home = await tempHome();
    const run = await probe({
      home,
      tools: { send_message: sendMessage },
      steps: (index) => (index === 0 ? [script('const id = await task.start("send_message", { messages: ["后台问候"] }); return id;')] : [finish()]),
    });
    const id = taskIdOf(await run.turn());
    await until(async () => (await noticesOf(run.runtime)).some((notice) => notice.taskId === id));
    const notice = (await noticesOf(run.runtime)).find((entry) => entry.taskId === id)!;
    expect(notice.state).toBe("succeeded");
    expect(setup.bot.sent.join("\n")).toContain("后台问候");
  }, 30000);

  it("merges two completions into one notice batch and one wake", async () => {
    const home = await tempHome();
    const tasks = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const tools: ToolSet = {
      first: tool({ inputSchema: anyObject, execute: async () => (await tasks.promise, "first done") }),
      second: tool({ inputSchema: anyObject, execute: async () => (await tasks.promise, "second done") }),
      hold: tool({ inputSchema: anyObject, execute: () => held.promise }),
    };
    const run = await probe({
      home,
      tools,
      steps: (index) =>
        index === 0
          ? [script('const ids = [await task.start("first", {}), await task.start("second", {})]; return ids;')]
          : index === 1
            ? [script('await tools.hold(); return "released";')]
            : [finish()],
    });
    const turn = run.turn();
    await until(async () => run.bodies.length >= 2);
    tasks.resolve();
    await sleep(100);
    held.resolve();
    await turn;
    await until(async () => run.bodies.length >= 4);
    await sleep(50);
    expect(run.bodies).toHaveLength(4);
    const notices = await noticesOf(run.runtime);
    expect(notices.map((notice) => notice.state)).toEqual(["succeeded", "succeeded"]);
    const batch = JSON.stringify(run.bodies.at(-1)!.messages);
    expect(batch.match(/\] 后台任务 /g)).toHaveLength(2);
    expect(batch).toContain(notices[0]!.taskId);
    expect(batch).toContain(notices[1]!.taskId);
  }, 20000);

  it("restores a settled result after a restart without replaying the tool", async () => {
    const home = await tempHome();
    let runs = 0;
    const tools: ToolSet = {
      quick: tool({
        inputSchema: valueSchema,
        execute: async (input) => {
          runs += 1;
          return { echoed: input.value };
        },
      }),
    };
    const first = await probe({
      home,
      tools,
      steps: (index) => (index === 0 ? [script('const id = await task.start("quick", { value: "kept" }); return id;')] : [finish()]),
    });
    const messages = await first.turn();
    const id = taskIdOf(messages);
    await until(async () => (await noticesOf(first.runtime)).length >= 1);
    await first.runtime.stop();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const before = await ledger(home);
    const beforeNotices = (await noticesOf(first.runtime)).length;

    const second = await probe({ home, tools, steps: () => [script(`return await task.result(${JSON.stringify(id)});`), finish()] });
    const after = await second.turn();
    const latest = toolTexts(after).at(-1)!;
    expect(latest).toContain('"state":"succeeded"');
    expect(latest).toContain("kept");
    expect(runs).toBe(1);
    expect(await ledger(home)).toEqual(before);
    expect(await noticesOf(second.runtime)).toHaveLength(beforeNotices);
    await second.runtime.stop();
    runtimes.splice(runtimes.indexOf(second.runtime), 1);
    expect(await ledger(home)).toEqual(before);
  }, 20000);

  it("interrupts an unfinished task on shutdown without waking the restored runtime", async () => {
    const home = await tempHome();
    let runs = 0;
    const tools: ToolSet = {
      hang: tool({
        inputSchema: anyObject,
        execute: () => {
          runs += 1;
          return new Promise(() => {});
        },
      }),
    };
    const first = await probe({
      home,
      tools,
      steps: (index) => (index === 0 ? [script('const id = await task.start("hang", {}); return id;')] : [finish()]),
    });
    const messages = await first.turn();
    const id = taskIdOf(messages);
    await first.runtime.stop();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const records = await ledger(home);
    expect(records.map((record) => record.kind)).toEqual(["start", "terminal"]);
    expect(records[1]).toMatchObject({ id, state: "interrupted" });

    const second = await probe({ home, tools, steps: () => [script(`return await task.result(${JSON.stringify(id)});`), finish()] });
    const after = await second.turn();
    const latest = toolTexts(after).at(-1)!;
    expect(latest).toContain('"state":"interrupted"');
    expect(latest).not.toContain("error");
    expect(runs).toBe(1);
    expect(await noticesOf(second.runtime)).toEqual([]);
    expect(await ledger(home)).toEqual(records);
  }, 20000);
});
