import { jsonSchema, tool, type Agent, type Tool, type ToolSet } from "@yesimagent/core";
import { createCustomMessage } from "@yesimagent/core";

import type { ToolsearchConfig } from "../profile/index.js";
import { buildCodeModeToolCatalogMessage, renderToolCatalog } from "./vendor/tool-prompt.js";

export const SEARCH_TOOL = "search";
export const CODE_MODE = "code_mode";

/** Tools that must stay visible on every step regardless of discovery state. */
const ALWAYS_ON: readonly string[] = ["finish", "send_message", "read", SEARCH_TOOL];

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

  /** Set by the runtime: controls the catalog's rendering shape. */
  codemodeEnabled = false;

  constructor(private readonly config: ToolsearchConfig) {}

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
      if (resident.has(name) || name === CODE_MODE) continue;
      this.registry.set(name, def);
    }
    for (const name of this.discovered) {
      if (!this.registry.has(name)) this.discovered.delete(name);
    }
  }

  /** Visible set for the current step: resident ∪ discovered, filtered against the live tool set. */
  visibleTools(): readonly string[] {
    const names = new Set<string>([...this.residentNames(), ...this.discovered, CODE_MODE]);
    return [...names].filter((name) => this.allTools.has(name));
  }

  /**
   * Run one search: keyword-match undiscovered deferred tools, mark hits
   * discovered, and persist a full catalog message into the active turn via
   * `send({trigger:false, ifBusy:'join'})` so it lands after this step's
   * output and before the next step's model call.
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
      .map(({ name, description }) => ({ name, description }));

    if (hits.length === 0) return { tools: [] };

    for (const hit of hits) this.discovered.add(hit.name);
    this.emitCatalog();
    return { tools: hits };
  }

  /** Persist a full-replay catalog message describing the current visible set. */
  private emitCatalog(): void {
    const agent = this.agent;
    if (agent === undefined) return;
    const text = this.renderCatalogText();
    agent.send(createCustomMessage("ishiki.tools.catalog", { text, tools: [...this.visibleTools()] }), { trigger: false, ifBusy: "join" });
  }

  private renderCatalogText(): string {
    if (this.codemodeEnabled) {
      // Mirror the SDK's conversation-mode catalog: the sandbox's host-tool set,
      // rendered with the vendored code-mode renderer (type block + call examples).
      const hostTools: Record<string, Tool> = {};
      for (const name of this.visibleTools()) {
        if (!this.codemodeHosts.has(name)) continue;
        hostTools[name] = this.allTools.get(name)!;
      }
      return buildCodeModeToolCatalogMessage(hostTools);
    }
    // Direct-calling mode: type block only — the model emits tool-call JSON,
    // not JS, so `tools.x()` examples would mislead.
    const visible: Record<string, Tool> = {};
    for (const name of this.visibleTools()) visible[name] = this.allTools.get(name)!;
    const { typeBlock } = renderToolCatalog(visible);
    return [
      "Tool catalog update.",
      "",
      "This catalog replaces all previous tool catalogs. Only the tools listed below are currently available for direct tool calls.",
      "",
      "Tools:",
      typeBlock,
    ].join("\n");
  }
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

export function createSearchTool(state: ToolsearchState): Tool<SearchTool.Input, SearchTool.Output> {
  return tool({
    description:
      "Search deferred tools by name or description keyword. Matched tools become callable on the next step. Use this first when the tools you need are not in the latest tool catalog.",
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
