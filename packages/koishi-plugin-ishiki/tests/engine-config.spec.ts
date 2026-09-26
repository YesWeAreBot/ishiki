import { describe, expect, it } from "vitest";

import { ProfileConfig, resolveProfile } from "../src/profile.js";

/**
 * 引擎配置的继承规则：scene 没写引擎块就沿用 preset，同名引擎合并参数，换名整体替换，
 * 两边都没写就落到该家族的默认引擎。
 *
 * preset 落到 `native` / `standard` 依赖 `resolveScene` 的兜底而不是 Schema 的默认值：
 * 一旦 Schema 为空缺的块物化出 `{ engine: … }`，它就会被当成 scene 的显式覆写，preset 永远轮不到。
 */
function specOf(preset: Record<string, unknown>, scene: Record<string, unknown> = {}) {
  const config = ProfileConfig({
    id: "neko",
    presets: { base: { model: "test:model", ...preset } },
    scenes: { dms: { preset: "base", sid: "onebot:1", ...scene } },
  });
  return resolveProfile(config, "neko")[0]!;
}

describe("engine config precedence", () => {
  it("两者都没写时落到各自默认引擎", () => {
    const spec = specOf({});
    expect(spec.context.engine).toBe("standard");
    expect(spec.wakeup.engine).toBe("standard");
    expect(spec.toolcall.engine).toBe("native");
    expect(spec.typing).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("typing 逐字段合并：scene 只写一个字段，不动 preset 的其余字段", () => {
    const inherit = specOf({ typing: { baseDelay: 300 } });
    expect(inherit.typing).toEqual({ baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });

    // 这条是设计的地基：Schema 一旦带上默认值，scene 侧会被填成 `baseDelay: 500` 并顶掉 preset 的 300。
    const override = specOf({ typing: { baseDelay: 300 } }, { typing: { charPerSecond: 8 } });
    expect(override.typing).toEqual({ baseDelay: 300, charPerSecond: 8, minDelay: 800, maxDelay: 4000 });
  });

  it("scene 没写引擎块时沿用 preset 的引擎与参数", () => {
    const spec = specOf({
      context: { engine: "standard", standard: { maxChars: 1234 } },
      wakeup: { engine: "standard", standard: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
      toolcall: { engine: "classic" },
    });
    expect(spec.context.standard).toEqual({ maxChars: 1234, refillRatio: undefined });
    expect(spec.wakeup.standard!.direct).toBe(false);
    expect(spec.toolcall.engine).toBe("classic");
  });

  it("scene 写同名引擎时合并参数，换引擎时整体替换", () => {
    const same = specOf(
      { context: { engine: "standard", standard: { maxChars: 1234, refillRatio: 0.5 } } },
      { context: { engine: "standard", standard: { maxChars: 4321 } } },
    );
    expect(same.context.standard).toEqual({ maxChars: 4321, refillRatio: 0.5 });

    const replaced = specOf({ toolcall: { engine: "classic" } }, { toolcall: { engine: "hermes" } });
    expect(replaced.toolcall.engine).toBe("hermes");
  });

  it("scene 显式写回默认引擎时不退回 preset", () => {
    const spec = specOf({ toolcall: { engine: "classic" } }, { toolcall: { engine: "native" } });
    expect(spec.toolcall.engine).toBe("native");
  });

  it("innerThoughts 缺省关闭，preset 与 scene 逐层覆写", () => {
    expect(specOf({}).innerThoughts).toBe(false);
    expect(specOf({ innerThoughts: true }).innerThoughts).toBe(true);
    expect(specOf({ innerThoughts: true }, { innerThoughts: false }).innerThoughts).toBe(false);
  });
});
