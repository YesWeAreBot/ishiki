import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCustomMessage } from "../../packages/koishi-plugin-ishiki/node_modules/@yesimagent/core";
import { createGateway } from "../../packages/koishi-plugin-ishiki/node_modules/@yesimagent/gateway";
import type { Context } from "../../packages/koishi-plugin-ishiki/node_modules/koishi";
import { parse } from "../../packages/koishi-plugin-ishiki/node_modules/yaml";
import { createFinish } from "../../packages/koishi-plugin-ishiki/src/builtin-tools/finish.js";
import { createReadTool } from "../../packages/koishi-plugin-ishiki/src/builtin-tools/read.js";
import { createSendMessage } from "../../packages/koishi-plugin-ishiki/src/builtin-tools/send-message.js";
import { StandardContextInstance } from "../../packages/koishi-plugin-ishiki/src/context/standard.engine.js";
import { createAgentOverlayPlugin } from "../../packages/koishi-plugin-ishiki/src/debug/agent-overlay.js";
import { renderInstructions } from "../../packages/koishi-plugin-ishiki/src/instructions.js";
import { resolveProfile } from "../../packages/koishi-plugin-ishiki/src/profile/config.js";
import type { InstanceDomain } from "../../packages/koishi-plugin-ishiki/src/profile/index.js";
import { ResourceCenter } from "../../packages/koishi-plugin-ishiki/src/resource/center.js";
import { AgentRuntime } from "../../packages/koishi-plugin-ishiki/src/runtime.js";
import { StandardWakeupInstance } from "../../packages/koishi-plugin-ishiki/src/wakeup/standard.engine.js";

type JsonObject = Record<string, unknown>;

type Scenario = {
  id: string;
  domain: string;
  platform: string;
  selfId: string;
  channelId: string;
  message: {
    messageId: string;
    userId: string;
    userName?: string;
    content: string;
    isDirect: boolean;
  };
  expected: { replyCount: number; contains?: string };
};

const logger = {
  level: 1,
  debug: (..._args: unknown[]) => undefined,
  info: (..._args: unknown[]) => undefined,
  warn: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
};

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function args(): { scenario: string; harness: string; runDir: string; timeoutMs: number } {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    values.set(key.slice(2), value);
  }
  const scenario = values.get("scenario");
  const harness = values.get("harness");
  const runDir = values.get("run-dir");
  if (!scenario || !harness || !runDir) throw new Error("required arguments: --scenario --harness --run-dir");
  const timeoutMs = Number(values.get("timeout-ms") ?? "300000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be positive");
  return { scenario, harness, runDir, timeoutMs };
}

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));

async function readScenario(id: string): Promise<Scenario> {
  const file = path.join(runnerRoot, "scenarios", id, "scenario.json");
  const parsed = object(JSON.parse(await readFile(file, "utf8")), `scenario ${id}`);
  const message = object(parsed.message, "scenario.message");
  const expected = object(parsed.expected, "scenario.expected");
  return {
    id: stringValue(parsed.id, "scenario.id"),
    domain: stringValue(parsed.domain, "scenario.domain"),
    platform: stringValue(parsed.platform, "scenario.platform"),
    selfId: stringValue(parsed.selfId, "scenario.selfId"),
    channelId: stringValue(parsed.channelId, "scenario.channelId"),
    message: {
      messageId: stringValue(message.messageId, "scenario.message.messageId"),
      userId: stringValue(message.userId, "scenario.message.userId"),
      userName: typeof message.userName === "string" ? message.userName : undefined,
      content: stringValue(message.content, "scenario.message.content"),
      isDirect: message.isDirect === true,
    },
    expected: {
      replyCount: Number(expected.replyCount),
      contains: typeof expected.contains === "string" ? expected.contains : undefined,
    },
  };
}

async function readProfile(harness: string): Promise<JsonObject> {
  return object(parse(await readFile(path.join(harness, "profile.yml"), "utf8")), "profile.yml");
}

async function readSkills(harness: string): Promise<string> {
  const root = path.join(harness, "skills");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const sections: string[] = [];
  for (const name of names) {
    const file = path.join(root, name, "SKILL.md");
    sections.push(`## Skill ${name}\n${(await readFile(file, "utf8")).trim()}`);
  }
  return sections.join("\n\n");
}

function modelRef(id: string): { provider: string; model: string; id: string } {
  stringValue(id, "profile.model");
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) throw new Error(`profile.model must be provider:model, got ${id}`);
  return { provider: id.slice(0, separator), model: id.slice(separator + 1), id };
}

function wakeConfig(profile: JsonObject): Record<string, unknown> {
  const wakeup = profile.wakeup;
  if (wakeup === null || typeof wakeup !== "object" || Array.isArray(wakeup)) return {};
  const standard = (wakeup as JsonObject).standard;
  return standard !== null && typeof standard === "object" && !Array.isArray(standard) ? (standard as Record<string, unknown>) : {};
}

async function waitForSilence(timeoutMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, timeoutMs);
  await promise;
}

async function waitForTurn(runtime: AgentRuntime, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await runtime.storage.read();
    const terminal = entries.find(
      (entry) => entry.type === "event" && (entry.data.type === "turn.done" || entry.data.type === "turn.failed" || entry.data.type === "turn.aborted"),
    );
    if (terminal?.type === "event") {
      if (terminal.data.type !== "turn.done") throw new Error(`Ishiki turn ended as ${terminal.data.type}`);
      return;
    }
    await waitForSilence(25);
  }
  throw new Error(`Ishiki turn did not finish within ${timeoutMs} ms`);
}

