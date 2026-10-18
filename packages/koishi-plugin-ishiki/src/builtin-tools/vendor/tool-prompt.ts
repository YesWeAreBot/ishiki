/**
 * Vendored from @ai-sdk/code-mode@1.0.84 (src/tool-prompt.ts).
 * Copyright 2023 Vercel, Inc. — Apache License 2.0.
 *
 * Local changes (keep minimal so future upstream diffs stay readable):
 * - imports resolved from "@yesimagent/core" / local types
 * - `renderToolCatalog` exported for direct-calling catalog rendering
 * - "Tool call examples" block removed: it restates the type block's
 *   signatures; the attachment workflow reminder stays
 */
import { createHash } from "node:crypto";

import { asSchema, Tool } from "@yesimagent/core";

type JsonSchema = Record<string, unknown>;

/**
 * Local alias of @ai-sdk/code-mode's CodeModeToolSet. The vendored
 * tool-prompt renderer (vendor/tool-prompt.ts) consumes this shape.
 */
export type CodeModeToolSet = Record<string, Tool<any, any>>;

interface SchemaContext {
  root: JsonSchema;
  seenRefs: Set<string>;
  depth: number;
}

const MAX_SCHEMA_DEPTH = 8;
const MAX_COMPACT_OBJECT_TYPE_LENGTH = 120;
const MIN_ALIAS_TYPE_LENGTH = 80;

export interface ToolCatalogMessageOptions {
  mode?: "full" | "incremental";
  version?: number;
  known?: readonly string[];
  removed?: readonly string[];
  knownIndex?: boolean;
  knownAliases?: ReadonlySet<string>;
}

export interface ToolCatalogMessage {
  text: string;
  aliases: ReadonlyMap<string, string>;
}

interface ToolCatalogRender {
  typeBlock: string;
  aliases: Map<string, string>;
}

export function buildCodeModeToolDescription(tools: CodeModeToolSet, toolDiscovery: "description" | "conversation" = "description"): string {
  const sections = [
    "Execute code-mode TypeScript in an isolated sandbox.",
    "",
    "Put the full program in `js`; top-level `await`/`return` work. Return a JSON-serializable result.",
    "Call host tools only as async `tools.name(input)`; await each or use `Promise.all` for independent calls.",
    "Host tools return raw JSON-safe values inside this program. Return complete structured results to retain media and read provenance; the runtime supplies text previews and separate attachments on the next step. See the system instructions for the attachment workflow.",
    toolDiscovery === "description"
      ? "Use exact names/types below. `JSON.parse`/`JSON.stringify` are available."
      : "Use exact names/types from the capability updates. `JSON.parse`/`JSON.stringify` are available.",
    "Fetch: `fetch` is not available.",
  ];

  if (toolDiscovery === "conversation") {
    sections.push(
      "",
      "Tools:",
      'The current host-tool API is provided in "Code mode capability update" user messages. Apply updates in order: a full snapshot supersedes earlier updates; an incremental update adds, changes, or removes tools; a later declaration for the same tool wins. A `Known tools` line, when present, is the complete current set.',
    );
    return sections.join("\n");
  }

  const typeBlock = renderToolCatalog(tools);
  sections.push("", "Tools:", typeBlock);

  return sections.join("\n");
}

export function buildCodeModeToolCatalogMessage(tools: CodeModeToolSet, options: ToolCatalogMessageOptions = {}): ToolCatalogMessage {
  return buildCatalogMessage("codemode", tools, options);
}

export function buildDirectToolCatalogMessage(tools: CodeModeToolSet, options: ToolCatalogMessageOptions = {}): ToolCatalogMessage {
  return buildCatalogMessage("direct", tools, options);
}

function buildCatalogMessage(kind: "codemode" | "direct", tools: CodeModeToolSet, options: ToolCatalogMessageOptions): ToolCatalogMessage {
  const mode = options.mode ?? "full";
  const suffix = options.version === undefined ? "" : ` (${mode === "full" ? "full snapshot" : "incremental"} v${options.version})`;
  const title = kind === "codemode" ? "Code mode capability update." : "Tool catalog update.";
  const lines = [`${title}${suffix}`, ""];

  if (mode === "full") {
    lines.push(
      kind === "codemode"
        ? "This snapshot replaces all previous code mode capability catalogs. Only the tools listed below are currently available through `tools`."
        : "This snapshot replaces all previous tool catalogs. Only the tools listed below are currently available for direct tool calls.",
    );
    if (kind === "codemode") {
      lines.push(
        "These return types describe raw values inside codemode. Return complete structured results to retain media and read provenance; follow the system instructions for final previews and attachments.",
      );
    }
  } else {
    lines.push(
      kind === "codemode"
        ? "This update adds or changes only the tools listed below. The full current set is the union of all capability updates; the Known tools line below is authoritative. A later declaration for the same tool overrides an earlier one."
        : "This update adds or changes only the tools listed below. The full current set is the union of all tool catalog updates; the Known tools line below is authoritative. A later declaration for the same tool overrides an earlier one.",
    );
  }

  const removed = options.removed ?? [];
  if (removed.length > 0) lines.push("", `Removed: ${removed.join(", ")}`);

  const entries = Object.entries(tools);
  if (entries.length > 0) {
    lines.push("", mode === "full" ? "Tools:" : "New/changed tools:");
    const rendered = renderToolCatalogDetailed(tools, options.knownAliases);
    lines.push(rendered.typeBlock);
    if (mode === "incremental" && options.knownIndex !== false && options.known !== undefined) {
      lines.push("", `Known tools: ${options.known.join(", ")}`);
    }
    return { text: lines.join("\n"), aliases: rendered.aliases };
  }

  if (mode === "full") {
    lines.push("", kind === "codemode" ? "No host tools. Do not call `tools.*`." : "No tools.");
  } else if (options.knownIndex !== false && options.known !== undefined) {
    lines.push("", `Known tools: ${options.known.join(", ")}`);
  }
  return { text: lines.join("\n"), aliases: new Map<string, string>() };
}

