import { afterEach, describe, expect, it } from "vitest";

import { createAnthropicEngine } from "../src/engines/anthropic.js";
import { createBraveEngine } from "../src/engines/brave.js";
import { createDeepseekEngine } from "../src/engines/deepseek.js";
import { createExaEngine } from "../src/engines/exa.js";
import { createFirecrawlEngine } from "../src/engines/firecrawl.js";
import { createOpenaiEngine } from "../src/engines/openai.js";
import { createSearxngEngine } from "../src/engines/searxng.js";
import { createTavilyEngine } from "../src/engines/tavily.js";
import { startFixture, type Fixture } from "./fixture.js";

const base = { id: "main", enabled: true, timeoutMs: 5000 };
let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("search engine adapters", () => {
  it("maps Tavily search and extract responses", async () => {
    fixture = await startFixture({
      "/search": () => ({
        body: {
          answer: "Tavily answer",
          results: [{ title: "Tavily hit", url: "https://tavily.test/page/", content: "Tavily snippet", published_date: "2026-01-02" }],
        },
      }),
      "/extract": () => ({ body: { results: [{ url: "https://tavily.test/page", raw_content: "# Tavily body" }] } }),
    });
    const engine = createTavilyEngine(
      {
        ...base,
        backend: "tavily",
        apiKey: "tavily-key",
        endpoint: fixture.url,
        searchDepth: "advanced",
        includeAnswer: true,
      },
      1000,
    );

    const result = await engine.search!({ query: "ishiki", limit: 4 });
    expect(result.results).toEqual([{ title: "Tavily hit", url: "https://tavily.test/page/", snippet: "Tavily snippet", publishedAt: "2026-01-02" }]);
    expect(result.answers).toEqual(["Tavily answer"]);
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      path: "/search",
      headers: { authorization: "Bearer tavily-key" },
      json: { query: "ishiki", search_depth: "advanced", max_results: 4, include_answer: true },
    });

    const page = await engine.fetchPage!("https://tavily.test/page");
    expect(page).toEqual({ title: "https://tavily.test/page", content: "# Tavily body" });
  });

  it("maps Brave web results and query parameters", async () => {
    fixture = await startFixture({
      "/web/search": () => ({
        body: {
          web: {
            results: [
              {
                title: "Brave hit",
                url: "https://brave.test/page",
                description: "Brave snippet",
                page_age: "2026-02-03",
                extra_snippets: ["Extra snippet"],
              },
            ],
          },
        },
      }),
    });
    const engine = createBraveEngine(
      {
        ...base,
        backend: "brave",
        apiKey: "brave-key",
        endpoint: fixture.url,
        country: "US",
        searchLang: "en",
        safesearch: "strict",
        extraSnippets: true,
      },
      1000,
    );

    const result = await engine.search!({ query: "agents", limit: 2 });
    expect(result.results).toEqual([
      { title: "Brave hit", url: "https://brave.test/page", snippet: "Brave snippet\nExtra snippet", publishedAt: "2026-02-03" },
    ]);
    const request = fixture.requests[0];
    expect(request.path).toBe("/web/search");
    expect(request.headers["x-subscription-token"]).toBe("brave-key");
    expect(request.query.get("q")).toBe("agents");
    expect(request.query.get("count")).toBe("2");
    expect(request.query.get("country")).toBe("US");
    expect(request.query.get("search_lang")).toBe("en");
    expect(request.query.get("safesearch")).toBe("strict");
    expect(request.query.get("extra_snippets")).toBe("true");
    expect(request.query.get("text_decorations")).toBe("false");
  });

  it("maps Exa search and contents responses", async () => {
    fixture = await startFixture({
      "/search": () => ({
        body: { results: [{ title: "Exa hit", url: "https://exa.test/page", text: "Exa snippet", publishedDate: "2026-03-04" }] },
      }),
      "/contents": () => ({
        body: {
          results: [{ id: "https://exa.test/page", title: "Exa page", url: "https://exa.test/page", text: "Exa body" }],
          statuses: [{ id: "https://exa.test/page", status: "success" }],
        },
      }),
    });
    const engine = createExaEngine({ ...base, backend: "exa", apiKey: "exa-key", endpoint: fixture.url, type: "deep" }, 1000);

    const result = await engine.search!({ query: "neural search", limit: 3 });
    expect(result.results).toEqual([{ title: "Exa hit", url: "https://exa.test/page", snippet: "Exa snippet", publishedAt: "2026-03-04" }]);
    expect(fixture.requests[0].json).toMatchObject({
      query: "neural search",
      type: "deep",
      numResults: 3,
      contents: { text: { maxCharacters: 2000 } },
    });

    const page = await engine.fetchPage!("https://exa.test/page");
    expect(page).toEqual({ title: "Exa page", content: "Exa body" });
    expect(fixture.requests[1].json).toMatchObject({ ids: ["https://exa.test/page"] });
  });

  it("maps Firecrawl search and scrape responses", async () => {
    fixture = await startFixture({
      "/search": () => ({
        body: { success: true, data: { web: [{ title: "Firecrawl hit", url: "https://firecrawl.test/page", description: "Firecrawl snippet" }] } },
      }),
      "/scrape": () => ({
        body: { success: true, data: { markdown: "# Firecrawl body", metadata: { title: "Firecrawl page" } } },
      }),
    });
    const engine = createFirecrawlEngine({ ...base, backend: "firecrawl", apiKey: "firecrawl-key", endpoint: fixture.url }, 1000);

    const result = await engine.search!({ query: "crawler", limit: 5 });
    expect(result.results).toEqual([{ title: "Firecrawl hit", url: "https://firecrawl.test/page", snippet: "Firecrawl snippet" }]);
    expect(fixture.requests[0].json).toEqual({ query: "crawler", limit: 5, sources: ["web"] });

    const page = await engine.fetchPage!("https://firecrawl.test/page");
    expect(page).toEqual({ title: "Firecrawl page", content: "# Firecrawl body" });
    expect(fixture.requests[1].json).toMatchObject({
      url: "https://firecrawl.test/page",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  it("maps SearXNG JSON responses and honors the limit", async () => {
    fixture = await startFixture({
      "/search": () => ({
        body: {
          results: [
            { title: "SearXNG one", url: "https://searx.test/one", content: "One", publishedDate: "2026-04-05" },
            { title: "SearXNG two", url: "https://searx.test/two", content: "Two" },
          ],
        },
      }),
    });
    const engine = createSearxngEngine(
      {
        ...base,
        backend: "searxng",
        endpoint: fixture.url,
        apiKey: "searx-key",
        categories: ["general", "news"],
        language: "zh-CN",
        safesearch: 2,
      },
      1000,
    );

    const result = await engine.search!({ query: "本地搜索", limit: 1 });
    expect(result.results).toEqual([{ title: "SearXNG one", url: "https://searx.test/one", snippet: "One", publishedAt: "2026-04-05" }]);
    const request = fixture.requests[0];
    expect(request.query.get("format")).toBe("json");
    expect(request.query.get("categories")).toBe("general,news");
    expect(request.query.get("language")).toBe("zh-CN");
    expect(request.query.get("safesearch")).toBe("2");
    expect(request.headers.authorization).toBe("Bearer searx-key");
  });

  it("maps DeepSeek native search and fetch responses", async () => {
    fixture = await startFixture({
      "/v1/tools/search": () => ({
        body: {
          results: [
            {
              title: "DeepSeek hit",
              url: "https://deepseek.test/page",
              snippet: "Short",
              summary: "Summary",
              content: "",
              date: "2026-05-06",
            },
          ],
        },
      }),
      "/v1/tools/fetch": () => ({ body: { title: "DeepSeek page", content: "DeepSeek body" } }),
    });
    const engine = createDeepseekEngine({ ...base, backend: "deepseek", apiKey: "deepseek-key", endpoint: fixture.url, needContent: true }, 1000);

    const result = await engine.search!({ query: "deepseek", limit: 6 });
    expect(result.results).toEqual([{ title: "DeepSeek hit", url: "https://deepseek.test/page", snippet: "Summary", publishedAt: "2026-05-06" }]);
    expect(fixture.requests[0].json).toEqual({ query: "deepseek", count: 6, need_content: true });

    const page = await engine.fetchPage!("https://deepseek.test/page");
    expect(page).toEqual({ title: "DeepSeek page", content: "DeepSeek body" });
  });

  it("maps Anthropic web search citations and web fetch documents", async () => {
    fixture = await startFixture({
      "/v1/messages": (request) => {
        const body = request.json as { tools: Array<{ type: string }> };
        if (body.tools[0].type.startsWith("web_search")) {
          return {
            body: {
              id: "msg_search",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
              content: [
                {
                  type: "text",
                  text: "Claude answer",
                  citations: [
                    {
                      type: "web_search_result_location",
                      url: "https://claude.test/a",
                      title: "Claude A",
                      cited_text: "Quoted",
                      encrypted_index: "index",
                    },
                  ],
                },
                { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: { query: "claude" } },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu_search",
                  content: [
                    {
                      type: "web_search_result",
                      url: "https://claude.test/b",
                      title: "Claude B",
                      page_age: "2026-06-07",
                      encrypted_content: "encrypted",
                    },
                  ],
                },
              ],
            },
          };
        }
        return {
          body: {
            id: "msg_fetch",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "server_tool_use", id: "srvtoolu_fetch", name: "web_fetch", input: { url: "https://claude.test/a" } },
              {
                type: "web_fetch_tool_result",
                tool_use_id: "srvtoolu_fetch",
                content: {
                  type: "web_fetch_result",
                  url: "https://claude.test/a",
                  retrieved_at: "2026-06-08T00:00:00Z",
                  content: {
                    type: "document",
                    title: "Claude page",
                    source: { type: "text", media_type: "text/plain", data: "Claude body" },
                  },
                },
              },
            ],
          },
        };
      },
    });
    const engine = createAnthropicEngine(
      {
        ...base,
        backend: "anthropic",
        apiKey: "claude-key",
        endpoint: `${fixture.url}/v1`,
        model: "claude-sonnet-4-6",
        maxUses: 4,
        maxTokens: 2048,
        maxContentTokens: 50_000,
        allowedDomains: ["claude.test"],
        blockedDomains: [],
      },
      1000,
    );

    const result = await engine.search!({ query: "claude", limit: 5 });
    expect(result.results).toEqual([
      { title: "Claude A", url: "https://claude.test/a", snippet: "Quoted" },
      { title: "Claude B", url: "https://claude.test/b", snippet: "", publishedAt: "2026-06-07" },
    ]);
    expect(result.answers).toEqual(["Claude answer"]);
    const request = fixture.requests[0];
    expect(request.headers["x-api-key"]).toBe("claude-key");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.json).toMatchObject({
      model: "claude-sonnet-4-6",
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 4, allowed_domains: ["claude.test"] }],
    });

    const page = await engine.fetchPage!("https://claude.test/a");
    expect(page).toEqual({ title: "Claude page", content: "Claude body" });
    expect(fixture.requests[1].json).toMatchObject({
      tools: [{ type: "web_fetch_20260318", name: "web_fetch", max_content_tokens: 50_000 }],
    });
  });

  it("maps OpenAI web search calls and URL citations", async () => {
    fixture = await startFixture({
      "/v1/responses": () => ({
        body: {
          id: "resp_1",
          object: "response",
          created_at: 1_780_000_000,
          status: "completed",
          model: "gpt-5",
          output: [
            {
              type: "web_search_call",
              id: "ws_1",
              status: "completed",
              action: { type: "search", query: "openai", sources: [{ type: "url", url: "https://openai.test/a" }] },
            },
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Hello world",
                  annotations: [{ type: "url_citation", url: "https://openai.test/b", title: "OpenAI B", start_index: 0, end_index: 5 }],
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      }),
    });
    const engine = createOpenaiEngine(
      {
        ...base,
        backend: "openai",
        apiKey: "openai-key",
        endpoint: `${fixture.url}/v1`,
        model: "gpt-5",
        searchContextSize: "high",
        maxOutputTokens: 2048,
        allowedDomains: [],
        blockedDomains: ["skip.test"],
      },
      1000,
    );

    const result = await engine.search!({ query: "openai", limit: 5 });
    expect(result.results).toEqual([
      { title: "https://openai.test/a", url: "https://openai.test/a", snippet: "" },
      { title: "OpenAI B", url: "https://openai.test/b", snippet: "" },
    ]);
    expect(result.answers).toEqual(["Hello world"]);
    expect(fixture.requests[0].json).toMatchObject({
      model: "gpt-5",
      tools: [{ type: "web_search", search_context_size: "high", filters: { blocked_domains: ["skip.test"] } }],
      tool_choice: { type: "web_search" },
      include: ["web_search_call.action.sources"],
    });
  });
});
