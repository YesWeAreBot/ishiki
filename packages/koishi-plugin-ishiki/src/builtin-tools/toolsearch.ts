import { createHash } from "node:crypto";

import { jsonSchema, tool, createCustomMessage, createEntry, type Agent, type AgentEntry, type Tool, type ToolSet } from "@yesimagent/core";

import type { ToolsearchConfig } from "../profile/index.js";
import { CODEMODE_TOOL } from "./codemode.js";
import { FINISH_TOOL } from "./finish.js";
import { READ_TOOL } from "./read.js";
import { SEND_MESSAGE_TOOL } from "./send-message.js";
import { buildCodeModeToolCatalogMessage, buildDirectToolCatalogMessage, renderToolDeclaration } from "./vendor/tool-prompt.js";
import { WAIT_TOOL } from "./wait.js";

export const SEARCH_TOOL = "search";

/** Search results stay a name plus a one-line hint; full signatures live in the catalog. */
const MATCH_HINT_LIMIT = 60;

/** Tools that must stay visible on every step regardless of discovery state. */
const ALWAYS_ON: readonly string[] = [FINISH_TOOL, SEND_MESSAGE_TOOL, READ_TOOL, CODEMODE_TOOL, SEARCH_TOOL, WAIT_TOOL];

export namespace SearchTool {
  export interface Input {
    query: string;
  }
  export interface Match {
    name: string;
    description?: string;
  }
  export interface Output {
    tools: Match[];
  }
}

interface CatalogUpdate {
  text: string;
  mode: "full" | "incremental";
  version: number;
  known: readonly string[];
  removed: readonly string[];
}

/**
 * Runtime-scoped progressive disclosure state.
 *
 * `discovered` survives across turns on purpose: catalog messages are
 * persisted into the conversation, so the visible-tool set the model reads
 * from history and the set `prepareStep` exposes must share a lifetime —
 * both are this runtime's lifetime.
 */
export class ToolsearchState {
  /** Names surfaced by search so far; the visible set is resident ∪ discovered. */
  private discovered = new Set<string>();
  /** The deferred pool: tools excluded from the initial model view. */
  private registry = new Map<string, Tool>();
  /** The full live tool set, for signature rendering of visible tools. */
  private allTools = new Map<string, Tool>();
  /** Names routed to code_mode (host tools of the sandbox); empty when codemode is off. */
  private codemodeHosts = new Set<string>();
  private agent: Agent | undefined;
  /** Sorted visible names plus declaration hashes at the last catalog emission. */
  private lastEmittedKey: string | undefined;
  /** Whether the baseline catalog has been persisted for this runtime. */
  private baselineEmitted = false;
  /** Per-tool declaration hashes at the last emission. */
  private emitted = new Map<string, string>();
  /** Catalog versions that are still required for the current visible set. */
  private emittedVersions = new Set<number>();
  /** Output-type aliases defined in earlier catalog messages. */
  private emittedAliases = new Map<string, string>();
  private catalogVersion = 0;
  private updatesSinceFull = 0;
  private forceFullSnapshot = false;
  private readonly catalogMode: "incremental" | "replace";
  private readonly fullSnapshotEvery: number;
  private readonly knownIndex: boolean;

  /** Set by the runtime: controls the catalog's rendering shape. */
  codemodeEnabled = false;

  constructor(private readonly config: ToolsearchConfig) {
    this.catalogMode = config.catalogMode ?? "incremental";
    this.fullSnapshotEvery = config.fullSnapshotEvery ?? 8;
    this.knownIndex = config.knownIndex ?? true;
  }

  bind(agent: Agent): void {
    this.agent = agent;
  }

  residentNames(): readonly string[] {
    return [...new Set([...ALWAYS_ON, ...this.config.resident])];
  }

  /** Re-sync after a (re)load of the tool set. Discovered names that survive the reload stay discovered. */
  refresh(tools: ToolSet, resident: ReadonlySet<string>, codemodeHosts: ReadonlySet<string>): void {
    this.allTools = new Map(Object.entries(tools));
    this.codemodeHosts = new Set(codemodeHosts);
    this.registry.clear();
    for (const [name, def] of Object.entries(tools)) {
      if (resident.has(name) || name === CODEMODE_TOOL) continue;
      this.registry.set(name, def);
    }
    for (const name of this.discovered) {
      if (!this.registry.has(name)) this.discovered.delete(name);
    }
  }

  /** Visible set for the current step: resident ∪ discovered, filtered against the live tool set. */
  visibleTools(): readonly string[] {
    const names = new Set<string>([...this.residentNames(), ...this.discovered, CODEMODE_TOOL]);
    return [...names].filter((name) => this.allTools.has(name));
  }