async function run(): Promise<void> {
  const input = args();
  const scenario = await readScenario(input.scenario);
  const harness = path.resolve(input.harness);
  const runDir = path.resolve(input.runDir);
  await mkdir(runDir, { recursive: true });
  const rawProfile = await readProfile(harness);
  const profile = resolveProfile(rawProfile, "harness", harness);
  if (profile.mode !== "channel") throw new Error("Ishiki headless runner supports channel profiles only");
  const settings = profile.settings;
  const unsupported = [
    settings.context.engine !== "standard" ? `context engine ${settings.context.engine}` : "",
    settings.wakeup.engine !== "standard" ? `wakeup engine ${settings.wakeup.engine}` : "",
    settings.toolcall.engine !== "native" ? `toolcall engine ${settings.toolcall.engine}` : "",
    settings.codemode.enable ? "codemode" : "",
    settings.attachment.imageInput ? "image input" : "",
    Object.keys(profile.extensions).length > 0 ? "profile extensions" : "",
  ].filter((value) => value.length > 0);
  if (unsupported.length > 0) throw new Error(`Ishiki headless runner does not support: ${unsupported.join(", ")}`);
  const configuredModel = settings.model === "openai:ishiki" ? (process.env.ISHIKI_MODEL ?? settings.model) : settings.model;
  const model = modelRef(configuredModel);
  const needsModel = scenario.expected.replyCount > 0;
  if (needsModel && model.id === "openai:ishiki") throw new Error("Set ISHIKI_MODEL or replace model: openai:ishiki in profile.yml before a model rollout");
  const apiKey = process.env.ISHIKI_API_KEY ?? process.env.OPENAI_API_KEY ?? (needsModel ? undefined : "offline");
  if (!apiKey) throw new Error("ISHIKI_API_KEY or OPENAI_API_KEY is required for a model rollout");
  const gateway = createGateway({
    config: {
      providers: {
        [model.provider]: {
          api: "openai-completions",
          baseUrl: process.env.ISHIKI_BASE_URL ?? "https://api.openai.com/v1",
          apiKey,
          models: [{ id: model.model, type: "language", input: ["text"] }],
        },
      },
    },
  });
  const replies: string[] = [];
  const bot = {
    sendMessage: async (_channelId: string, fragment: unknown): Promise<string[]> => {
      replies.push(String(fragment));
      return [`harness-${replies.length}`];
    },
  };
  const ctx = { bots: { [`${scenario.platform}:${scenario.selfId}`]: bot } } as unknown as Context;
  const domain: InstanceDomain = {
    mode: "channel",
    platform: scenario.platform,
    selfId: scenario.selfId,
    channelId: scenario.channelId,
  };
  const runtimeHome = path.join(runDir, "runtime");
  const resources = new ResourceCenter(`harness/${scenario.id}`, runtimeHome);
  const persona = (await readFile(path.join(harness, "persona.md"), "utf8")).trim();
  const overlay = createAgentOverlayPlugin({ root: harness, instructionFiles: ["prompts/instructions.md"] });
  const skills = await readSkills(harness);
  const skillOverlay = {
    name: "ishiki.harness.skills",
    enforce: "post" as const,
    extendInstructions: () => skills,
  };
  const readLifetime = settings.attachment.imageInput && !settings.codemode.enable;
  const instructions = renderInstructions({
    enableCodemode: settings.codemode.enable,
    enableImageInput: settings.attachment.imageInput,
    enableReadLifetime: readLifetime,
    instructions: persona,
  });
  const wake = wakeConfig(rawProfile);
  const runtime = new AgentRuntime({
    id: `harness/${scenario.id}`,
    home: runtimeHome,
    model: gateway.languageModel(model.id),
    instructions,
    tools: {
      read: createReadTool({ center: resources, lifetime: readLifetime }),
      finish: createFinish(),
      send_message: createSendMessage({
        ctx,
        logger: logger as never,
        domain,
        typing: settings.typing,
        resources,
      }),
    },
    extensions: [],
    externalPlugins: [overlay, skillOverlay],
    context: new StandardContextInstance(settings.context.standard ?? {}, { domain } as never),
    wakeup: new StandardWakeupInstance(wake),
    codemode: settings.codemode,
    pacing: settings.pacing,
    debugStream: false,
    logger: logger as never,
    resources,
    attachment: settings.attachment,
  });
  const event = createCustomMessage("ishiki.message.created", {
    timestamp: Date.now(),
    platform: scenario.platform,
    selfId: scenario.selfId,
    channelId: scenario.channelId,
    messageId: scenario.message.messageId,
    content: scenario.message.content,
    isDirect: scenario.message.isDirect,
    user: { id: scenario.message.userId, name: scenario.message.userName },
  });
  let status = "completed";
  let errorMessage = "";
  try {
    await runtime.deliver(event);
    const waitMs = scenario.expected.replyCount === 0 ? Math.min(input.timeoutMs, 500) : input.timeoutMs;
    if (scenario.expected.replyCount === 0) await waitForSilence(waitMs);
    else await waitForTurn(runtime, waitMs);
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await runtime.stop();
    const events = path.join(runtimeHome, "events.jsonl");
    try {
      await copyFile(events, path.join(runDir, "events.jsonl"));
    } catch (error) {
      if (!errorMessage) {
        status = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }
  await writeFile(path.join(runDir, "response.txt"), replies.join("\n"), "utf8");
  await writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify({ status, scenario: scenario.id, model: model.id, replies, errorMessage }, null, 2) + "\n",
    "utf8",
  );
  if (status !== "completed") throw new Error(errorMessage);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
