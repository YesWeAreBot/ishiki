import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlugin, Tool, ToolSet } from "@yesimagent/core";
import { parse } from "yaml";

type JsonObject = Record<string, unknown>;
type Description = string | null;
type ToolTransformStage = "base" | "complete";

interface OverlayPlugin extends AgentPlugin {
  transformTools(tools: ToolSet, stage: ToolTransformStage): Promise<ToolSet> | ToolSet;
}

interface ToolPatch {
  readonly description?: Description;
  readonly parameters: ReadonlyMap<string, Description>;
}

interface ToolsFile {
  readonly version: 1;
  readonly tools: ReadonlyMap<string, ToolPatch>;
}

export interface AgentOverlayOptions {
  readonly root: string;
  readonly instructionFiles?: readonly string[];
  readonly toolsFile?: string;
}

/** 创建一次性调试插件：读取候选目录中的 instructions overlay 与 tools.md。 */
export function createAgentOverlayPlugin(options: AgentOverlayOptions): OverlayPlugin {
  const instructions = (options.instructionFiles ?? []).map((relative) => readOverlay(options.root, relative)).filter((text) => text.length > 0);
  const tools = options.toolsFile === undefined ? undefined : readToolsFile(options.root, options.toolsFile);

  return {
    name: "ishiki.agent-overlay",
    enforce: "post",
    extendInstructions: () => instructions.join("\n\n"),
    transformTools: (current, stage) => (tools === undefined ? current : applyToolsFile(current, tools, stage)),
  };
}

function readOverlay(root: string, relative: string): string {
  const file = resolveInside(root, relative);
  if (!existsSync(file)) throw new Error(`overlay file not found: ${file}`);
  return readFileSync(file, "utf8").trim();
}

function readToolsFile(root: string, relative: string): ToolsFile {
  const file = resolveInside(root, relative);
  if (!existsSync(file)) throw new Error(`tools overlay file not found: ${file}`);
  return parseToolsFile(readFileSync(file, "utf8"), file);
}

function parseToolsFile(source: string, file: string): ToolsFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (match === null) throw new Error(`tools overlay must start with YAML front matter: ${file}`);

  const raw: unknown = parse(match[1]);
  if (!isObject(raw) || raw.version !== 1) throw new Error(`tools overlay version must be 1: ${file}`);
  if (raw.tools === undefined) return { version: 1, tools: new Map() };
  if (!isObject(raw.tools)) throw new Error(`tools overlay "tools" must be an object: ${file}`);

  const tools = new Map<string, ToolPatch>();
  for (const [name, value] of Object.entries(raw.tools)) {
    if (!isObject(value)) throw new Error(`tools overlay entry "${name}" must be an object: ${file}`);
    const description = readDescription(value.description, `tools.${name}.description`, file);
    const parameters = new Map<string, Description>();
    if (value.parameters !== undefined) {
      if (!isObject(value.parameters)) throw new Error(`tools overlay "tools.${name}.parameters" must be an object: ${file}`);
      for (const [parameter, parameterDescription] of Object.entries(value.parameters)) {
        parameters.set(parameter, readDescription(parameterDescription, `tools.${name}.parameters.${parameter}`, file)!);
      }
    }
    tools.set(name, {
      ...(description === undefined ? {} : { description }),
      parameters,
    });
  }
  return { version: 1, tools };
}

function readDescription(value: unknown, field: string, file: string): Description | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw new Error(`tools overlay field "${field}" must be a string or null: ${file}`);
}

function applyToolsFile(current: ToolSet, file: ToolsFile, stage: ToolTransformStage): ToolSet {
  if (file.tools.size === 0) return current;
  const next: ToolSet = { ...current };
  for (const [name, patch] of file.tools) {
    const original = current[name];
    if (original === undefined) {
      if (stage === "complete") throw new Error(`tools overlay references unknown tool "${name}"`);
      continue;
    }
    next[name] = patchTool(original, patch, name);
  }
  return next;
}

function patchTool(original: Tool, patch: ToolPatch, name: string): Tool {
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(original);
  if (patch.description !== undefined) {
    if (patch.description === null) delete descriptors.description;
    else descriptors.description = { configurable: true, enumerable: true, writable: true, value: patch.description };
  }
  if (patch.parameters.size > 0) {
    const inputSchema = original.inputSchema;
    if (!isObject(inputSchema)) throw new Error(`tools overlay cannot patch parameters of tool "${name}" without a JSON schema`);
    const schemaDescriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(inputSchema);
    const jsonSchema = inputSchema.jsonSchema;
    if (!isObject(jsonSchema) || schemaDescriptors.jsonSchema === undefined) {
      throw new Error(`tools overlay cannot patch parameters of tool "${name}" without a JSON schema`);
    }
    const inputDescriptor = descriptors.inputSchema;
    if (inputDescriptor === undefined) throw new Error(`tool "${name}" has no input schema`);
    const patchedSchema = patchSchema(jsonSchema, patch.parameters, name);
    schemaDescriptors.jsonSchema = {
      configurable: true,
      enumerable: true,
      get: () => patchedSchema,
    };
    const transformedSchema = Object.create(Object.getPrototypeOf(inputSchema), schemaDescriptors) as typeof inputSchema;
    descriptors.inputSchema = { ...inputDescriptor, value: transformedSchema };
  }
  return Object.defineProperties({}, descriptors) as Tool;
}

function patchSchema(schema: JsonObject, parameters: ReadonlyMap<string, Description>, toolName: string): JsonObject {
  const cloned: unknown = structuredClone(schema);
  if (!isObject(cloned)) throw new Error(`tool "${toolName}" input schema is not an object`);
  const next = cloned;
  for (const [pathName, description] of parameters) {
    const segments = pathName.split(".");
    if (segments.some((segment) => segment.length === 0)) throw new Error(`tools overlay parameter path is empty for tool "${toolName}"`);
    let node = next;
    for (let index = 0; index < segments.length; index += 1) {
      const properties = node.properties;
      const candidate = isObject(properties) ? properties[segments[index]!] : undefined;
      if (!isObject(candidate)) throw new Error(`tools overlay references unknown parameter "${toolName}.${pathName}"`);
      if (index === segments.length - 1) {
        if (description === null) delete candidate.description;
        else candidate.description = description;
      } else {
        node = candidate;
      }
    }
  }
  return next;
}

function resolveInside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`overlay path must be relative: ${relative}`);
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error(`overlay path escapes profile root: ${relative}`);
  return file;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
