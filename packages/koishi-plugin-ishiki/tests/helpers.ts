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

import type { Profile, SceneAddress } from "../src/profiles.js";
import { createRegistry, type CapabilityRegistry } from "../src/registry.js";
import { ProfileRuntime } from "../src/runtime.js";
import { sceneDirectoryOf } from "../src/scene-runtime.js";
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
  data: Record<string, unknown>;
}

export interface Bubble {
  channelId: string;
  content: unknown;
}

/** The scene every test starts from unless it names another one. */
export const DEFAULT_SCENE: SceneAddress = { sid: "onebot:1", channelId: "group:1" };

export interface Harness {
  send(overrides?: Record<string, unknown>): Promise<void>;
  bubbles: Record<string, Bubble[]>;
  calls(): number;
  /** Every prompt the model was asked with, in call order. */
  prompts(): unknown[];
  /** The entries of one scene's own stream; the default scene unless one is named. */
  entries(scene?: SceneAddress): Promise<StoredEntry[]>;
  /** The scene's stream file, so a test can assert it exists or not. */
  sceneFile(scene?: SceneAddress): string;
  /** The scenes the profile holds in memory right now, by scene key. */
  mountedScenes(): readonly string[];
  /** Stops the profile so its timers do not outlive the test. */
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

/** A profile whose rules cover onebot:1 in group:1 and group:9, and onebot:2 in group:9. */
export function makeProfile(): Profile {
  return {
    id: "test",
    catalog: "test",
    profilePath: path.join(tmpdir(), "ishiki-profiles/test/profile.yaml"),
    model: "test:model",
    systemPrompt: "（测试人格）",
    name: "",
    sids: ["onebot:1", "onebot:2"],
    channelRules: [
      { match: { sid: "onebot:1", channelId: "group:1" }, preset: "default" },
      { match: { sid: "onebot:1", channelId: "group:9" }, preset: "default" },
      { match: { sid: "onebot:2", channelId: "group:9" }, preset: "default" },
    ],
    defaults: {},
    presets: { default: {} },
    innerThought: false,
    typing: { baseDelay: 0, charPerSecond: 5, minDelay: 0, maxDelay: 0 },
  };
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

/** A directory the harness may reuse across instances, removed by `cleanup()`. */
export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ishiki-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A profile override laying the given context numbers under every scene. */
export function contextDefaults(settings: NonNullable<Profile["defaults"]["context"]>): Partial<Profile> {
  return { defaults: { context: settings } };
}

export async function cleanup(): Promise<void> {
  for (const runtime of runningRuntimes.splice(0)) await runtime.stop();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
}

/**
 * Runs one profile against a scripted model, real per-scene jsonl storage and a fake platform. Everything the
 * tests assert is either what the model saw, what the platform received, or what landed in a scene's stream.
 */
export async function createHarness(
  steps: LanguageModelV4StreamPart[][],
  options: {
    failingContents?: string[];
    profile?: Partial<Profile>;
    seed?: string[];
    contextWindow?: number;
    botName?: string;
    /** Reuse a directory across harnesses to model a restart. */
    baseDir?: string;
    /** The capability registry the runtime reads; a fresh one with the built-ins unless a test extends it. */
    registry?: CapabilityRegistry;
  } = {},
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

  const baseDir = options.baseDir ?? (await mkdtemp(path.join(tmpdir(), "ishiki-")));
  if (options.baseDir === undefined) temporaryDirectories.push(baseDir);
  const dataRoot = path.join(baseDir, "data/ishiki");
  const profile = { ...makeProfile(), ...options.profile };
  const sceneFile = (scene: SceneAddress = DEFAULT_SCENE) =>
    path.join(sceneDirectoryOf(path.join(dataRoot, "profiles", profile.catalog), scene), "session.jsonl");

  if (options.seed !== undefined && options.seed.length > 0) {
    const file = sceneFile();
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
    profile,
    gateway: gateway as unknown as Gateway,
    dataRoot,
    registry: options.registry ?? createRegistry(),
    logLevel: 0,
  });
  await runtime.start();
  runningRuntimes.push(runtime);

  return {
    bubbles,
    calls: () => calls,
    prompts: () => prompts,
    sceneFile,
    mountedScenes: () => runtime.mountedScenes(),
    async close() {
      await runtime.stop();
    },
    async send(overrides = {}) {
      const handler = handlers.get("internal/session");
      if (!handler) throw new Error("ingestion handler was not registered");
      await handler(makeSession(overrides));
    },
    async entries(scene: SceneAddress = DEFAULT_SCENE) {
      const content = await readFile(sceneFile(scene), "utf-8").catch(() => "");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as StoredEntry);
    },
  };
}
