import { describe, expect, it } from "vitest";

import { EngineConfigSchema, InstanceConfig, PluginConfig } from "../src/config.js";

describe("config schemas", () => {
  it("fills plugin defaults", () => {
    expect(PluginConfig({})).toMatchObject({
      logLevel: 2,
      engines: [],
      defaultLimit: 5,
      maxLimit: 20,
      timeoutMs: 60_000,
      maxFetchUrls: 5,
      maxContentChars: 20_000,
      maxSnippetChars: 1_000,
      maxAnswerChars: 8_000,
      blacklist: [],
    });
  });

  it("fills instance mode", () => {
    expect(InstanceConfig({})).toEqual({ mode: "auto" });
  });

  it("fills backend defaults from the discriminated union", () => {
    expect(EngineConfigSchema({ id: "local", backend: "searxng", endpoint: "https://searx.be" })).toMatchObject({
      id: "local",
      backend: "searxng",
      enabled: true,
      timeoutMs: 0,
      apiKey: "",
      categories: ["general"],
      language: "all",
      safesearch: 1,
    });
    expect(EngineConfigSchema({ id: "t", backend: "tavily", apiKey: "key" })).toMatchObject({
      endpoint: "https://api.tavily.com",
      searchDepth: "basic",
      includeAnswer: false,
    });
    expect(EngineConfigSchema({ id: "c", backend: "anthropic", apiKey: "key" })).toMatchObject({
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-6",
      maxUses: 3,
      maxTokens: 2048,
      maxContentTokens: 50_000,
      allowedDomains: [],
      blockedDomains: [],
    });
    expect(EngineConfigSchema({ id: "o", backend: "openai", apiKey: "key" })).toMatchObject({
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5",
      searchContextSize: "medium",
      maxOutputTokens: 2048,
      allowedDomains: [],
      blockedDomains: [],
    });
  });
});
