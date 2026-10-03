import { describe, expect, it } from "vitest";

import { resolveProfile, type SceneSpec } from "../src/profile.js";

/** 展开一份配置，断言只看首个 spec —— 三层合并（内置缺省 ← profile ← scene）的全部字段。 */
function makeSpec(profile: Record<string, unknown>, scene: Record<string, unknown> = {}): SceneSpec {
  return resolveProfile(
    {
      model: "test:model",
      ...profile,
      scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"], ...scene } },
    },
    "neko",
  ).specs[0]!;
}

describe("engine config precedence", () => {
  it("都没写时落到各自默认引擎", () => {
    const spec = makeSpec({});
    expect(spec.context.engine).toBe("standard");
    expect(spec.wakeup.engine).toBe("standard");
    expect(spec.toolcall.engine).toBe("native");
  });

  it("profile 写下的引擎与参数原样带过来", () => {
    const spec = makeSpec({
      context: { engine: "standard", standard: { maxTokens: 1234 } },
      wakeup: { engine: "standard", standard: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
    });
    // 断言整块：按引擎名分键，参数留在同名键下
    expect(spec.context).toEqual({ engine: "standard", standard: { maxTokens: 1234 } });
    expect(spec.wakeup).toEqual({ engine: "standard", standard: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } });
  });

  it("scene 可就地覆盖引擎变体，未写字段沿用 profile", () => {
    const spec = makeSpec(
      { wakeup: { engine: "standard", standard: { direct: true, atSelf: true } } },
      { wakeup: { engine: "standard", standard: { atSelf: false } } },
    );
    // 逐键递归合并：scene 只改 atSelf，direct 沿用 profile
    expect(spec.wakeup).toEqual({ engine: "standard", standard: { direct: true, atSelf: false } });
  });

  it("scene 可以整个换掉引擎变体", () => {
    const spec = makeSpec({ wakeup: { engine: "standard" } }, { wakeup: { engine: "v3" } });
    expect(spec.wakeup.engine).toBe("v3");
  });

  it("cross profile 的 spec 带上引擎配置，没有 scene 层", () => {
    const specs = resolveProfile(
      {
        model: "test:model",
        cross: true,
        context: { engine: "standard", standard: { maxTokens: 40_000 } },
        claims: { "onebot:1": { whitelist: ["group:*"] } },
      },
      "neko",
    ).specs;

    expect(specs[0]!.cross).toBe(true);
    expect(specs[0]!.context).toEqual({ engine: "standard", standard: { maxTokens: 40_000 } });
  });

  it("引擎变体的名字不参与准入：带不带 `/` 都只是普通名字，profile 照常展开", () => {
    // 可用性由引擎服务决定（见 extensions.spec.ts），装载期不再拦「名字像扩展包」的变体。
    expect(makeSpec({ wakeup: { engine: "ext/wakeup" } }).wakeup.engine).toBe("ext/wakeup");
    expect(makeSpec({}, { context: { engine: "ext/ctx" } }).context.engine).toBe("ext/ctx");
    expect(makeSpec({}, { context: { engine: "plain" } }).context.engine).toBe("plain");
  });

  it("完整引擎配置保留引擎名与参数块，未写参数块即缺席", () => {
    expect(makeSpec({ context: { engine: "v3", v3: { maxMessages: 7 } } }).context).toEqual({ engine: "v3", v3: { maxMessages: 7 } });
    expect(makeSpec({}).context).toEqual({ engine: "standard" });
  });

  it("toolcall 的覆盖：没写时沿用 profile，显式写回默认引擎时不退回", () => {
    expect(makeSpec({ toolcall: { engine: "v3" } }).toolcall.engine).toBe("v3");
    expect(makeSpec({ toolcall: { engine: "v3" } }, { toolcall: { engine: "native" } }).toolcall.engine).toBe("native");
  });

  it("typing 逐字段合并：scene 只写一个字段，不动 profile 的其余字段", () => {
    const inherit = makeSpec({ typing: { baseDelay: 300 } });
    expect(inherit.typing).toEqual({ baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });

    // 这条是设计的地基：Schema 一旦带上默认值，scene 侧会被填成 `baseDelay: 500` 并顶掉 profile 的 300。
    expect(makeSpec({ typing: { baseDelay: 300 } }, { typing: { charPerSecond: 8 } }).typing).toEqual({
      baseDelay: 300,
      charPerSecond: 8,
      minDelay: 800,
      maxDelay: 4000,
    });
  });

  it("innerThoughts 缺省关闭，profile 与 scene 逐层覆写", () => {
    expect(makeSpec({}).innerThoughts).toBe(false);
    expect(makeSpec({ innerThoughts: true }).innerThoughts).toBe(true);
    expect(makeSpec({ innerThoughts: true }, { innerThoughts: false }).innerThoughts).toBe(false);
  });
});
