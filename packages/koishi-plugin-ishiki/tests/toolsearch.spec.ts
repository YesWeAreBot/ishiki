import { jsonSchema, tool, type Agent, type Tool, type ToolSet } from "@yesimagent/core";
import { describe, expect, it } from "vitest";

import { SEARCH_TOOL, ToolsearchState, createSearchTool } from "../src/builtin-tools/toolsearch.js";

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
  const agent = {
    send: (message: { role: string; type: string; data: unknown }, options: { trigger?: boolean; ifBusy?: string }) => {
      expect(options).toMatchObject({ trigger: false, ifBusy: "join" });
      if (message.type === "ishiki.tools.catalog") catalogs.push(message.data as SentCatalog);
      return undefined;
    },
  } as unknown as Agent;
  return { agent, catalogs };
}

function makeState(config: { maxResults?: number } = {}) {
  const state = new ToolsearchState({ enable: true, resident: [], maxResults: config.maxResults ?? 5 });
  const { agent, catalogs } = makeAgent();
  state.bind(agent);
  state.codemodeEnabled = false;
  state.refresh({ ...makeTools(), [SEARCH_TOOL]: makeTool(SEARCH_TOOL, "Search deferred tools by keyword.") }, new Set(state.residentNames()), new Set());
  return { state, catalogs };
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

  it("accumulates discovery across searches and reports no matches twice", () => {
    const { state } = makeState();
    state.search("weather");
    expect(state.visibleTools()).toContain("weather_forecast");
    const again = state.search("weather_forecast");
    // Already discovered: the candidate pool shrank, so the same query finds nothing new.
    expect(again.tools).toHaveLength(0);
  });

  it("persists a catalog message per visible-set change and none on no-hit searches", () => {
    const { state, catalogs } = makeState();
    expect(catalogs).toHaveLength(0);
    state.search("zzz-nothing-matches");
    expect(catalogs).toHaveLength(0);
    state.search("weather");
    expect(catalogs).toHaveLength(1);
    expect(catalogs[0]!.tools).toContain("weather_forecast");
    state.search("gmail");
    expect(catalogs).toHaveLength(2);
    expect(catalogs[1]!.tools).toEqual(expect.arrayContaining(["gmail_list_messages", "gmail_get_message", "weather_forecast"]));
  });

  it("renders the direct-calling catalog without tools.x() call examples", () => {
    const { state, catalogs } = makeState();
    state.search("weather");
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
    const last = catalogs.at(-1)!;
    expect(last.text).toContain("Code mode capability update.");
    expect(last.text).toContain("tools.calendar_create_event(");
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
});
