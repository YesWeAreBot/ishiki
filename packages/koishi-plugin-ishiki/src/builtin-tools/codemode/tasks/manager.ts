import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { safeValidateTypes, type Tool, type ToolExecutionOptions, type ToolSet } from "@yesimagent/core";

import type { ResourceCenter } from "../../../resource/center.js";
import type { AttachmentItem, IshikiTaskNotice, TaskResult, TaskState, TaskStatus, TerminalTaskState } from "../../../types/messages.js";
import { settled } from "../host-call.js";
import { projectTaskOutput, type TaskOutcome } from "./output.js";
import type { TaskStore } from "./store.js";

export const TASK_START = "task.start";
export const TASK_STATUS = "task.status";
export const TASK_CANCEL = "task.cancel";
export const TASK_RESULT = "task.result";

/** Longest notice summary; the ledger and `task.result` keep the full text. */
const SUMMARY_LIMIT = 120;

export interface CodemodeTaskOptions {
  store: TaskStore;
  maxTasks: number;
  resources: ResourceCenter;
  imageInput: boolean;
  /** Tools that already drive the turn and therefore never run in the background. */
  exclude: readonly string[];
  /** Called after a terminal record is durable; the runtime turns it into a notice and a wake. */
  onSettled(notice: IshikiTaskNotice, items: readonly AttachmentItem[]): void;
}

export interface CodemodeTasks {
  /** Replay the ledger once and mark interrupted leftovers; never executes a tool. */
  open(): Promise<void>;
  /** The task namespace, resolving the host table and call id of the codemode call that is running. */
  globals(current: () => TaskCall | undefined): readonly CodemodeTool[];
  /** Admit one task now, then run it in the background; `execution` resolves after its terminal record. */
  start(tools: ToolSet, toolName: string, input: unknown, toolCallId: string): Promise<{ id: string; execution: Promise<void> }>;
  status(id: string): TaskStatus;
  cancel(id: string): TaskStatus;
  result(id: string): TaskResult;
  /** Mark active tasks interrupted, persist those records, and abort their controllers. */
  close(): Promise<void>;
}

/** What the task namespace needs from the codemode call currently executing a script. */
export interface TaskCall {
  tools: ToolSet;
  toolCallId: string;
}

interface Task {
  id: string;
  toolName: string;
  state: TaskState;
  startedAt: number;
  finishedAt?: number;
  text?: string;
  items?: AttachmentItem[];
  error?: string;
  controller?: AbortController;
}

type Settlement = TaskOutcome | { kind: "cancelled" };

function activeTask(task: Task): boolean {
  return task.state === "running" || task.state === "cancelling";
}

function positional(name: string, args: unknown): unknown[] {
  if (!Array.isArray(args)) throw new TypeError(`${name} expects positional arguments`);
  return args;
}

