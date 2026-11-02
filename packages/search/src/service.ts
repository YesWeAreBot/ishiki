import { createEngines } from "./engines/index.js";
import type { Capability, EngineSearchResult, FetchOutput, FetchResult, SearchConfig, SearchEngine, SearchOutput } from "./types.js";
import { capAnswers, compileBlacklist, errorMessage, isBlocked, mergeHits, normalizeUrls, truncate } from "./utils.js";

interface SearchAttempt {
  engine: SearchEngine;
  result?: EngineSearchResult;
  error?: string;
}

export class SearchService {
  public readonly engines: SearchEngine[];
  public readonly config: SearchConfig;

  private readonly blocked: RegExp | undefined;

  constructor(config: SearchConfig) {
    if (config.defaultLimit > config.maxLimit) {
      throw new Error("defaultLimit cannot be greater than maxLimit");
    }
    const ids = new Set<string>();
    for (const engine of config.engines) {
      if (engine.id.trim().length === 0) throw new Error("Engine id must not be empty");
      if (engine.id === "auto" || engine.id === "parallel") throw new Error(`Engine id "${engine.id}" is reserved`);
      if (ids.has(engine.id)) throw new Error(`Duplicate engine id: ${engine.id}`);
      ids.add(engine.id);
    }
    this.config = config;
    this.engines = createEngines(config.engines, config.timeoutMs);
    this.blocked = compileBlacklist(config.blacklist);
  }

  public available(capability: Capability): SearchEngine[] {
    return this.engines.filter((engine) => (capability === "search" ? engine.search !== undefined : engine.fetchPage !== undefined));
  }

  public can(mode: string, capability: Capability): boolean {
    if (mode === "auto" || mode === "parallel") return this.available(capability).length > 0;
    const config = this.config.engines.find((engine) => engine.id === mode);
    if (!config?.enabled) return false;
    const engine = this.engines.find((candidate) => candidate.id === mode);
    if (!engine) return false;
    return capability === "search" ? engine.search !== undefined : engine.fetchPage !== undefined;
  }

  public select(mode: string, capability: Capability): SearchEngine[] {
    if (mode === "auto" || mode === "parallel") {
      const engines = this.available(capability);
      if (engines.length === 0) throw new Error(`No enabled engine supports ${capability}`);
      return engines;
    }
    const config = this.config.engines.find((engine) => engine.id === mode);
    if (!config) throw new Error(`Unknown mode or engine id: ${mode}`);
    if (!config.enabled) throw new Error(`Engine "${mode}" is disabled`);
    const engine = this.engines.find((candidate) => candidate.id === mode);
    if (!engine) throw new Error(`Engine "${mode}" was not created`);
    if (capability === "search" ? engine.search === undefined : engine.fetchPage === undefined) {
      throw new Error(`Engine "${mode}" does not support ${capability}`);
    }
    return [engine];
  }

  public async search(mode: string, query: string, limit: number, signal?: AbortSignal): Promise<SearchOutput> {
    if (query.trim().length === 0) throw new Error("Search query must not be empty");
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.maxLimit) {
      throw new Error(`limit must be an integer between 1 and ${this.config.maxLimit}`);
    }
    const engines = this.select(mode, "search");
    const attempts = mode === "parallel" ? await this.searchParallel(engines, query, limit, signal) : await this.searchAuto(engines, query, limit, signal);
    const successful = attempts.filter((attempt): attempt is SearchAttempt & { result: EngineSearchResult } => attempt.result !== undefined);
    const results = mergeHits(successful.flatMap((attempt) => attempt.result.results))
      .filter((hit) => !isBlocked(hit.url, this.blocked))
      .slice(0, limit)
      .map((hit) => ({ ...hit, snippet: truncate(hit.snippet, this.config.maxSnippetChars) }));
    const answers = successful.flatMap((attempt) => attempt.result.answers ?? []);
    const errors = attempts.flatMap((attempt) => (attempt.error ? [`${attempt.engine.id}: ${attempt.error}`] : []));
    return {
      results,
      ...(answers.length > 0 ? { answers: capAnswers(answers, this.config.maxAnswerChars) } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  public async fetch(mode: string, inputs: string[], signal?: AbortSignal): Promise<FetchOutput> {
    const urls = normalizeUrls(inputs, this.config.maxFetchUrls);
    const engines = this.select(mode, "fetch");
    const results: FetchResult[] = [];
    for (const url of urls) {
      if (isBlocked(url, this.blocked)) {
        results.push({ url, error: "URL is blocked by the blacklist" });
        continue;
      }
      try {
        const page = mode === "parallel" ? await this.fetchParallel(engines, url, signal) : await this.fetchAuto(engines, url, signal);
        results.push({ url, title: page.title, content: truncate(page.content, this.config.maxContentChars) });
      } catch (error) {
        if (signal?.aborted) throw error;
        results.push({ url, error: errorMessage(error) });
      }
    }
    return { results };
  }

  private async searchAuto(engines: SearchEngine[], query: string, limit: number, signal?: AbortSignal): Promise<SearchAttempt[]> {
    const attempts: SearchAttempt[] = [];
    for (const engine of engines) {
      try {
        const result = await engine.search!({ query, limit, signal });
        attempts.push({ engine, result });
        if (result.results.some((hit) => !isBlocked(hit.url, this.blocked))) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        attempts.push({ engine, error: errorMessage(error) });
      }
    }
    if (!attempts.some((attempt) => attempt.result !== undefined)) {
      throw new Error(`All search engines failed: ${attempts.map((attempt) => `${attempt.engine.id}: ${attempt.error}`).join("; ")}`);
    }
    return attempts;
  }

  private async searchParallel(engines: SearchEngine[], query: string, limit: number, signal?: AbortSignal): Promise<SearchAttempt[]> {
    const settled = await Promise.allSettled(engines.map(async (engine) => ({ engine, result: await engine.search!({ query, limit, signal }) })));
    if (signal?.aborted) throw signal.reason ?? new Error("Search aborted");
    const attempts: SearchAttempt[] = settled.map((entry, index) =>
      entry.status === "fulfilled" ? entry.value : { engine: engines[index], error: errorMessage(entry.reason) },
    );
    if (!attempts.some((attempt) => attempt.result !== undefined)) {
      throw new Error(`All search engines failed: ${attempts.map((attempt) => `${attempt.engine.id}: ${attempt.error}`).join("; ")}`);
    }
    return attempts;
  }

  private async fetchAuto(engines: SearchEngine[], url: string, signal?: AbortSignal) {
    const errors: string[] = [];
    for (const engine of engines) {
      try {
        const page = await engine.fetchPage!(url, signal);
        return { title: page.title.trim() || url, content: page.content };
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(`${engine.id}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`All fetch engines failed: ${errors.join("; ")}`);
  }

  private async fetchParallel(engines: SearchEngine[], url: string, signal?: AbortSignal) {
    try {
      const page = await Promise.any(engines.map((engine) => engine.fetchPage!(url, signal)));
      return { title: page.title.trim() || url, content: page.content };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof AggregateError) {
        const errors = error.errors.map((reason, index) => `${engines[index].id}: ${errorMessage(reason)}`);
        throw new Error(`All fetch engines failed: ${errors.join("; ")}`);
      }
      throw error;
    }
  }
}
