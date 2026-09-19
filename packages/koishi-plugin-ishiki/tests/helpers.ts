import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MockLanguageModelV4,
  simulateReadableStream,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger, Session } from "koishi";

import type { Focus, Profile } from "../src/profiles.js";
import { ProfileRuntime } from "../src/runtime.js";
import "../src/types.js";

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

export function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

export function toolCallStep(...calls: Array<{ toolCallId: string; toolName: string; input: unknown }>): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [];
  for (const call of calls) {
    const encoded = JSON.stringify(call.input);
    parts.push(
      { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName },
      { type: "tool-input-delta", id: call.toolCallId, delta: encoded },
      { type: "tool-input-end", id: call.toolCallId },
      { type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: encoded },
    );
  }
  parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE });
  return parts;
}

export interface StoredEntry {
  type: string;
  data: { next?: Focus; previous?: Focus; frameFocus?: Focus; prevFocus?: Focus; text?: string } & Record<string, unknown>;
}

export interface Bubble {
  channelId: string;
  content: unknown;
}

export interface Harness {
  send(overrides?: Record<string, unknown>): Promise<void>;
  bubbles: Record<string, Bubble[]>;
  calls(): number;
  /** Every prompt the model was asked with, in call order. */
  prompts(): unknown[];
  entries(): Promise<StoredEntry[]>;
  /** Stops the profile so its idle timer does not outlive the test. */
  close(): Promise<void>;
}

/** The prompt as the model saw it, with JSON escapes undone so markup can be searched literally. */
export function promptText(prompts: unknown[], index: number): string {
  return JSON.stringify(prompts[index]).replaceAll('\\"', '"');
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function waitFor<T>(produce: () => Promise<T | undefined> | T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await delay(10);
  }
}

export function makeProfile(): Profile {
  return {
    id: "test",
    dataPath: "data/ishiki/test",
    model: "test:model",
    name: "",
    initialFocus: { sid: "onebot:1", channelId: "group:1" },
    allowedChannels: [
      { sid: "onebot:1", channels: ["group:1"] },
      { sid: "onebot:2", channels: ["group:9"] },
    ],
    keywords: [],
    attention: { mentions: [], quoteSelf: false },
    context: { workspaceTokenLimit: 8192, charsPerToken: 4, idleMs: 1_800_000, historyEntries: 40, sceneWindowMs: 24 * 60 * 60 * 1000 },
    innerThought: false,
  };
}

export function makeContext(overrides: Partial<Profile["context"]>): Profile["context"] {
  return { ...makeProfile().context, ...overrides };
}

export function makeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    type: "message-created",
    sid: "onebot:1",
    platform: "onebot",
    selfId: "1",
    userId: "42",
    channelId: "group:1",
    messageId: "m1",
    content: "hello",
    timestamp: Date.now(),
    isDirect: true,
    elements: [],
    stripped: { content: "hello", prefix: "", appel: false, hasAt: false, atSelf: false },
    author: { name: "Miaow" },
    event: { channel: { id: "group:1", name: "开发组", type: 0 } },
    ...overrides,
  } as unknown as Session;
}

const temporaryDirectories: string[] = [];
const runningRuntimes: ProfileRuntime[] = [];

export async function cleanup(): Promise<void> {
  for (const runtime of runningRuntimes.splice(0)) await runtime.stop();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
}

/**
 * Runs one profile against a scripted model, real jsonl storage and a fake platform. Everything the tests
 * assert is either what the model saw, what the platform received, or what landed in storage.
 */
export async function createHarness(
  steps: LanguageModelV4StreamPart[][],
  options: { failingContents?: string[]; profile?: Partial<Profile>; seed?: string[]; contextWindow?: number; botName?: string } = {},
): Promise<Harness> {
  const failingContents = new Set(options.failingContents ?? []);
  let calls = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (request: LanguageModelV4CallOptions) => {
      prompts.push(request.prompt);
      const chunks = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });

  const baseDir = await mkdtemp(path.join(tmpdir(), "ishiki-"));
  temporaryDirectories.push(baseDir);
  const file = path.join(baseDir, "data/ishiki/test/messages.jsonl");
  if (options.seed !== undefined && options.seed.length > 0) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${options.seed.join("\n")}\n`, "utf-8");
  }

  const bubbles: Record<string, Bubble[]> = { "onebot:1": [], "onebot:2": [] };
  const bots = Object.fromEntries(
    Object.entries(bubbles).map(([sid, log]) => [
      sid,
      {
        sid,
        platform: sid.slice(0, sid.indexOf(":")),
        // The account id the platform reports for this body, deliberately not the sid's own component: `sandbox`
        // reports `koishi` for `mi4dnd8k69r:koishi`, so nothing may depend on the two agreeing.
        selfId: sid.slice(sid.indexOf(":") + 1),
        user: { id: "koishi", ...(options.botName === "" ? {} : { name: options.botName ?? "NekoChan" }) },
        sendMessage: async (channelId: string, content: unknown) => {
          if (failingContents.has(String(content))) throw new Error("platform down");
          log.push({ channelId, content });
          return [`id-${log.length}`];
        },
      },
    ]),
  );

  const handlers = new Map<string, (session: Session) => unknown>();
  const logger = { level: 0, info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
  const ctx = {
    baseDir,
    bots,
    logger: () => logger as unknown as Logger,
    on: (name: string, handler: (session: Session) => unknown) => {
      handlers.set(name, handler);
    },
  };
  const gateway = {
    languageModel: () => model,
    models: () => (options.contextWindow === undefined ? [] : [{ id: "test:model", metadata: { contextWindow: options.contextWindow } }]),
  };

  const runtime = new ProfileRuntime(ctx as unknown as Context, {
    profile: { ...makeProfile(), ...options.profile },
    gateway: gateway as unknown as Gateway,
    profilesPath: "profiles.yaml",
    logLevel: 0,
  });
  await runtime.start();
  runningRuntimes.push(runtime);

  return {
    bubbles,
    calls: () => calls,
    prompts: () => prompts,
    async close() {
      await runtime.stop();
    },
    async send(overrides = {}) {
      const handler = handlers.get("internal/session");
      if (!handler) throw new Error("ingestion handler was not registered");
      await handler(makeSession(overrides));
    },
    async entries() {
      const content = await readFile(file, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as StoredEntry);
    },
  };
}