function taskId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name}(id) expects a task id string`);
  return value;
}

function snapshot(task: Task): TaskStatus {
  return {
    id: task.id,
    toolName: task.toolName,
    state: task.state,
    startedAt: task.startedAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
  };
}

export function createTaskManager(options: CodemodeTaskOptions): CodemodeTasks {
  const { store, maxTasks, resources, imageInput, onSettled } = options;
  const exclude = new Set(options.exclude);
  const tasks = new Map<string, Task>();
  let active = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function requireTask(id: string): Task {
    const task = tasks.get(id);
    if (task === undefined) throw new Error(`unknown task "${id}"`);
    return task;
  }

  function summarize(task: Task): string {
    if (task.state === "succeeded" && task.items !== undefined && task.items.length > 0) return `${task.items.length} 个附件`;
    const source = task.state === "succeeded" ? task.text : task.state === "failed" ? task.error : undefined;
    const line = source
      ?.split("\n")
      .find((part) => part.trim().length > 0)
      ?.trim();
    if (line === undefined || line.length === 0) return "";
    return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}…` : line;
  }

  async function finish(task: Task, outcome: Settlement): Promise<void> {
    if (!activeTask(task)) return;
    const finishedAt = Date.now();
    const state: TerminalTaskState = outcome.kind === "succeeded" ? "succeeded" : outcome.kind === "failed" ? "failed" : "cancelled";
    task.state = state;
    task.finishedAt = finishedAt;
    if (outcome.kind === "succeeded") {
      task.text = outcome.text;
      task.items = outcome.items;
    }
    if (outcome.kind === "failed") task.error = outcome.error;
    active -= 1;
    await store.append({
      kind: "terminal",
      id: task.id,
      state,
      finishedAt,
      ...(outcome.kind === "succeeded" ? { text: outcome.text, items: outcome.items } : {}),
      ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
    });
    if (closed) return;
    onSettled(
      { taskId: task.id, toolName: task.toolName, state, startedAt: task.startedAt, finishedAt, summary: summarize(task) },
      outcome.kind === "succeeded" ? outcome.items : [],
    );
  }

  async function run(task: Task, tool: Tool, input: unknown, toolCallId: string, controller: AbortController): Promise<void> {
    const execution: ToolExecutionOptions<unknown> = { toolCallId, messages: [], abortSignal: controller.signal, context: undefined };
    let raw: unknown;
    try {
      raw = await settled(await tool.execute!(input, execution));
    } catch (error) {
      const cancelled = controller.signal.aborted && (error === controller.signal.reason || (error instanceof Error && error.name === "AbortError"));
      await finish(task, cancelled ? { kind: "cancelled" } : { kind: "failed", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let outcome: TaskOutcome;
    try {
      outcome = await projectTaskOutput({ center: resources, tool, toolName: task.toolName, toolCallId, input, output: raw, imageInput });
    } catch (error) {
      outcome = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    await finish(task, outcome);
  }

  async function start(tools: ToolSet, toolName: string, input: unknown, toolCallId: string): Promise<{ id: string; execution: Promise<void> }> {
    const tool = tools[toolName];
    if (exclude.has(toolName)) throw new Error(`tool "${toolName}" cannot run as a background task`);
    if (tool === undefined) throw new Error(`unknown host tool "${toolName}"`);
    if (tool.execute === undefined) throw new Error(`tool "${toolName}" has no local implementation`);
    const parsed = await safeValidateTypes({ value: input, schema: tool.inputSchema });
    if (!parsed.success) throw parsed.error;
    if (closed) throw new Error("codemode is closing; no background task was started");
    if (active >= maxTasks) throw new Error(`codemode.maxTasks (${maxTasks}) reached; wait for a background task to finish before starting another`);

    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    const task: Task = { id, toolName, state: "running", startedAt, controller };
    tasks.set(id, task);
    active += 1;
    try {
      await store.append({ kind: "start", id, toolName, startedAt });
    } catch (error) {
      tasks.delete(id);
      active -= 1;
      throw error;
    }
    if (!activeTask(task)) throw new Error(`codemode closed before task ${id} ran; the task is ${task.state}`);

    const execution = run(task, tool, parsed.value, `${toolCallId}:task-${id}`, controller);
    return { id, execution };
  }

  function status(id: string): TaskStatus {
    return snapshot(requireTask(id));
  }

  function cancel(id: string): TaskStatus {
    const task = requireTask(id);
    if (task.state === "running") task.state = "cancelling";
    if (activeTask(task)) task.controller?.abort();
    return snapshot(task);
  }

  function result(id: string): TaskResult {
    const task = requireTask(id);
    return {
      ...snapshot(task),
      ...(task.text === undefined ? {} : { text: task.text }),
      ...(task.items === undefined ? {} : { items: task.items.map((item) => ({ ...item })) }),
      ...(task.error === undefined ? {} : { error: task.error }),
    };
  }

  function globals(current: () => TaskCall | undefined): readonly CodemodeTool[] {
    const call = (): TaskCall => {
      const active = current();
      if (active === undefined) throw new Error("no codemode call is active");
      return active;
    };
    const statusSignature = "(id: string): Promise<{ id: string; toolName: string; state: string; startedAt: number; finishedAt?: number }>";
    return [
      {
        name: TASK_START,
        description:
          "Start one host tool as a background task and return its id immediately. The task keeps running after this script ends and its result is announced to the session when it settles.",
        signature: "(toolName: string, input: unknown): Promise<string>",
        spread: true,
        execute: async (args) => {
          const [toolName, input] = positional(TASK_START, args);
          if (typeof toolName !== "string" || toolName.length === 0) throw new TypeError("task.start(toolName, input) expects a tool name string");
          const binding = call();
          return (await start(binding.tools, toolName, input, binding.toolCallId)).id;
        },
      },
      {
        name: TASK_STATUS,
        description: "Return the state and timestamps of one background task.",
        signature: statusSignature,
        spread: true,
        execute: (args) => {
          const [id] = positional(TASK_STATUS, args);
          return status(taskId(TASK_STATUS, id));
        },
      },
      {
        name: TASK_CANCEL,
        description: "Ask one background task to stop and return its current state. It becomes cancelled only if its tool actually stops.",
        signature: statusSignature,
        spread: true,
        execute: (args) => {
          const [id] = positional(TASK_CANCEL, args);
          return cancel(taskId(TASK_CANCEL, id));
        },
      },
      {
        name: TASK_RESULT,
        description: "Return the stored result of one background task: its text, attachment references, or failure summary.",
        signature:
          "(id: string): Promise<{ id: string; toolName: string; state: string; startedAt: number; finishedAt?: number; text?: string; items?: Array<{ url: string; mediaType: string }>; error?: string }>",
        spread: true,
        execute: (args) => {
          const [id] = positional(TASK_RESULT, args);
          return result(taskId(TASK_RESULT, id));
        },
      },
    ];
  }

  async function open(): Promise<void> {
    for (const record of await store.read()) {
      if (record.kind === "start") {
        tasks.set(record.id, { id: record.id, toolName: record.toolName, state: "running", startedAt: record.startedAt });
        continue;
      }
      const task = tasks.get(record.id);
      if (task === undefined) throw new Error(`codemode task ledger has a terminal record for unknown task ${record.id}`);
      task.state = record.state;
      task.finishedAt = record.finishedAt;
      if (record.text !== undefined) task.text = record.text;
      if (record.items !== undefined) task.items = record.items;
      if (record.error !== undefined) task.error = record.error;
    }
    const writes: Array<Promise<void>> = [];
    const now = Date.now();
    for (const task of tasks.values()) {
      if (!activeTask(task)) continue;
      task.state = "interrupted";
      task.finishedAt = now;
      writes.push(store.append({ kind: "terminal", id: task.id, state: "interrupted", finishedAt: now }));
    }
    await Promise.all(writes);
  }

  function shutdown(): Promise<void> {
    closed = true;
    const interrupted: Task[] = [];
    const writes: Array<Promise<void>> = [];
    const now = Date.now();
    for (const task of tasks.values()) {
      if (!activeTask(task)) continue;
      task.state = "interrupted";
      task.finishedAt = now;
      interrupted.push(task);
      writes.push(store.append({ kind: "terminal", id: task.id, state: "interrupted", finishedAt: now }));
    }
    active = 0;
    for (const task of interrupted) task.controller?.abort();
    return Promise.all(writes).then(() => {});
  }

  return {
    open,
    globals,
    start,
    status,
    cancel,
    result,
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}
