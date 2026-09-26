/**
 * `@ai-sdk-tool/parser` 的装载点。
 *
 * 该包只导出 ESM（`exports` 里没有 `require` 条件），而本插件交给 koishi 的是 CJS 产物。
 * 打包器会把静态 import 与字面量动态 import 都降级成 `require`，CJS 解析器随即
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`。所以说明符走变量：打包器解析不了，`import()` 原样保留，
 * 由运行时解析（Node 的 CJS 加载器支持用 `import()` 载入 ESM）。
 */
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

/** 解析库的模块面：只列本插件实际调用的入口，各成员直接取库里的签名。 */
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

/** 变量说明符：打包器静态解析不到，`import()` 才能活到 CJS 产物里。 */
const PARSER_PACKAGE = "@ai-sdk-tool/parser";

let loading: Promise<Parser> | undefined;
let loaded: Parser | undefined;

/** 装载解析库；重复调用共用同一次 import。 */
export function loadParser(): Promise<Parser> {
  loading ??= (import(PARSER_PACKAGE) as Promise<Parser>).then((module) => {
    loaded = module;
    return module;
  });
  return loading;
}

/** 取已装载的解析库。没先 await {@link loadParser} 就是装配顺序错了，直接抛错而不静默降级。 */
export function parser(): Parser {
  if (loaded === undefined) throw new Error("@ai-sdk-tool/parser 尚未装载：装配协议引擎前需先 await loadParser()");
  return loaded;
}