  /**
   * Run one search: keyword-match undiscovered deferred tools and mark hits
   * discovered. Catalog emission is deferred to {@link flushCatalog} at the
   * step boundary, so parallel searches within one step coalesce into a
   * single full-replay catalog.
   */
  search(query: string): SearchTool.Output {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return { tools: [] };

    const pool: Array<{ name: string; description?: string }> = [];
    for (const [name, def] of this.registry) {
      if (this.discovered.has(name)) continue;
      const description = typeof def.description === "string" ? def.description : undefined;
      pool.push({ name, description });
    }

    const hits = pool
      .map(({ name, description }) => {
        const nameTerms = tokenize(name);
        const descriptionTerms = tokenize(description ?? "");
        return {
          name,
          description,
          score: terms.reduce((acc, term) => acc + (nameTerms.includes(term) ? 2 : 0) + (descriptionTerms.includes(term) ? 1 : 0), 0),
        };
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxResults)
      .map(({ name, description }) => ({ name, description: toMatchHint(description) }));

    if (hits.length === 0) return { tools: [] };

    for (const hit of hits) this.discovered.add(hit.name);
    return { tools: hits };
  }

  /**
   * Persist the first catalog during plugin `init`, before any user message
   * can land: the core writes turn input only after `ensureInit` resolves,
   * so the storage order is [catalog, user...] and every request's catalog
   * slot is defined by storage alone — the very first request included, with
   * no prepareStep-side prepending. Step-boundary emission (joined messages)
   * only lands after a step's output; this baseline covers the fresh
   * runtime's first turn. Must run after the toolset is assembled
   * ({@link ToolsearchState.refresh}). flushCatalog's key bookkeeping
   * mirrors this append, so a later flush only fires on real changes.
   */
  async ensureBaselineCatalog(): Promise<void> {
    if (this.baselineEmitted || this.agent === undefined) return;
    this.baselineEmitted = true;
    const update = this.buildUpdate(true);
    if (update === undefined) return;
    const message = createCustomMessage("ishiki.tools.catalog", {
      text: update.text,
      tools: [...this.visibleTools()],
      mode: update.mode,
      version: update.version,
      known: update.known,
      removed: update.removed,
    });
    await this.agent.storage.append(createEntry("message", message));
    this.lastEmittedKey = this.catalogKey();
  }

  /**
   * Emit a catalog update when the visible set or a declaration changed.
   * Called at the step boundary after the step's messages are persisted, so
   * parallel searches within one step coalesce into one update.
   */
  flushCatalog(): void {
    const agent = this.agent;
    if (agent === undefined || !this.config.enable) return;
    const key = this.catalogKey();
    if (key === this.lastEmittedKey && !this.forceFullSnapshot) return;
    const update = this.buildUpdate(false);
    if (update === undefined) return;
    this.lastEmittedKey = key;
    agent.send(
      createCustomMessage("ishiki.tools.catalog", {
        text: update.text,
        tools: [...this.visibleTools()],
        mode: update.mode,
        version: update.version,
        known: update.known,
        removed: update.removed,
      }),
      { trigger: false, ifBusy: "join" },
    );
  }

  /** Keep only the latest catalog message in replace mode; incremental mode keeps the full log. */
  filterEntries(entries: readonly AgentEntry[]): readonly AgentEntry[] {
    if (this.catalogMode !== "replace") return entries;
    let latest = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "message") continue;
      const message = entry.data;
      if (message.role === "custom" && message.type === "ishiki.tools.catalog") latest = index;
    }
    if (latest < 0) return entries;
    return entries.filter((entry, index) => {
      if (index === latest || entry.type !== "message") return true;
      const message = entry.data;
      return message.role !== "custom" || message.type !== "ishiki.tools.catalog";
    });
  }

  /**
   * Detect context compaction or window truncation that removed a catalog
   * message still needed by the current visible set. The next flush then
   * emits a full snapshot to restore the declarations.
   */
  observeEntries(entries: readonly AgentEntry[]): void {
    if (this.catalogVersion === 0) return;
    const versions = new Set<number>();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const message = entry.data;
      if (message.role !== "custom" || message.type !== "ishiki.tools.catalog") continue;
      const version = message.data.version;
      if (typeof version === "number") versions.add(version);
    }

    if (this.catalogMode === "replace") {
      if (!versions.has(this.catalogVersion)) this.forceFullSnapshot = true;
      return;
    }

    for (const version of this.emittedVersions) {
      if (!versions.has(version)) {
        this.forceFullSnapshot = true;
        return;
      }
    }
  }

  /** Build and consume a full-snapshot repair entry after catalog loss. */
  repairCatalog(): AgentEntry | undefined {
    if (!this.forceFullSnapshot) return undefined;
    const update = this.buildUpdate(true);
    if (update === undefined) return undefined;
    this.lastEmittedKey = this.catalogKey();
    return createEntry(
      "message",
      createCustomMessage("ishiki.tools.catalog", {
        text: update.text,
        tools: [...this.visibleTools()],
        mode: update.mode,
        version: update.version,
        known: update.known,
        removed: update.removed,
      }),
    );
  }

  private renderableTools(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const name of this.visibleTools()) {
      if (this.codemodeEnabled && !this.codemodeHosts.has(name)) continue;
      const tool = this.allTools.get(name);
      if (tool !== undefined) tools[name] = tool;
    }
    return tools;
  }

  private catalogKey(): string {
    const tools = this.renderableTools();
    return Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, tool]) => `${name}:${declarationHash(name, tool)}`)
      .join("\n");
  }

  private buildUpdate(forceFull: boolean): CatalogUpdate | undefined {
    const tools = this.renderableTools();
    const names = Object.keys(tools).sort((left, right) => left.localeCompare(right));
    const hashes = new Map(names.map((name) => [name, declarationHash(name, tools[name]!)]));
    const full =
      forceFull ||
      this.forceFullSnapshot ||
      this.catalogMode === "replace" ||
      this.catalogVersion === 0 ||
      (this.fullSnapshotEvery > 0 && this.updatesSinceFull >= this.fullSnapshotEvery);

    if (full) {
      this.catalogVersion += 1;
      const result = this.codemodeEnabled
        ? buildCodeModeToolCatalogMessage(tools, { mode: "full", version: this.catalogVersion, known: names, knownIndex: this.knownIndex })
        : buildDirectToolCatalogMessage(tools, { mode: "full", version: this.catalogVersion, known: names, knownIndex: this.knownIndex });
      this.emitted = hashes;
      this.emittedVersions = new Set([this.catalogVersion]);
      this.emittedAliases = new Map(result.aliases);
      this.updatesSinceFull = 0;
      this.forceFullSnapshot = false;
      return { text: result.text, mode: "full", version: this.catalogVersion, known: names, removed: [] };
    }

    const removed = [...this.emitted.keys()].filter((name) => !hashes.has(name)).sort((left, right) => left.localeCompare(right));
    const changed = names.filter((name) => this.emitted.get(name) !== hashes.get(name));
    if (changed.length === 0 && removed.length === 0) return undefined;

    this.catalogVersion += 1;
    const subset: Record<string, Tool> = {};
    for (const name of changed) subset[name] = tools[name]!;
    const options = {
      mode: "incremental" as const,
      version: this.catalogVersion,
      known: names,
      removed,
      knownIndex: this.knownIndex,
      knownAliases: new Set(this.emittedAliases.keys()),
    };
    const result = this.codemodeEnabled ? buildCodeModeToolCatalogMessage(subset, options) : buildDirectToolCatalogMessage(subset, options);

    for (const name of removed) this.emitted.delete(name);
    for (const name of changed) this.emitted.set(name, hashes.get(name)!);
    this.emittedVersions.add(this.catalogVersion);
    for (const [alias, type] of result.aliases) this.emittedAliases.set(alias, type);
    this.updatesSinceFull += 1;
    return { text: result.text, mode: "incremental", version: this.catalogVersion, known: names, removed };
  }
}

function declarationHash(name: string, tool: Tool): string {
  return createHash("sha1")
    .update(renderToolDeclaration([name, tool]).join("\n"))
    .digest("hex");
}

/** Tokenizer mirroring the AI SDK's toolSearch matching: camelCase split, lowercase, unicode words. */
function tokenize(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** One-line hint, bounded at {@link MATCH_HINT_LIMIT}; signatures stay in the catalog. */
function toMatchHint(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const line = description.split("\n", 1)[0]!.trim();
  if (line.length === 0) return undefined;
  return line.length <= MATCH_HINT_LIMIT ? line : `${line.slice(0, MATCH_HINT_LIMIT)}…`;
}

export function createSearchTool(state: ToolsearchState): Tool<SearchTool.Input, SearchTool.Output> {
  return tool({
    description:
      "Search deferred tools by name or description keyword. Matched tools become callable on the next step. Use this first when the tools you need are not in the current tool catalog (the union of capability updates).",
    inputSchema: jsonSchema<SearchTool.Input>({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query matched against tool names and descriptions" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
    execute: async ({ query }) => state.search(query),
  });
}
