import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUserMessage, jsonSchema, tool, type Agent, type LanguageModelV4, type Tool, type ToolSet } from "@yesimagent/core";
import type { Logger } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SEARCH_TOOL, ToolsearchState, createSearchTool } from "../src/builtin-tools/toolsearch.js";
import { buildCodeModeToolCatalogMessage } from "../src/builtin-tools/vendor/tool-prompt.js";
import { ResourceCenter } from "../src/resource/center.js";
import { AgentRuntime, type AgentRuntimeConfig } from "../src/runtime.js";
import { StandardWakeupInstance } from "../src/wakeup/index.js";

const makeTool = (name: string, description: string, inputProps: Record<string, unknown> = {}): Tool =>
  tool({
    description,
    inputSchema: jsonSchema({ type: "object", properties: inputProps }),
    execute: async () => ({ ok: true }),
  });

function makeTools(): ToolSet {
  return {
    finish: makeTool("finish", "finish the current turn"),
    send_message: makeTool("send_message", "send a message to the channel"),
    read: makeTool("read", "read a resource"),
    weather_forecast: makeTool("weather_forecast", "Get the weather forecast for a city.", { city: { type: "string" } }),
    gmail_list_messages: makeTool("gmail_list_messages", "List Gmail messages in the inbox."),
    gmail_get_message: makeTool("gmail_get_message", "Get a single Gmail message by id."),
    calendar_create_event: makeTool("calendar_create_event", "Create a calendar event."),
  };
}

interface SentCatalog {
  text: string;
  tools: readonly string[];
}

/** Minimal agent double: records `send` calls and asserts the joined non-trigger contract. */
function makeAgent() {
  const catalogs: SentCatalog[] = [];
  const appended: unknown[] = [];
  const agent = {
    send: (message: { role: string; type: string; data: unknown }, options: { trigger?: boolean; ifBusy?: string }) => {
      expect(options).toMatchObject({ trigger: false, ifBusy: "join" });
      if (message.type === "ishiki.tools.catalog") catalogs.push(message.data as SentCatalog);
      return undefined;
    },
    storage: { append: async (...entries: unknown[]) => void appended.push(...entries) },
  } as unknown as Agent;
  return { agent, catalogs, appended };
}

