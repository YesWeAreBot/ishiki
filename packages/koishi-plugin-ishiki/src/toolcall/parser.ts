import type {
  createToolMiddleware,
  formatToolResponseAsHermes,
  formatToolResponseAsQwen3CoderXml,
  formatToolResponseAsYaml,
  hermesProtocol,
  hermesSystemPromptTemplate,
  morphFormatToolResponseAsXml,
  morphXmlProtocol,
  morphXmlSystemPromptTemplate,
  qwen3CoderProtocol,
  qwen3coderSystemPromptTemplate,
  yamlXmlProtocol,
  yamlXmlSystemPromptTemplate,
} from "@ai-sdk-tool/parser";

export type { TCMProtocol, ToolResponsePromptTemplateResult } from "@ai-sdk-tool/parser";

export interface Parser {
  createToolMiddleware: typeof createToolMiddleware;
  formatToolResponseAsHermes: typeof formatToolResponseAsHermes;
  formatToolResponseAsQwen3CoderXml: typeof formatToolResponseAsQwen3CoderXml;
  formatToolResponseAsYaml: typeof formatToolResponseAsYaml;
  hermesProtocol: typeof hermesProtocol;
  hermesSystemPromptTemplate: typeof hermesSystemPromptTemplate;
  morphFormatToolResponseAsXml: typeof morphFormatToolResponseAsXml;
  morphXmlProtocol: typeof morphXmlProtocol;
  morphXmlSystemPromptTemplate: typeof morphXmlSystemPromptTemplate;
  qwen3CoderProtocol: typeof qwen3CoderProtocol;
  qwen3coderSystemPromptTemplate: typeof qwen3coderSystemPromptTemplate;
  yamlXmlProtocol: typeof yamlXmlProtocol;
  yamlXmlSystemPromptTemplate: typeof yamlXmlSystemPromptTemplate;
}

const PARSER_PACKAGE = "@ai-sdk-tool/parser";

let loading: Promise<Parser> | undefined;
let loaded: Parser | undefined;

export function loadParser(): Promise<Parser> {
  loading ??= (import(PARSER_PACKAGE) as Promise<Parser>).then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

export function parser(): Parser {
  if (loaded === undefined) throw new Error("@ai-sdk-tool/parser 尚未装载：装配协议引擎前需先 await loadParser()");
  return loaded;
}
