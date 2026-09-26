import { describe, expect, it } from "vitest";

import { JsonParser } from "../src/toolcall/json-parser.js";

/** 契约形状：`thoughts` 三段 + `actions`；解析器本身与形状无关，用真实形状当夹具。 */
interface ClassicOutput {
  thoughts: { observe: string; analyze_infer: string; plan: string };
  actions: Array<{ function: string; params: Record<string, unknown> }>;
}

const parser = new JsonParser<ClassicOutput>();
const looseParser = new JsonParser<unknown>();

/** 诊断里是否出现过某段判定；v3 的 logs 是给人看的，只断言关键措辞。 */
function logged(result: { logs: string[] }, fragment: string): boolean {
  return result.logs.some((line) => line.includes(fragment));
}

describe("JsonParser: 干净输入", () => {
  it("解析格式化好的对象，前后空白无影响", () => {
    const result = parser.parse(`
      {
        "thoughts": { "observe": "看到一条消息", "analyze_infer": "只是问候", "plan": "回一句" },
        "actions": [{ "function": "send_message", "params": { "message": "在的" } }]
      }`);

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      thoughts: { observe: "看到一条消息", analyze_infer: "只是问候", plan: "回一句" },
      actions: [{ function: "send_message", params: { message: "在的" } }],
    });
  });

  it("数组与非对象值照原样解析", () => {
    const array = looseParser.parse(`[{"a": 1}, {"b": 2}]`);
    expect(array.error).toBeNull();
    expect(array.data).toEqual([{ a: 1 }, { b: 2 }]);

    expect(parser.parse("{}").data).toEqual({});
  });
});

describe("JsonParser: 代码块", () => {
  it("整串以文字开场时优先取 ```json 块内", () => {
    const result = parser.parse('好的：\n```json\n{"thoughts": {"observe": "a", "analyze_infer": "", "plan": ""}, "actions": []}\n```\n用完请查收。');

    expect(result.error).toBeNull();
    expect(result.data?.actions).toEqual([]);
    expect(logged(result, "优先提取块内容")).toBe(true);
  });

  it("无语言标识的代码块靠「找括号」隐式处理", () => {
    const result = parser.parse('好的：\n```\n{"thoughts": {"observe": "a", "analyze_infer": "", "plan": ""}, "actions": []}\n```');
    expect(result.error).toBeNull();
    expect(result.data?.thoughts.observe).toBe("a");
  });

  it("字符串值里出现代码块时不误取", () => {
    const result = parser.parse('{"thoughts": {"observe": "示例", "analyze_infer": "```js\\nconsole.log(1)\\n```", "plan": ""}, "actions": []}');

    expect(result.error).toBeNull();
    expect(result.data?.thoughts.analyze_infer).toContain("```js");
    expect(logged(result, "优先提取块内容")).toBe(false);
  });

  it("代码块结尾缺失（输出被截断）时取到串尾", () => {
    const result = parser.parse('```json\n{"thoughts": {"observe": "a", "analyze_infer": "b", "plan": "c"}, "actions": []}');

    expect(result.error).toBeNull();
    expect(result.data?.thoughts.plan).toBe("c");
  });

  it("代码块之后的文字被丢掉", () => {
    const result = parser.parse('```json\n{"thoughts": {"observe": "a", "analyze_infer": "", "plan": ""}, "actions": []}\n```\n希望有帮助。');
    expect(result.error).toBeNull();
    expect(result.data?.thoughts.observe).toBe("a");
  });
});

describe("JsonParser: 前言与结语", () => {
  it("丢掉第一个 { 之前的文字", () => {
    const result = parser.parse('思考过程：用户要的是问候。\n{"thoughts": {"observe": "a", "analyze_infer": "", "plan": ""}, "actions": []}');

    expect(result.error).toBeNull();
    expect(result.data?.thoughts.observe).toBe("a");
    expect(logged(result, "找到 JSON 起始符号")).toBe(true);
  });

  it("以 `[OBSERVE]` 开场时不当成 JSON 数组", () => {
    const result = parser.parse('[OBSERVE]\n观察完了。\n[ACT]\n\n```json\n{"thoughts": {"observe": "a", "analyze_infer": "", "plan": ""}, "actions": []}\n```');

    expect(result.error).toBeNull();
    expect(result.data?.thoughts.observe).toBe("a");
  });

  it("只在括号平衡时才裁剪结语", () => {
    const balanced = looseParser.parse('{"a": 1} 这是多余的说明。');
    expect(balanced.data).toEqual({ a: 1 });
    expect(logged(balanced, "结构平衡")).toBe(true);

    const truncated = looseParser.parse('{"a": 1, "b": "还没写完"');
    expect(truncated.data).toEqual({ a: 1, b: "还没写完" });
    expect(logged(truncated, "跳过后缀裁剪")).toBe(true);
  });
});

describe("JsonParser: jsonrepair 兜底", () => {
  it("修缺失的右大括号", () => {
    expect(looseParser.parse('{"a": 1, "b": [2, 3]').data).toEqual({ a: 1, b: [2, 3] });
  });

  it("修缺失的右中括号", () => {
    expect(looseParser.parse('{"a": ["x", "y"').data).toEqual({ a: ["x", "y"] });
  });

  it("修多层未闭合", () => {
    expect(looseParser.parse('{"user": {"name": "n", "tags": ["a", "b"').data).toEqual({ user: { name: "n", tags: ["a", "b"] } });
  });

  it("修被截断的字符串值", () => {
    expect(looseParser.parse('{"a": "未闭合').data).toEqual({ a: "未闭合" });
  });

  it("悬垂键补成 null", () => {
    expect(looseParser.parse('{"a": 1, "b":').data).toEqual({ a: 1, b: null });
  });

  it("前言 + 代码块 + 截断一起上", () => {
    const result = looseParser.parse('这是输出：\n```json\n{"name": "复杂", "data": {"items": ["i1"]}, "status": "未完');
    expect(result.data).toEqual({ name: "复杂", data: { items: ["i1"] }, status: "未完" });
  });

  it("修尾随逗号", () => {
    expect(looseParser.parse('{"a": 1, "b": 2,}').data).toEqual({ a: 1, b: 2 });
  });
});

describe("JsonParser: 失败面", () => {
  it("完全没有 JSON 时返回错误而不是异常", () => {
    const result = parser.parse("这是一个完全无关的字符串，没有 JSON。");

    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(logged(result, "未找到 JSON 起始符号")).toBe(true);
  });

  it("空串与纯空白返回错误", () => {
    expect(parser.parse("").data).toBeNull();
    expect(parser.parse("   \n\t ").data).toBeNull();
    expect(parser.parse("").error).not.toBeNull();
  });

  it("没有明确括号起点时，裸字符串与裸数字不算成功", () => {
    expect(parser.parse('"just a string"').data).toBeNull();
    expect(parser.parse("12345").data).toBeNull();
    expect(parser.parse('"just a string"').error).toBe("无法解析为有效的 JSON 对象或数组");
  });
});