export function renderToolCatalog(tools: CodeModeToolSet): string {
  return renderToolCatalogDetailed(tools).typeBlock;
}

export function renderToolCatalogDetailed(tools: CodeModeToolSet, knownAliases: ReadonlySet<string> = new Set()): ToolCatalogRender {
  const entries = Object.entries(tools).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return { typeBlock: "No host tools. Do not call `tools.*`.", aliases: new Map() };
  }

  const typeByName = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const [name, tool] of entries) {
    const outputSchema = resolveOutputSchema(tool);
    const type = outputSchema === undefined ? "unknown" : schemaToType(outputSchema, outputSchema);
    typeByName.set(name, type);
    if (type.length >= MIN_ALIAS_TYPE_LENGTH) counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const byType = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const type of typeByName.values()) {
    if ((counts.get(type) ?? 0) < 2 || byType.has(type)) continue;
    const alias = `ToolResult_${createHash("sha1").update(type).digest("hex").slice(0, 8)}`;
    byType.set(type, alias);
    aliases.set(alias, type);
  }

  const aliasLines: string[] = [];
  const newAliases = new Map<string, string>();
  for (const [alias, type] of aliases) {
    if (knownAliases.has(alias)) continue;
    aliasLines.push(`type ${alias} = ${type};`);
    newAliases.set(alias, type);
  }

  const declarations = entries.flatMap(([name, tool]) => {
    const type = typeByName.get(name)!;
    return renderToolDeclaration([name, tool], byType.get(type));
  });

  const body: string[] = [];
  if (aliasLines.length > 0) body.push(...aliasLines, "");
  body.push("declare const tools: {", ...declarations, "};");
  return { typeBlock: ["```ts", ...body, "```"].join("\n"), aliases: newAliases };
}

export function renderToolDeclaration([toolName, tool]: [string, CodeModeToolSet[string]], outputType?: string): string[] {
  const schema = resolveInputSchema(tool);
  const inputType = schema === undefined ? "unknown" : schemaToType(schema, schema);
  const outputSchema = resolveOutputSchema(tool);
  const resolvedOutputType = outputType ?? (outputSchema === undefined ? "unknown" : schemaToType(outputSchema, outputSchema));
  const description = firstString(tool.description, tool.title);
  const lines: string[] = [];

  if (description !== undefined) {
    lines.push(`  /** ${toComment(description)} */`);
  }

  lines.push(`  ${formatObjectKey(toolName)}: (input: ${indentType(inputType, 2)}) => Promise<${indentType(resolvedOutputType, 2)}>;`);
  return lines;
}

function resolveInputSchema(tool: CodeModeToolSet[string]): JsonSchema | undefined {
  try {
    const jsonSchema = asSchema(tool.inputSchema).jsonSchema;
    if (isPromiseLike(jsonSchema) || !isRecord(jsonSchema)) {
      return undefined;
    }
    return jsonSchema;
  } catch {
    return undefined;
  }
}

function resolveOutputSchema(tool: CodeModeToolSet[string]): JsonSchema | undefined {
  try {
    const outputSchema = tool.outputSchema;
    if (outputSchema === undefined) {
      return undefined;
    }
    const jsonSchema = asSchema(outputSchema).jsonSchema;
    if (isPromiseLike(jsonSchema) || !isRecord(jsonSchema)) {
      return undefined;
    }
    return jsonSchema;
  } catch {
    return undefined;
  }
}

function schemaToType(schema: JsonSchema, root: JsonSchema): string {
  return schemaToTypeInner(schema, {
    root,
    seenRefs: new Set(),
    depth: 0,
  });
}

