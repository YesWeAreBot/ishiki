import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  data: { next?: Focus } & Record<string, unknown>;
}

export interface Bubble {
  channelId: string;
  content: unknown;
}

export interface Harness {
  send(overrides?: Partial<Session>): Promise<void>;
  bubbles: Record<string, Bubble[]>;
  calls(): number;
  /** Every prompt the model was asked with, in call order. */
  prompts(): unknown[];
  entries(): Promise<StoredEntry[]>;
}

export function makeProfile(): Profile {
  return {
    id: "test",
    dataPath: "data/ishiki/test",
    model: "test:model",
    initialFocus: { sid: "onebot:1", channelId: "group:1" },
    allowedChannels: [
      { sid: "onebot:1", channels: ["group:1"] },
      { sid: "onebot:2", channels: ["group:9"] },
    ],
    keywords: [],
    attention: { mentions: [], quoteSelf: false },
    context: { workspaceTokenLimit: 8192, idleMs: 1_800_000, historyEntries: 40, focusHistoryEntries: 40, toolResultChars: 2000 },
    innerThought: false,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  } as unknown as Session;
}

const temporaryDirectories: string[] = [];

export async function cleanupTemporaryDirectories(): Promise<void> {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
}

/**
 * Runs one profile against a scripted model, real jsonl storage and a fake platform. Everything the tests
 * assert is either what the model saw, what the platform received, or what landed in storage.
 */
export async function createHarness(
  steps: LanguageModelV4StreamPart[][],
  options: { failingContents?: string[]; profile?: Partial<Profile> } = {},
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

  const bubbles: Record<string, Bubble[]> = { "onebot:1": [], "onebot:2": [] };
  const bots = Object.fromEntries(
    Object.entries(bubbles).map(([sid, log]) => [
      sid,
      {
        sid,
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
  const gateway = { languageModel: () => model };

  const runtime = new ProfileRuntime(ctx as unknown as Context, {
    profile: { ...makeProfile(), ...options.profile },
    gateway: gateway as unknown as Gateway,
    profilesPath: "profiles.yaml",
  });
  await runtime.start();

  return {
    bubbles,
    calls: () => calls,
    prompts: () => prompts,
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
