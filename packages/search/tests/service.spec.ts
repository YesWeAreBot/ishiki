import { afterEach, describe, expect, it } from "vitest";

import { SearchService } from "../src/service.js";
import { searchInstructions } from "../src/tools.js";
import { createSearchTools } from "../src/tools.js";
import type { EngineConfig, SearchConfig, SearchOutput } from "../src/types.js";
import { normalizeUrls } from "../src/utils.js";
import { startFixture, type Fixture } from "./fixture.js";

const searx = (id: string, endpoint: string, overrides: Partial<EngineConfig> = {}): EngineConfig =>
  ({
    id,
    enabled: true,
    timeoutMs: 1000,
    backend: "searxng",
    endpoint,
    apiKey: "",
    categories: ["general"],
    language: "all",
    safesearch: 1,
    ...overrides,
  }) as EngineConfig;

const tavily = (id: string, endpoint: string): EngineConfig => ({
  id,
  enabled: true,
  timeoutMs: 1000,
  backend: "tavily",
  endpoint,
  apiKey: "key",
  searchDepth: "basic",
  includeAnswer: false,
});

const config = (engines: EngineConfig[], overrides: Partial<SearchConfig> = {}): SearchConfig => ({
  engines,
  defaultLimit: 5,
  maxLimit: 10,
  timeoutMs: 1000,
  maxFetchUrls: 3,
  maxContentChars: 100,
  maxSnippetChars: 50,
  maxAnswerChars: 100,
  blacklist: [],
  ...overrides,
});

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("SearchService", () => {
  it("falls through an auto engine that fails", async () => {
    fixture = await startFixture({
      "/a/search": () => ({ status: 500, body: { error: "engine down" } }),
      "/b/search": () => ({ body: { results: [{ title: "B hit", url: "https://b.test/page", content: "B snippet" }] } }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`), searx("b", `${fixture.url}/b`)]));

    const output = await service.search("auto", "query", 5);
    expect(output.results).toEqual([{ title: "B hit", url: "https://b.test/page", snippet: "B snippet" }]);
    expect(output.errors).toEqual([expect.stringContaining("a: ")]);
    expect(output.errors?.[0]).toContain("HTTP 500");
  });

  it("continues an auto chain when an engine returns no results", async () => {
    fixture = await startFixture({
      "/a/search": () => ({ body: { results: [] } }),
      "/b/search": () => ({ body: { results: [{ title: "B hit", url: "https://b.test/page", content: "" }] } }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`), searx("b", `${fixture.url}/b`)]));

    const output = await service.search("auto", "query", 5);
    expect(output.results.map((result) => result.url)).toEqual(["https://b.test/page"]);
    expect(output.errors).toBeUndefined();
  });

  it("merges and deduplicates parallel results", async () => {
    fixture = await startFixture({
      "/a/search": () => ({
        body: {
          results: [
            { title: "Shared A", url: "https://shared.test/page/", content: "first snippet" },
            { title: "Only A", url: "https://only-a.test/", content: "A" },
          ],
        },
      }),
      "/b/search": () => ({
        body: {
          results: [
            { title: "Shared B", url: "https://shared.test/page#section", content: "" },
            { title: "Only B", url: "https://only-b.test/", content: "B" },
          ],
        },
      }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`), searx("b", `${fixture.url}/b`)]));

    const output = await service.search("parallel", "query", 10);
    expect(output.results).toHaveLength(3);
    const shared = output.results.find((result) => result.url === "https://shared.test/page");
    expect(shared).toMatchObject({ title: "Shared A", snippet: "first snippet" });
  });

  it("queries only the selected engine", async () => {
    fixture = await startFixture({
      "/a/search": () => ({ body: { results: [{ title: "A", url: "https://a.test/", content: "" }] } }),
      "/b/search": () => ({ body: { results: [{ title: "B", url: "https://b.test/", content: "" }] } }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`), searx("b", `${fixture.url}/b`)]));

    const output = await service.search("a", "query", 5);
    expect(output.results.map((result) => result.url)).toEqual(["https://a.test/"]);
    expect(fixture.requests.map((request) => request.path)).toEqual(["/a/search"]);
  });

  it("filters blacklisted URLs and truncates snippets", async () => {
    fixture = await startFixture({
      "/a/search": () => ({
        body: {
          results: [
            { title: "Blocked", url: "https://blocked.test/page", content: "secret" },
            { title: "Allowed", url: "https://allowed.test/page", content: "x".repeat(100) },
          ],
        },
      }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`)], { blacklist: ["blocked\\.test"], maxSnippetChars: 20 }));

    const output = await service.search("a", "query", 5);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({ url: "https://allowed.test/page", snippet: `${"x".repeat(19)}…` });
  });

  it("continues auto search when every hit is blacklisted", async () => {
    fixture = await startFixture({
      "/a/search": () => ({ body: { results: [{ title: "Blocked", url: "https://blocked.test/page", content: "secret" }] } }),
      "/b/search": () => ({ body: { results: [{ title: "Allowed", url: "https://allowed.test/page", content: "public" }] } }),
    });
    const service = new SearchService(config([searx("a", `${fixture.url}/a`), searx("b", `${fixture.url}/b`)], { blacklist: ["blocked\\.test"] }));

    const output = await service.search("auto", "query", 5);
    expect(output.results).toEqual([{ title: "Allowed", url: "https://allowed.test/page", snippet: "public" }]);
  });

  it("falls through failed fetch engines and truncates content", async () => {
    fixture = await startFixture({
      "/a/extract": () => ({ status: 502, body: { error: "down" } }),
      "/b/extract": () => ({
        body: { results: [{ url: "https://page.test/x", raw_content: "y".repeat(200) }] },
      }),
    });
    const service = new SearchService(config([tavily("a", `${fixture.url}/a`), tavily("b", `${fixture.url}/b`)], { maxContentChars: 30 }));

    const output = await service.fetch("auto", ["https://page.test/x"]);
    expect(output.results[0]).toMatchObject({
      url: "https://page.test/x",
      content: `${"y".repeat(29)}…`,
    });
  });

  it("races fetch engines in parallel mode", async () => {
    fixture = await startFixture({
      "/a/extract": () => ({ body: { results: [{ url: "https://page.test/x", raw_content: "A body" }] } }),
      "/b/extract": () => ({ status: 500, body: { error: "down" } }),
    });
    const service = new SearchService(config([tavily("a", `${fixture.url}/a`), tavily("b", `${fixture.url}/b`)]));

    const output = await service.fetch("parallel", ["https://page.test/x"]);
    expect(output.results[0]).toMatchObject({ content: "A body" });
  });

  it("rejects blacklisted fetch URLs without a request", async () => {
    fixture = await startFixture({});
    const service = new SearchService(config([tavily("a", fixture.url)], { blacklist: ["blocked\\.test"] }));

    const output = await service.fetch("a", ["https://blocked.test/x"]);
    expect(output.results[0].error).toMatch(/blacklist/);
    expect(fixture.requests).toHaveLength(0);
  });

  it("rejects invalid configuration and selections", () => {
    expect(() => new SearchService(config([searx("a", "http://127.0.0.1:1"), searx("a", "http://127.0.0.1:2")]))).toThrow(/Duplicate engine id/);
    expect(() => new SearchService(config([searx("auto", "http://127.0.0.1:1")]))).toThrow(/reserved/);
    expect(() => new SearchService(config([searx("a", "http://127.0.0.1:1")], { defaultLimit: 20 }))).toThrow(/defaultLimit/);
    const service = new SearchService(config([searx("a", "http://127.0.0.1:1")]));
    expect(() => service.select("missing", "search")).toThrow(/Unknown mode/);
    expect(() => service.select("parallel", "fetch")).toThrow(/No enabled engine supports fetch/);
  });
});

describe("search tools", () => {
  it("omits web_fetch when the selection has no fetch engine", () => {
    const service = new SearchService(config([searx("local", "http://127.0.0.1:1")]));
    const tools = createSearchTools(service, "parallel");
    expect(Object.keys(tools)).toEqual(["web_search"]);
    const instructions = searchInstructions(service, "parallel");
    expect(instructions).toContain("web_search");
    expect(instructions).not.toContain("web_fetch");
    expect(instructions).not.toContain("抓取");
    expect(instructions).not.toContain("parallel");
  });

  it("exposes web_search and web_fetch with model text", async () => {
    fixture = await startFixture({
      "/search": () => ({ body: { results: [{ title: "Hit", url: "https://hit.test/page", content: "Snippet" }] } }),
      "/extract": () => ({ body: { results: [{ url: "https://hit.test/page", raw_content: "Page body" }] } }),
    });
    const service = new SearchService(config([tavily("main", fixture.url)]));
    const tools = createSearchTools(service, "parallel");
    expect(Object.keys(tools)).toEqual(["web_search", "web_fetch"]);

    const search = await tools.web_search.execute!({ query: "query" }, { toolCallId: "call-1", messages: [] });
    const searchOutput = search as SearchOutput;
    expect(searchOutput.results[0]).toMatchObject({ title: "Hit", url: "https://hit.test/page" });
    expect(searchOutput).not.toHaveProperty("mode");
    expect(searchOutput).not.toHaveProperty("engines");
    expect(searchOutput).not.toHaveProperty("query");
    expect(tools.web_search.description).not.toMatch(/mode|engine/i);
    const searchText = tools.web_search.toModelOutput!({
      toolCallId: "call-1",
      input: { query: "query" },
      output: search,
    });
    expect(searchText).toMatchObject({ type: "text", value: expect.stringContaining("https://hit.test/page") });
    expect(searchText.value).not.toMatch(/^Mode:|engines:/m);

    const fetch = await tools.web_fetch.execute!({ urls: ["https://hit.test/page"] }, { toolCallId: "call-2", messages: [] });
    expect(tools.web_fetch.description).not.toMatch(/mode|engine/i);
    const fetchText = tools.web_fetch.toModelOutput!({
      toolCallId: "call-2",
      input: { urls: ["https://hit.test/page"] },
      output: fetch,
    });
    expect(fetchText).toMatchObject({ type: "text", value: expect.stringContaining("Page body") });
    expect(fetchText.value).not.toContain("Engines:");
  });
});

describe("URL normalization", () => {
  it("deduplicates canonical URLs and caps the count", () => {
    expect(normalizeUrls(["https://Example.com/a/#section", "https://example.com/a"], 3)).toEqual(["https://example.com/a"]);
    expect(() => normalizeUrls(["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4"], 3)).toThrow(/At most 3/);
  });
});
