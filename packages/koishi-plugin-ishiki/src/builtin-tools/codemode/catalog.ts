import type { CodemodeJsonSchema, CodemodeTool, RenderDeclarationsOptions } from "@earendil-works/pi-codemode";

/** Search results per query when the script does not pass `limit`. */
const DEFAULT_LIMIT = 8;
/** One-line hint length in search results; full signatures come from `describeTool`. */
const MATCH_HINT_LIMIT = 60;

export const SEARCH_TOOLS_GLOBAL = "searchTools";
export const DESCRIBE_TOOL_GLOBAL = "describeTool";

export interface CodemodeCatalogEntry {
  name: string;
  description?: string;
  inputSchema?: CodemodeJsonSchema;
  outputSchema?: CodemodeJsonSchema;
}

export interface CodemodeCatalog {
  readonly globals: readonly CodemodeTool[];
  update(entries: readonly CodemodeCatalogEntry[]): void;
}

function tokenize(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** First line, bounded at {@link MATCH_HINT_LIMIT}; signatures stay in `describeTool`. */
function toMatchHint(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const line = description.split("\n", 1)[0]!.trim();
  if (line.length === 0) return undefined;
  return line.length <= MATCH_HINT_LIMIT ? line : `${line.slice(0, MATCH_HINT_LIMIT)}…`;
}

/** Globals are spread, so the sandbox hands the whole argument list as one array. */
function readArguments(name: string, args: unknown): unknown[] {
  if (!Array.isArray(args)) throw new TypeError(`${name} expects positional arguments`);
  return args;
}

function readLimit(options: unknown): number {
  if (options === undefined) return DEFAULT_LIMIT;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("searchTools(query, options) expects options to be an object with an optional numeric limit");
  }
  const limit = "limit" in options ? options.limit : undefined;
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new TypeError("searchTools(query, { limit }) expects limit to be a positive integer");
  }
  return limit;
}

export function createCatalog(renderDeclarations: (options: RenderDeclarationsOptions) => string): CodemodeCatalog {
  let entries: readonly CodemodeCatalogEntry[] = [];

  const searchTools: CodemodeTool = {
    name: SEARCH_TOOLS_GLOBAL,
    description: "Search the host tools callable from this script by topic. Repeat queries are free and may return the same tool.",
    signature: "(query: string, options?: { limit?: number }): Promise<Array<{ name: string; description?: string }>>",
    spread: true,
    execute: (args) => {
      const [query, options] = readArguments(SEARCH_TOOLS_GLOBAL, args);
      if (typeof query !== "string") throw new TypeError("searchTools(query) expects query to be a string");
      const limit = readLimit(options);
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0) return [];
      return entries
        .map((entry) => {
          const nameTerms = tokenize(entry.name);
          const descriptionTerms = tokenize(entry.description ?? "");
          const score = terms.reduce((acc, term) => acc + (nameTerms.includes(term) ? 2 : 0) + (descriptionTerms.includes(term) ? 1 : 0), 0);
          return { entry, score };
        })
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ entry }) => ({ name: entry.name, description: toMatchHint(entry.description) }));
    },
  };

  const describeTool: CodemodeTool = {
    name: DESCRIBE_TOOL_GLOBAL,
    description: "Render the TypeScript declaration of one host tool, including its full description and argument schema.",
    signature: "(name: string): Promise<string | undefined>",
    spread: true,
    execute: (args) => {
      const [name] = readArguments(DESCRIBE_TOOL_GLOBAL, args);
      if (typeof name !== "string") throw new TypeError("describeTool(name) expects name to be a string");
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry === undefined) return undefined;
      return renderDeclarations({ tools: [{ ...entry, execute: () => undefined }] });
    },
  };

  return {
    globals: [searchTools, describeTool],
    update(next) {
      entries = next;
    },
  };
}