function schemaToTypeInner(schema: JsonSchema, context: SchemaContext): string {
  if (context.depth > MAX_SCHEMA_DEPTH) {
    return "unknown";
  }

  const ref = firstString(schema.$ref);
  if (ref !== undefined) {
    const resolved = resolveRef(ref, context.root, context.seenRefs);
    return resolved === undefined ? "unknown" : schemaToTypeInner(resolved, nextContext(context));
  }

  const constValue = schema.const;
  if (constValue !== undefined) {
    return literalType(constValue);
  }

  const enumValues = asArray(schema.enum);
  if (enumValues !== undefined) {
    return union(enumValues.map(literalType));
  }

  const oneOf = schemaArray(schema.oneOf);
  if (oneOf !== undefined) {
    return union(oneOf.map((part) => schemaToTypeInner(part, nextContext(context))));
  }

  const anyOf = schemaArray(schema.anyOf);
  if (anyOf !== undefined) {
    return union(anyOf.map((part) => schemaToTypeInner(part, nextContext(context))));
  }

  const allOf = schemaArray(schema.allOf);
  if (allOf !== undefined) {
    return allOf.map((part) => schemaToTypeInner(part, nextContext(context))).join(" & ");
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return union(type.map((part) => schemaToTypeInner({ ...schema, type: part }, context)));
  }

  if (type === "object" || isRecord(schema.properties)) {
    return objectType(schema, context);
  }

  if (type === "array" || schema.items !== undefined) {
    return arrayType(schema, context);
  }

  if (type === "string") {
    return "string";
  }

  if (type === "number" || type === "integer") {
    return "number";
  }

  if (type === "boolean") {
    return "boolean";
  }

  if (type === "null") {
    return "null";
  }

  return "unknown";
}

function objectType(schema: JsonSchema, context: SchemaContext): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(asArray(schema.required)?.filter(isString));
  const entries = Object.entries(properties).filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]));

  if (entries.length === 0) {
    const additionalProperties = schema.additionalProperties;
    if (isRecord(additionalProperties)) {
      return `Record<string, ${schemaToTypeInner(additionalProperties, nextContext(context))}>`;
    }
    if (additionalProperties === true) {
      return "Record<string, unknown>";
    }
    return "{}";
  }

  const lines = entries.flatMap(([name, value]) => {
    const propertyLines: string[] = [];
    const description = firstString(value.description);
    if (description !== undefined) {
      propertyLines.push(`  /** ${toComment(description)} */`);
    }
    propertyLines.push(`  ${formatObjectKey(name)}${required.has(name) ? "" : "?"}: ${indentType(schemaToTypeInner(value, nextContext(context)), 2)};`);
    return propertyLines;
  });

  const additionalProperties = schema.additionalProperties;
  if (isRecord(additionalProperties)) {
    lines.push(`  [key: string]: ${schemaToTypeInner(additionalProperties, nextContext(context))};`);
  } else if (additionalProperties === true) {
    lines.push("  [key: string]: unknown;");
  }

  const compact = compactObjectType(lines);
  if (compact !== undefined) {
    return compact;
  }

  return `{\n${lines.join("\n")}\n}`;
}

function arrayType(schema: JsonSchema, context: SchemaContext): string {
  const items = schema.items;
  if (Array.isArray(items)) {
    return `[${items.map((item) => (isRecord(item) ? schemaToTypeInner(item, nextContext(context)) : "unknown")).join(", ")}]`;
  }
  if (isRecord(items)) {
    const itemType = schemaToTypeInner(items, nextContext(context));
    return needsParentheses(itemType) || itemType.includes("\n") ? `Array<${itemType}>` : `${itemType}[]`;
  }
  return "unknown[]";
}

function resolveRef(ref: string, root: JsonSchema, seenRefs: Set<string>): JsonSchema | undefined {
  if (!ref.startsWith("#/") || seenRefs.has(ref)) {
    return undefined;
  }

  seenRefs.add(ref);
  const value = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, part) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[part];
    }, root);

  return isRecord(value) ? value : undefined;
}

function nextContext(context: SchemaContext): SchemaContext {
  return {
    ...context,
    depth: context.depth + 1,
  };
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  return unique.length === 0 ? "unknown" : unique.join(" | ");
}

function literalType(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return "unknown";
}

function indentType(type: string, spaces: number): string {
  if (!type.includes("\n")) {
    return type;
  }
  const padding = " ".repeat(spaces);
  return type.replaceAll("\n", `\n${padding}`);
}

function needsParentheses(type: string): boolean {
  return type.includes(" | ") || type.includes(" & ");
}

function formatObjectKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function compactObjectType(lines: string[]): string | undefined {
  if (lines.length === 0 || lines.some((line) => line.includes("/**"))) {
    return undefined;
  }

  const fields = lines.map((line) => line.trim());
  if (fields.some((field) => field.includes("\n"))) {
    return undefined;
  }

  const compact = `{ ${fields.join(" ")} }`;
  return compact.length <= MAX_COMPACT_OBJECT_TYPE_LENGTH ? compact : undefined;
}

function toComment(value: string): string {
  return value.replaceAll("*/", "* /").replace(/\s+/g, " ").trim();
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(isString);
}

function schemaArray(value: unknown): JsonSchema[] | undefined {
  const values = asArray(value);
  if (values === undefined || !values.every(isRecord)) {
    return undefined;
  }
  return values;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}