function makeState(config: { maxResults?: number; catalogMode?: "incremental" | "replace"; fullSnapshotEvery?: number; knownIndex?: boolean } = {}) {
  const state = new ToolsearchState({
    enable: true,
    resident: [],
    maxResults: config.maxResults ?? 5,
    catalogMode: config.catalogMode,
    fullSnapshotEvery: config.fullSnapshotEvery,
    knownIndex: config.knownIndex,
  });
  const { agent, catalogs, appended } = makeAgent();
  state.bind(agent);
  state.codemodeEnabled = false;
  state.refresh({ ...makeTools(), [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") }, new Set(state.residentNames()), new Set());
  return { state, catalogs, appended };
}

describe("ToolsearchState", () => {
  it("hides deferred tools and keeps the resident floor visible", () => {
    const { state } = makeState();
    const visible = state.visibleTools();
    expect(visible).toContain("finish");
    expect(visible).toContain("send_message");
    expect(visible).toContain("read");
    expect(visible).toContain(SEARCH_TOOL);
    expect(visible).not.toContain("weather_forecast");
    expect(visible).not.toContain("gmail_list_messages");
  });

  it("searches by keyword, ranks, and caps at maxResults", () => {
    const { state } = makeState({ maxResults: 2 });
    const weather = state.search("weather forecast city");
    expect(weather.tools).toHaveLength(1);
    expect(weather.tools[0]).toMatchObject({ name: "weather_forecast", description: expect.any(String) });

    const gmail = state.search("gmail");
    expect(gmail.tools).toHaveLength(2);
    expect(gmail.tools.map((match) => match.name).sort()).toEqual(["gmail_get_message", "gmail_list_messages"]);
  });

  it("truncates match descriptions to a one-line 60-char hint", () => {
    const { state } = makeState();
    const long =
      "Retrieve the complete attachment listing for a message, including inline media references, sizes and read provenance. Details stay in the catalog.";
    state.refresh(
      {
        [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword."),
        attachment_list: makeTool("attachment_list", long),
        note_search: makeTool("note_search", "Find notes.\n\nListing behavior matches attachment_list."),
      },
      new Set(state.residentNames()),
      new Set(),
    );

    // Only the first line survives multiline descriptions.
    const notes = state.search("note");
    expect(notes.tools[0]!.name).toBe("note_search");
    expect(notes.tools[0]!.description).toBe("Find notes.");

    const out = state.search("attachment");
    expect(out.tools[0]!.name).toBe("attachment_list");
    expect(out.tools[0]!.description).toBe(`${long.slice(0, 60)}…`);
  });

  it("accumulates discovery across searches and reports no matches twice", () => {
    const { state } = makeState();
    state.search("weather");
    expect(state.visibleTools()).toContain("weather_forecast");
    const again = state.search("weather_forecast");
    // Already discovered: the candidate pool shrank, so the same query finds nothing new.
    expect(again.tools).toHaveLength(0);
  });

  it("emits nothing for a no-hit search, and only after flushCatalog", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog(); // baseline roster consumed
    expect(catalogs).toHaveLength(1);
    state.search("zzz-nothing-matches");
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
    state.search("weather");
    expect(catalogs).toHaveLength(1);
    state.flushCatalog();
    expect(catalogs).toHaveLength(2);
    expect(catalogs[1]!.tools).toContain("weather_forecast");
  });

  it("coalesces parallel searches within one step into a single catalog", () => {
    const { state, catalogs } = makeState({ maxResults: 5 });
    // Two searches run in parallel inside one step (the model calling search
    // twice in one response): both mutate discovery before the flush.
    const first = state.search("gmail messages inbox");
    const second = state.search("create calendar event");
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
    const union = [...first.tools.map((match) => match.name), ...second.tools.map((match) => match.name)];
    expect(catalogs[0]!.tools).toEqual(expect.arrayContaining(union));
    // An unchanged visible set does not re-emit on the next step boundary.
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
  });

  it("emits nothing when toolsearch is disabled", () => {
    const state = new ToolsearchState({ enable: false, resident: [], maxResults: 5 });
    const { agent, catalogs } = makeAgent();
    state.bind(agent);
    state.flushCatalog();
    expect(catalogs).toHaveLength(0);
  });

  it("flushes a baseline catalog before any search ran", () => {
    const { state, catalogs } = makeState();
    // First flush always emits: the model gets a baseline roster (and, in
    // codemode mode, the resident-host signatures) before it ever searches.
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]!.tools).toEqual(expect.arrayContaining(["finish", "send_message", "read", SEARCH_TOOL]));
    expect(catalogs[0]!.tools).not.toContain("weather_forecast");
    // Baseline is not re-emitted on subsequent steps.
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
  });

  it("persists the baseline catalog once via ensureBaselineCatalog and suppresses the duplicate flush", async () => {
    const { state, catalogs, appended } = makeState();
    await state.ensureBaselineCatalog();
    const persisted = appended as Array<{ type: string; data: { type: string; data: { tools: string[] } } }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.data.type).toBe("ishiki.tools.catalog");
    expect(persisted[0]!.data.data.tools).toEqual(expect.arrayContaining(["finish", "send_message", "read", SEARCH_TOOL]));

    // Second call is a no-op: the baseline exists once in history.
    await state.ensureBaselineCatalog();
    expect((appended as unknown[]).length).toBe(1);

    // The flush key was synced by the baseline, so no duplicate joins at the step boundary.
    state.flushCatalog();
    expect((appended as unknown[]).length).toBe(1);

    // A real discovery change still flushes — via the step-boundary join.
    state.search("weather");
    state.flushCatalog();
    expect((appended as unknown[]).length).toBe(1);
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]!.tools).toContain("weather_forecast");
  });

  it("renders the direct-calling catalog without tools.x() call examples", () => {
    const { state, catalogs } = makeState();
    state.search("weather");
    state.flushCatalog();
    const text = catalogs[0]!.text;
    expect(text).toContain("Tool catalog update.");
    expect(text).toContain("weather_forecast");
    expect(text).not.toContain("tools.");
  });

  it("renders the code-mode catalog with SDK shape, sandbox hosts only", () => {
    const { state, catalogs } = makeState();
    state.codemodeEnabled = true;
    state.refresh(
      { ...makeTools(), [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") },
      new Set(state.residentNames()),
      new Set(["weather_forecast", "gmail_list_messages", "gmail_get_message", "calendar_create_event"]),
    );
    state.search("calendar event create");
    state.flushCatalog();
    const last = catalogs.at(-1)!;
    expect(last.text).toContain("Code mode capability update.");
    // Signatures come from the type block; the redundant call-examples block is gone.
    expect(last.text).toContain("calendar_create_event: (input:");
    expect(last.text).not.toContain("Tool call examples:");
    expect(last.tools).toContain("send_message");
    expect(last.text).not.toContain("send_message");
  });

  it("drops vanished tools from the visible set on registry refresh", () => {
    const { state } = makeState();
    state.search("weather");
    expect(state.visibleTools()).toContain("weather_forecast");
    const tools = makeTools();
    delete tools.weather_forecast;
    state.refresh({ ...tools, [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") }, new Set(state.residentNames()), new Set());
    expect(state.visibleTools()).not.toContain("weather_forecast");
  });

  it("never offers resident tools as search candidates", async () => {
    const { state } = makeState();
    const searchTool = createSearchTool(state);
    const out = (await searchTool.execute!({ query: "finish turn" }, { toolCallId: "t1", messages: [] } as never)) as {
      tools: unknown[];
    };
    expect(out.tools).toEqual([]);
  });

  it("emits incremental updates after the baseline", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]!.text).toContain("(full snapshot v1)");

    state.search("weather");
    state.flushCatalog();
    expect(catalogs).toHaveLength(2);
    const update = catalogs[1]!;
    expect(update.text).toContain("(incremental v2)");
    expect(update.text).toContain("weather_forecast: (input:");
    expect(update.text).toContain("Known tools:");
    expect(update.text).not.toContain("gmail_list_messages: (input:");
  });

  it("does not repeat known declarations in later updates", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();
    state.search("gmail");
    state.flushCatalog();

    expect(catalogs).toHaveLength(3);
    const update = catalogs[2]!;
    expect(update.text).toContain("gmail_list_messages: (input:");
    expect(update.text).not.toContain("weather_forecast: (input:");
    expect(update.text).toContain("Known tools:");
    expect(update.text).toContain("weather_forecast");
  });

  it("omits the known list when knownIndex is false", () => {
    const { state, catalogs } = makeState({ knownIndex: false });
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();

    expect(catalogs[1]!.text).toContain("(incremental v2)");
    expect(catalogs[1]!.text).not.toContain("Known tools:");
  });

  it("emits incremental code-mode catalogs with host-only known tools", () => {
    const { state, catalogs } = makeState();
    state.codemodeEnabled = true;
    state.refresh(
      { ...makeTools(), [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") },
      new Set(state.residentNames()),
      new Set(["weather_forecast", "gmail_list_messages", "gmail_get_message", "calendar_create_event"]),
    );
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();

    const update = catalogs.at(-1)!;
    expect(update.text).toContain("(incremental v2)");
    expect(update.text).toContain("weather_forecast: (input:");
    expect(update.text).toContain("Known tools:");
    expect(update.text).not.toContain("send_message");
  });

  it("emits a removal when a visible tool disappears", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();

    const tools = makeTools();
    delete tools.weather_forecast;
    state.refresh({ ...tools, [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") }, new Set(state.residentNames()), new Set());
    state.flushCatalog();

    const update = catalogs.at(-1)!;
    expect(update.text).toContain("(incremental");
    expect(update.text).toContain("Removed: weather_forecast");
    expect(update.text).not.toContain("weather_forecast: (input:");
    expect(update.tools).not.toContain("weather_forecast");
  });

  it("emits a changed declaration when the tool schema changes", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();

    const tools = makeTools();
    tools.weather_forecast = makeTool("weather_forecast", "Get the updated weather forecast.", { city: { type: "string" } });
    state.refresh({ ...tools, [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") }, new Set(state.residentNames()), new Set());
    state.flushCatalog();

    const update = catalogs.at(-1)!;
    expect(update.text).toContain("(incremental");
    expect(update.text).toContain("weather_forecast: (input:");
    expect(update.text).toContain("Get the updated weather forecast.");
  });

  it("re-sends full snapshots in replace mode", () => {
    const { state, catalogs } = makeState({ catalogMode: "replace" });
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();
    expect(catalogs.at(-1)!.text).toContain("(full snapshot v2)");
    expect(catalogs.at(-1)!.text).toContain("finish: (input:");

    state.search("gmail");
    state.flushCatalog();
    const update = catalogs.at(-1)!;
    expect(update.text).toContain("(full snapshot v3)");
    expect(update.text).toContain("weather_forecast: (input:");
    expect(update.text).toContain("gmail_list_messages: (input:");
  });

  it("re-sends a full snapshot after the configured incremental update count", () => {
    const { state, catalogs } = makeState({ fullSnapshotEvery: 2 });
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();
    state.search("gmail");
    state.flushCatalog();
    state.search("calendar");
    state.flushCatalog();

    expect(catalogs.at(-1)!.text).toContain("(full snapshot v4)");
  });

  it("forces a full snapshot when prepared history lost a catalog version", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();
    expect(catalogs.at(-1)!.text).toContain("(incremental v2)");

    state.observeEntries([] as never);
    state.flushCatalog();
    expect(catalogs.at(-1)!.text).toContain("(full snapshot v3)");
  });

  it("repairs catalog loss with an immediate full snapshot entry", () => {
    const { state, catalogs } = makeState();
    state.flushCatalog();
    state.search("weather");
    state.flushCatalog();
    state.observeEntries([] as never);

    const repair = state.repairCatalog();
    expect(repair).toBeDefined();
    state.flushCatalog();
    expect(catalogs).toHaveLength(2);
  });

  it("keeps only the latest catalog entry in replace mode", () => {
    const { state } = makeState({ catalogMode: "replace" });
    const latestCatalog = { type: "message", data: { role: "custom", type: "ishiki.tools.catalog", data: { version: 2 } } };
    const entries = [
      { type: "message", data: { role: "custom", type: "ishiki.tools.catalog", data: { version: 1 } } },
      { type: "message", data: { role: "user", content: "hi" } },
      latestCatalog,
    ] as never;
    const filtered = state.filterEntries(entries);
    expect(filtered).toHaveLength(2);
    expect(filtered).toContain(latestCatalog);
  });
});

describe("tool catalog renderer", () => {
  it("shares repeated output types through a stable alias", () => {
    const outputSchema = jsonSchema({
      type: "array",
      items: {
        anyOf: [
          { type: "object", properties: { type: { const: "text" }, text: { type: "string" } }, required: ["type", "text"] },
          {
            type: "object",
            properties: { type: { enum: ["image", "audio"] }, data: { type: "string" }, mimeType: { type: "string" } },
            required: ["type", "data"],
          },
          {
            type: "object",
            properties: {
              type: { const: "resource" },
              resource: {
                type: "object",
                properties: { uri: { type: "string" }, mimeType: { type: "string" }, text: { type: "string" }, blob: { type: "string" } },
                required: ["uri"],
              },
            },
            required: ["type", "resource"],
          },
          {
            type: "object",
            properties: { type: { const: "resource_link" }, uri: { type: "string" }, name: { type: "string" }, mimeType: { type: "string" } },
            required: ["type", "uri"],
          },
          { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
        ],
      },
    });
    const makeBlockTool = (name: string) =>
      tool({
        description: name,
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        outputSchema,
        execute: async () => [],
      });

    const { text, aliases } = buildCodeModeToolCatalogMessage({ first: makeBlockTool("first"), second: makeBlockTool("second") });
    expect(aliases.size).toBe(1);
    const alias = [...aliases.keys()][0]!;
    expect(text).toContain(`type ${alias} =`);
    expect(text.match(new RegExp(`Promise<${alias}>`, "g"))).toHaveLength(2);
    expect(text.match(/type ToolResult_/g)).toHaveLength(1);
  });
});

describe("AgentRuntime baseline catalog", () => {
  const homes: string[] = [];

  interface MessageData {
    role?: string;
    type?: string;
    data?: { type?: string; text?: string };
  }

  function makeRuntime(config: Partial<AgentRuntimeConfig> = {}): AgentRuntime {
    const home = mkdtempSync(path.join(tmpdir(), "ishiki-runtime-"));
    homes.push(home);
    return new AgentRuntime({
      id: "test",
      home,
      // No turn runs in these tests: init and non-trigger sends never touch the model,
      // and the standard engine only wakes on committed created facts.
      model: {} as LanguageModelV4,
      instructions: "system prompt",
      tools: {},
      extensions: [],
      context: {} as AgentRuntimeConfig["context"],
      wakeup: new StandardWakeupInstance(),
      codemode: { enable: false, direct: [], timeoutMs: 1000 },
      toolsearch: { enable: true, resident: [], maxResults: 5 },
      debugStream: false,
      logger: {} as Logger,
      resources: new ResourceCenter("test", home),
      attachment: { imageInput: false },
      ...config,
    });
  }

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("persists the baseline catalog during init, before any user message lands", async () => {
    const runtime = makeRuntime();
    await runtime.agent.init();

    // Non-trigger send mirrors the joined-message persist path: init first, then the user message.
    runtime.agent.send(createUserMessage("hello"), { trigger: false });
    await vi.waitFor(async () => {
      const entries = await runtime.storage.read();
      expect(entries.some((entry) => (entry.data as MessageData).role === "user")).toBe(true);
    });

    const messages = (await runtime.storage.read()).filter((entry) => entry.type === "message");
    const kinds = messages.map((entry) => {
      const data = entry.data as MessageData;
      return data.type === "ishiki.tools.catalog" ? "catalog" : data.role;
    });
    // Every request's catalog slot is decided by storage: [catalog, user...], first request included.
    expect(kinds).toEqual(["catalog", "user"]);

    const catalog = messages[0]!.data as MessageData;
    expect(catalog.type).toBe("ishiki.tools.catalog");
    expect(catalog.data!.text).toContain("Tool catalog update.");
  });

  it("appends nothing when toolsearch is disabled", async () => {
    const runtime = makeRuntime({ toolsearch: { enable: false, resident: [], maxResults: 5 } });
    await runtime.agent.init();
    runtime.agent.send(createUserMessage("hello"), { trigger: false });
    await vi.waitFor(async () => {
      const entries = await runtime.storage.read();
      expect(entries.some((entry) => (entry.data as MessageData).role === "user")).toBe(true);
    });
    const messages = (await runtime.storage.read()).filter((entry) => entry.type === "message");
    expect(messages.map((entry) => (entry.data as MessageData).role)).toEqual(["user"]);
  });
});
