import { describe, expect, it } from "vitest";

import { ProfileConfig, matchSceneSpec, resolveProfile, type SceneSpec } from "../src/profile.js";

/**
 * 展开一份树形配置；`raw` 原样喂给 Schema，`id` 是调用方定好的 profile 标识。
 *
 * 入参刻意放宽：Schema 的输入面比解析结果宽——`context` / `wakeup` 解析后必然是个对象，
 * 但 YAML 里可以整块不写，内置缺省会补上。这些用例只关心树的结构，不逐个声明引擎块。
 */
function resolve(raw: { id?: string; presets: Record<string, Record<string, unknown>> }, id = "neko"): SceneSpec[] {
  return resolveProfile(ProfileConfig(raw as never), id).specs;
}

describe("preset tree shape", () => {
  it("普通 preset 挂 scene：每个 scene 一个生效单位，名单与合并结果各自独立", () => {
    const specs = resolve({
      id: "neko",
      presets: {
        chat: {
          model: "gpt",
          typing: { baseDelay: 300 },
          scenes: {
            ops: { sid: "onebot:111", whitelist: ["group:111_ops"] },
            lounge: { sid: "onebot:111", whitelist: ["group:111_lounge"] },
          },
        },
      },
    });

    expect(specs.map((spec) => [spec.name, spec.preset, spec.cross])).toEqual([
      ["ops", "chat", false],
      ["lounge", "chat", false],
    ]);
    // preset 基线逐 scene 复制一份，缺省层仍是内置值
    expect(specs.map((spec) => spec.typing)).toEqual([
      { baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
      { baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
    ]);
    expect(specs.map((spec) => spec.whitelist)).toEqual([["group:111_ops"], ["group:111_lounge"]]);
  });

  it("cross preset 自身即生效单位：配置在 preset 层，频道是各 sid claim 的并集", () => {
    const specs = resolve({
      id: "neko",
      presets: {
        fused: {
          model: "gpt",
          cross: true,
          typing: { baseDelay: 42 },
          claims: {
            "onebot:111": { whitelist: ["group:111_ops", "group:111_chat"] },
            "onebot:222": { whitelist: ["private:*"], blacklist: ["private:9"] },
          },
        },
      },
    });

    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec!.cross).toBe(true);
    expect(spec!.name).toBe("fused");
    expect(spec!.preset).toBe("fused");
    expect(spec!.whitelist).toEqual(["group:111_ops", "group:111_chat", "private:*"]);
    expect(spec!.blacklist).toEqual(["private:9"]);
    expect(spec!.typing).toEqual({ baseDelay: 42, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("普通 preset 与 cross preset 可以在同一 profile 里并存", () => {
    const specs = resolve({
      id: "neko",
      presets: {
        chat: { model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: ["private:*"] } } },
        fused: { model: "gpt", cross: true, claims: { "onebot:111": { whitelist: ["group:111_ops"] } } },
      },
    });

    expect(specs.map((spec) => [spec.name, spec.cross])).toEqual([
      ["dms", false],
      ["fused", true],
    ]);
  });

  it("scene 就地扩展：只影响自己的合并结果，兄弟 scene 保持 preset 基线", () => {
    const specs = resolve({
      id: "neko",
      presets: {
        chat: {
          model: "gpt",
          scenes: {
            ops: { sid: "onebot:111", whitelist: ["group:1"], model: "claude", typing: { charPerSecond: 8 } },
            lounge: { sid: "onebot:111", whitelist: ["group:2"] },
          },
        },
      },
    });

    expect(specs[0]!.model).toBe("claude");
    expect(specs[0]!.typing).toEqual({ baseDelay: 500, charPerSecond: 8, minDelay: 800, maxDelay: 4000 });
    expect(specs[1]!.model).toBe("gpt");
    expect(specs[1]!.typing).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("空 whitelist 是合法的「不认领任何频道」，与缺失不同", () => {
    const specs = resolve({ presets: { chat: { model: "gpt", scenes: { idle: { sid: "onebot:111", whitelist: [] } } } } });

    expect(specs[0]!.whitelist).toEqual([]);
    expect(matchSceneSpec(specs, { sid: "onebot:111", channelId: "group:1" })).toBeUndefined();
  });
});

describe("preset tree validation", () => {
  it("preset 既无 scenes 又非 cross：报空心智", () => {
    expect(() => resolve({ presets: { empty: { model: "gpt" } } })).toThrow(`Preset "empty" of profile "neko" has no scenes and is not cross`);
  });

  it("scenes 写成空块与整个不写同罪：认不出形态", () => {
    expect(() => resolve({ presets: { empty: { model: "gpt", scenes: {} } } })).toThrow("has no scenes and is not cross");
  });

  it("cross: true 且写了 scenes：报互斥", () => {
    expect(() =>
      resolve({
        presets: {
          fused: {
            model: "gpt",
            cross: true,
            scenes: { dms: { sid: "onebot:111", whitelist: ["private:*"] } },
            claims: { "onebot:111": { whitelist: ["group:1"] } },
          },
        },
      }),
    ).toThrow(`Cross preset "fused" of profile "neko" must not have scenes`);
  });

  it("cross: true 缺 claims：报错", () => {
    expect(() => resolve({ presets: { fused: { model: "gpt", cross: true } } })).toThrow(`Cross preset "fused" of profile "neko" needs "claims"`);
  });

  it("scene 缺 sid：报错并指出它在树里的位置", () => {
    expect(() => resolve({ presets: { chat: { model: "gpt", scenes: { dms: { whitelist: ["private:*"] } } } } })).toThrow(
      `Scene "chat/dms" of profile "neko" needs a "sid"`,
    );
  });

  it("scene 缺 whitelist：报错；whitelist: [] 不算缺", () => {
    expect(() => resolve({ presets: { chat: { model: "gpt", scenes: { dms: { sid: "onebot:111" } } } } })).toThrow(
      `Scene "chat/dms" of profile "neko" needs a "whitelist"`,
    );
    expect(() => resolve({ presets: { chat: { model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: [] } } } } })).not.toThrow();
  });

  it("同 sid 下 `*` 与具体 pattern 重叠：报认领冲突", () => {
    expect(() =>
      resolve({
        presets: { chat: { model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["*"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } } } },
      }),
    ).toThrow(`Scene "all" and scene "ops" of profile "neko" both claim channels of "onebot:111"`);
  });

  it("同 sid 下前缀模式与具体值重叠：报认领冲突", () => {
    expect(() =>
      resolve({
        presets: { chat: { model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["group:*"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } } } },
      }),
    ).toThrow("both claim channels");
  });

  it("不同 sid 认领同名频道不算冲突：频道 id 空间按账号分开", () => {
    expect(() =>
      resolve({
        presets: {
          chat: {
            model: "gpt",
            scenes: { a: { sid: "onebot:111", whitelist: ["group:1"] }, b: { sid: "onebot:222", whitelist: ["group:1"] } },
          },
        },
      }),
    ).not.toThrow();
  });

  it("不同前缀各认各的：不算冲突", () => {
    expect(() =>
      resolve({
        presets: {
          chat: {
            model: "gpt",
            scenes: { groups: { sid: "onebot:111", whitelist: ["group:*"] }, dms: { sid: "onebot:111", whitelist: ["private:*"] } },
          },
        },
      }),
    ).not.toThrow();
  });

  it("scene 与 cross claims 交叉：同一份判定，不因形态而例外", () => {
    expect(() =>
      resolve({
        presets: {
          chat: { model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:111_ops"] } } },
          fused: { model: "gpt", cross: true, claims: { "onebot:111": { whitelist: ["group:111_ops"] } } },
        },
      }),
    ).toThrow(`Scene "ops" and scene "fused" of profile "neko" both claim channels of "onebot:111"`);
  });

  it("blacklist 排除后交集为空：仍按白名单相交报冲突（保守判定）", () => {
    expect(() =>
      resolve({
        presets: {
          chat: {
            model: "gpt",
            scenes: { all: { sid: "onebot:111", whitelist: ["group:*"], blacklist: ["group:1"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } },
          },
        },
      }),
    ).toThrow("both claim channels");
  });
});

describe("channel routing across the tree", () => {
  const specs = resolve({
    id: "neko",
    presets: {
      chat: {
        model: "gpt",
        scenes: {
          groups: { sid: "onebot:111", whitelist: ["group:*"], blacklist: ["group:quiet"] },
          dms: { sid: "onebot:111", whitelist: ["private:*"] },
        },
      },
      fused: { model: "gpt", cross: true, claims: { "onebot:222": { whitelist: ["group:*"] }, "onebot:333": { whitelist: ["private:*"] } } },
    },
  });

  const owner = (sid: string, channelId: string) => matchSceneSpec(specs, { sid, channelId })?.name;

  it("普通 scene 按 sid + 名单认领，黑名单照旧排除", () => {
    expect(owner("onebot:111", "group:1")).toBe("groups");
    expect(owner("onebot:111", "group:quiet")).toBeUndefined();
    expect(owner("onebot:111", "private:9")).toBe("dms");
  });

  it("cross 按 claims 逐 sid 认领，换账号仍是同一块生效单位", () => {
    expect(owner("onebot:222", "group:1")).toBe("fused");
    expect(owner("onebot:333", "private:9")).toBe("fused");
    expect(owner("onebot:222", "private:9")).toBeUndefined();
  });

  it("没人认领的频道不落到任何 spec 上", () => {
    expect(owner("onebot:999", "group:1")).toBeUndefined();
  });
});
