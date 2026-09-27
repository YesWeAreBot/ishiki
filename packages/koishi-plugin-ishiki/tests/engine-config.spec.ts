import { describe, expect, it } from "vitest";

import { ProfileConfig, resolveProfile, type PresetEngineConfig, type SceneSpec } from "../src/profile.js";

/** 展开一份树，断言只看 spec —— 配置面除引擎外都归 scene 层的三层合并。 */
function makeSpec(preset: Record<string, unknown>, scene: Record<string, unknown> = {}): SceneSpec {
  return resolveProfile(
    ProfileConfig({
      id: "neko",
      presets: { base: { model: "test:model", ...preset, scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"], ...scene } } } },
    }),
    "neko",
  ).specs[0]!;
}

/** 同一个形状，但断言看的是 preset 级的引擎表。 */
function makeEngines(preset: Record<string, unknown>): PresetEngineConfig {
  return resolveProfile(
    ProfileConfig({
      id: "neko",
      presets: { base: { model: "test:model", ...preset, scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } } } },
    }),
    "neko",
  ).engines.base!;
}

describe("engine config precedence", () => {
  it("都没写时落到各自默认引擎", () => {
    const engines = makeEngines({});
    expect(engines.context.engine).toBe("standard");
    expect(engines.wakeup.engine).toBe("standard");
    expect(makeSpec({}).toolcall.engine).toBe("native");
  });

  it("preset 写下的引擎与参数原样带过来", () => {
    const engines = makeEngines({
      context: { engine: "standard", standard: { maxChars: 1234 } },
      wakeup: { engine: "standard", standard: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } },
    });
    // 断言整块：按引擎名分键，参数留在同名键下
    expect(engines.context).toEqual({ engine: "standard", standard: { maxChars: 1234 } });
    expect(engines.wakeup).toEqual({ engine: "standard", standard: { direct: false, atSelf: false, quoteSelf: false, keywords: [] } });
  });

  it("形态带给装配侧：cross preset 的上下文引擎要开寻址头", () => {
    const config = ProfileConfig({
      id: "neko",
      presets: {
        lounge: { model: "test:model", cross: true, claims: { "onebot:1": { whitelist: ["group:*"] } } },
        base: { model: "test:model", scenes: { dms: { sid: "onebot:1", whitelist: ["private:*"] } } },
      },
    });
    const { engines } = resolveProfile(config, "neko");
    expect(engines.lounge!.cross).toBe(true);
    expect(engines.base!.cross).toBe(false);
  });

  it("spec 上没有引擎可读：一份 spec 指回它所属的 preset", () => {
    const spec = makeSpec({ context: { engine: "standard", standard: { maxChars: 10_000 } } });
    expect(spec).not.toHaveProperty("context");
    expect(spec).not.toHaveProperty("wakeup");
    expect(spec.preset).toBe("base");
    // preset 写的那份一路带到引擎表，没在 scene 上丢
    expect(makeEngines({ context: { engine: "standard", standard: { maxChars: 10_000 } } }).context).toEqual({
      engine: "standard",
      standard: { maxChars: 10_000 },
    });
  });

  it("toolcall 仍是 scene 层的：没写时沿用 preset，显式写回默认引擎时不退回", () => {
    expect(makeSpec({ toolcall: { engine: "classic" } }).toolcall.engine).toBe("classic");
    expect(makeSpec({ toolcall: { engine: "classic" } }, { toolcall: { engine: "native" } }).toolcall.engine).toBe("native");
  });

  it("typing 逐字段合并：scene 只写一个字段，不动 preset 的其余字段", () => {
    const inherit = makeSpec({ typing: { baseDelay: 300 } });
    expect(inherit.typing).toEqual({ baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });

    // 这条是设计的地基：Schema 一旦带上默认值，scene 侧会被填成 `baseDelay: 500` 并顶掉 preset 的 300。
    expect(makeSpec({ typing: { baseDelay: 300 } }, { typing: { charPerSecond: 8 } }).typing).toEqual({
      baseDelay: 300,
      charPerSecond: 8,
      minDelay: 800,
      maxDelay: 4000,
    });
  });

  it("innerThoughts 缺省关闭，preset 与 scene 逐层覆写", () => {
    expect(makeSpec({}).innerThoughts).toBe(false);
    expect(makeSpec({ innerThoughts: true }).innerThoughts).toBe(true);
    expect(makeSpec({ innerThoughts: true }, { innerThoughts: false }).innerThoughts).toBe(false);
  });
});
