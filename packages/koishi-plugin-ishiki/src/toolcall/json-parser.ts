import { JSONRepairError, jsonrepair } from "jsonrepair";
import type { Logger } from "koishi";

export interface JsonParserOptions {
  /** 打开后把诊断逐条写进 logger；无论开关，诊断都留在 `ParseResult.logs` 里。 */
  debug?: boolean;
  logger?: Logger;
}

export interface ParseResult<T> {
  data: T | null;
  error: string | null;
  logs: string[];
}

/** 诊断文本里报错位置的行列号；`position` 是 0 基偏移。 */
function locateAt(source: string, position: number): { line: string; pointer: string } {
  const before = source.slice(0, position).split("\n");
  const line = before[before.length - 1];
  return { line, pointer: `${" ".repeat(line.length)}^` };
}

/**
 * 从模型输出里抠出一个 JSON 对象。完整的 YesImBot v3 `shared/utils/json-parser.ts`。
 *
 * 容错按固定顺序推进，每一步只解决「模型把 JSON 包进散文或代码块」这一件事：
 * 1. 命中 ```json 且整串不以 JSON 开场时优先取代码块内；结尾的 ``` 缺失就取到串尾（截断容错）。
 * 2. 丢弃第一个 `{` / `[` 之前的文字。
 * 3. 只在括号完全平衡时才丢弃最后一个 `}` / `]` 之后的文字——不平衡意味着 JSON 被截断，留着交给修复器。
 * 4. `JSON.parse` 失败交给 `jsonrepair` 再试一次。
 *
 * `data === null` 时 `error` 说明为什么失败，`logs` 记下每一步的判定。
 */
export class JsonParser<T> {
  private readonly debug: boolean;
  private readonly logger?: Logger;
  private logs: string[] = [];

  constructor(options: JsonParserOptions = {}) {
    this.debug = options.debug ?? false;
    this.logger = options.logger;
  }

  parse(rawOutput: string): ParseResult<T> {
    this.logs = [];
    this.log(`开始解析，原始输入长度: ${rawOutput.length}`);

    let processed = rawOutput.trim();
    const codeBlockStart = processed.indexOf("```json");
    const startsAsJson = this.isLikelyJsonStart(processed);

    if (codeBlockStart !== -1 && !startsAsJson) {
      this.log("检测到 Markdown 代码块，且原始字符串不以 JSON 开头，优先提取块内容");
      const codeBlockEnd = processed.lastIndexOf("```");
      // 结尾的 ``` 缺失（输出被截断）时取到串尾，而不是放弃整段。
      let content = codeBlockEnd > codeBlockStart ? processed.substring(codeBlockStart + 3, codeBlockEnd) : processed.substring(codeBlockStart + 3);

      // 剥掉首行的语言标识或前导文字，但首行本身就是 JSON 开头时保留。
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) {
        const firstLine = content.substring(0, firstNewline).trim();
        if (!firstLine.startsWith("{") && !firstLine.startsWith("[")) {
          this.log(`移除了可能的语言标识符或前导文本: "${firstLine}"`);
          content = content.substring(firstNewline + 1);
        }
      }

      processed = content.trim();
      this.log(`从代码块提取并修整后，待处理字符串长度: ${processed.length}`);
    } else if (codeBlockStart !== -1) {
      const codeBlockEnd = processed.lastIndexOf("```");
      if (codeBlockEnd > codeBlockStart) {
        processed = processed.substring(codeBlockStart + 3, codeBlockEnd).trim();
        this.log(`从代码块提取后，待处理字符串长度: ${processed.length}`);
      }
    }

    const firstBrace = processed.indexOf("{");
    const firstBracket = processed.indexOf("[");
    let startIndex = -1;
    if (firstBrace !== -1 && firstBracket !== -1) startIndex = Math.min(firstBrace, firstBracket);
    else if (firstBrace !== -1) startIndex = firstBrace;
    else startIndex = firstBracket;

    if (startIndex === -1) {
      this.log("未找到 JSON 起始符号，将尝试直接修复整个字符串");
    } else if (startIndex > 0) {
      this.log(`在索引 ${startIndex} 处找到 JSON 起始符号，丢弃了前面的 ${startIndex} 个字符`);
      processed = processed.substring(startIndex);
    }

    const count = (pattern: RegExp): number => processed.match(pattern)?.length ?? 0;
    const openBraces = count(/{/g);
    const closeBraces = count(/}/g);
    const openBrackets = count(/\[/g);
    const closeBrackets = count(/]/g);

    if (openBraces === closeBraces && openBrackets === closeBrackets) {
      const endIndex = Math.max(processed.lastIndexOf("}"), processed.lastIndexOf("]"));
      if (endIndex > -1 && endIndex < processed.length - 1) {
        this.log("JSON 结构平衡，裁剪了结束符号之后的多余文本");
        processed = processed.substring(0, endIndex + 1);
      }
    } else {
      this.log(`JSON 结构不平衡 (括号: ${openBrackets}/${closeBrackets}, 大括号: ${openBraces}/${closeBraces})，跳过后缀裁剪以保留可能被截断的数据`);
    }

    if (processed.length === 0) {
      this.log("提取后为空串，判定为解析失败");
      return { data: null, error: "无法找到有效的 JSON 内容", logs: this.logs };
    }

    try {
      let data: T;
      try {
        data = JSON.parse(processed) as T;
      } catch (error) {
        this.log(`直接解析失败: ${error instanceof Error ? error.message : String(error)}`);
        data = JSON.parse(jsonrepair(processed)) as T;
      }

      // 修完只是个字符串或数字，而原始输入里又没有明确的括号起点：那不是我们要的 JSON 值。
      if (typeof data !== "object" && startIndex === -1) {
        this.log("解析结果为非对象类型，但原始输入不像独立的 JSON 值，判定为解析失败");
        return { data: null, error: "无法解析为有效的 JSON 对象或数组", logs: this.logs };
      }

      this.log("解析流程成功完成");
      return { data, error: null, logs: this.logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`最终解析失败: ${message}`);
      if (error instanceof JSONRepairError) {
        const { line, pointer } = locateAt(processed, error.position);
        this.log(line);
        this.log(pointer);
      }
      return { data: null, error: message, logs: this.logs };
    }
  }

  /**
   * 整串是否看起来以 JSON 结构开场。解决 `[OBSERVE]` 这类文字被当成 JSON 数组的问题：
   * `[` 之后必须紧跟值（对象、字符串、`t`/`f`/`n`、数字）或 `]`，否则不认。
   */
  private isLikelyJsonStart(str: string): boolean {
    const trimmed = str.trim();
    if (trimmed.startsWith("{")) return true;
    if (!trimmed.startsWith("[")) return false;

    const next = trimmed.substring(1).trim().charAt(0);
    if (next === "]" || next === "{" || next === '"' || next === "t" || next === "f" || next === "n" || next === "-") return true;
    return next >= "0" && next <= "9";
  }

  private log(message: string): void {
    if (this.debug) this.logger?.debug(message);
    this.logs.push(message);
  }
}
