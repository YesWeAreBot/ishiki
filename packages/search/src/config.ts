import { Logger, Schema } from "koishi";

import type { EngineConfig, SearchConfig } from "./types.js";

const EngineBase = Schema.object({
  id: Schema.string().required().description("引擎标识，同一份插件配置内必须唯一；实例配置用这个值选择单个引擎"),
  enabled: Schema.boolean().default(true).description("关闭后不参与 auto、parallel，也不能被实例配置选中"),
  backend: Schema.union([
    Schema.const("tavily").description("Tavily"),
    Schema.const("brave").description("Brave Search"),
    Schema.const("exa").description("Exa"),
    Schema.const("firecrawl").description("Firecrawl"),
    Schema.const("searxng").description("SearXNG"),
    Schema.const("deepseek").description("DeepSeek"),
    Schema.const("anthropic").description("Anthropic"),
    Schema.const("openai").description("OpenAI"),
  ])
    .default("tavily")
    .description("搜索后端类型"),
  timeoutMs: Schema.number().min(0).default(0).description("单次请求超时（毫秒）；0 表示使用插件级 timeoutMs"),
});

export const EngineConfigSchema: Schema<EngineConfig> = Schema.intersect([
  EngineBase,
  Schema.union([
    Schema.object({
      backend: Schema.const("tavily"),
      apiKey: Schema.string().role("secret").required().description("Tavily API Key"),
      endpoint: Schema.string().role("link").default("https://api.tavily.com").description("API 根地址"),
      searchDepth: Schema.union(["basic", "advanced", "fast", "ultra-fast"]).default("basic").description("Tavily 检索深度"),
      includeAnswer: Schema.boolean().default(false).description("让 Tavily 同时返回一段综合答案"),
    }),
    Schema.object({
      backend: Schema.const("brave").required(),
      apiKey: Schema.string().role("secret").required().description("Brave Search API Key"),
      endpoint: Schema.string().role("link").default("https://api.search.brave.com/res/v1").description("API 根地址"),
      country: Schema.string().default("").description("国家代码，如 CN、US；留空由 Brave 决定"),
      searchLang: Schema.string().default("").description("结果语言，如 zh-hans、en；留空由 Brave 决定"),
      safesearch: Schema.union(["off", "moderate", "strict"]).default("moderate").description("安全搜索级别"),
      extraSnippets: Schema.boolean().default(false).description("请求额外的摘要片段"),
    }),
    Schema.object({
      backend: Schema.const("exa").required(),
      apiKey: Schema.string().role("secret").required().description("Exa API Key"),
      endpoint: Schema.string().role("link").default("https://api.exa.ai").description("API 根地址"),
      type: Schema.union(["auto", "fast", "instant", "deep-lite", "deep"]).default("auto").description("Exa 检索类型"),
    }),
    Schema.object({
      backend: Schema.const("firecrawl").required(),
      apiKey: Schema.string().role("secret").required().description("Firecrawl API Key"),
      endpoint: Schema.string().role("link").default("https://api.firecrawl.dev/v2").description("API 根地址，包含版本段"),
    }),
    Schema.object({
      backend: Schema.const("searxng").required(),
      endpoint: Schema.string().role("link").required().description("SearXNG 实例根地址，如 https://searx.be"),
      apiKey: Schema.string().role("secret").default("").description("实例要求认证时填写；通常留空"),
      categories: Schema.array(Schema.string()).default(["general"]).description("检索分类"),
      language: Schema.string().default("all").description("结果语言，如 zh-CN、en；all 表示不限"),
      safesearch: Schema.union([0, 1, 2]).default(1).description("安全搜索级别：0 关闭，1 适中，2 严格"),
    }),
    Schema.object({
      backend: Schema.const("deepseek").required(),
      apiKey: Schema.string().role("secret").required().description("DeepSeek API Key"),
      endpoint: Schema.string().role("link").default("https://api.deepseek.com").description("API 根地址"),
      needContent: Schema.boolean().default(false).description("同时返回页面正文；会增加响应体积"),
    }),
    Schema.object({
      backend: Schema.const("anthropic").required(),
      apiKey: Schema.string().role("secret").required().description("Anthropic API Key"),
      endpoint: Schema.string().role("link").default("https://api.anthropic.com/v1").description("API 根地址，包含版本段"),
      model: Schema.string().default("claude-sonnet-4-6").description("支持 web_search_20260318 / web_fetch_20260318 的模型"),
      maxUses: Schema.number().min(1).default(3).description("单次请求最多搜索次数"),
      maxTokens: Schema.number().min(256).default(2048).description("综合答案的输出 token 上限"),
      maxContentTokens: Schema.number().min(1000).default(50000).description("抓取工具单页正文的 token 上限"),
      allowedDomains: Schema.array(Schema.string()).default([]).description("只允许这些域名；与 blockedDomains 不能同时填写"),
      blockedDomains: Schema.array(Schema.string()).default([]).description("排除这些域名；与 allowedDomains 不能同时填写"),
    }),
    Schema.object({
      backend: Schema.const("openai").required(),
      apiKey: Schema.string().role("secret").required().description("OpenAI API Key"),
      endpoint: Schema.string().role("link").default("https://api.openai.com/v1").description("Responses API 根地址"),
      model: Schema.string().default("gpt-5").description("支持 web_search 工具的模型"),
      searchContextSize: Schema.union(["low", "medium", "high"]).default("medium").description("搜索上下文规模"),
      maxOutputTokens: Schema.number().min(256).default(2048).description("综合答案的输出 token 上限"),
      allowedDomains: Schema.array(Schema.string()).default([]).description("只允许这些域名"),
      blockedDomains: Schema.array(Schema.string()).default([]).description("排除这些域名"),
    }),
  ]),
]) as unknown as Schema<EngineConfig>;

export interface PluginConfig extends SearchConfig {
  logLevel: number;
}

export const PluginConfig: Schema<PluginConfig> = Schema.object({
  engines: Schema.array(EngineConfigSchema).description("搜索后端列表；同一后端可以添加多份配置，用不同的 id 区分").default([]),
  defaultLimit: Schema.number().min(1).max(50).default(5).description("工具未指定 limit 时返回的结果数"),
  maxLimit: Schema.number().min(1).max(50).default(20).description("工具允许请求的最大结果数"),
  timeoutMs: Schema.number().min(1000).default(60_000).description("单次后端请求的默认超时（毫秒）"),
  maxFetchUrls: Schema.number().min(1).max(20).default(5).description("单次抓取允许的 URL 数量"),
  maxContentChars: Schema.number().min(100).max(1_000_000).default(20_000).description("单页正文进入模型上下文的最大字符数"),
  maxSnippetChars: Schema.number().min(50).max(10_000).default(1_000).description("单条搜索摘要的最大字符数"),
  maxAnswerChars: Schema.number().min(100).max(100_000).default(8_000).description("所有引擎综合答案合计的最大字符数"),
  blacklist: Schema.array(Schema.string()).default([]).description("命中的 URL 会被搜索过滤，抓取会直接拒绝；按正则表达式解释"),
  logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
});

export interface InstanceConfig {
  mode: string;
}

export const InstanceConfig: Schema<InstanceConfig> = Schema.object({
  mode: Schema.string().description("auto 按配置顺序尝试到有结果；parallel 并发全部；也可以填写插件配置里的某个引擎 id").default("auto"),
});
