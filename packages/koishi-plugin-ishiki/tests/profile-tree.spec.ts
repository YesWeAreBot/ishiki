import { describe, expect, it } from "vitest";

import { matchSceneSpec, resolveProfile, type SceneSpec } from "../src/profile.js";

/**
 * 展开一份树形配置并拍平各 preset 的 spec；`raw` 是原始配置对象，`id` 是目录名兜底。
 *
 * 入参刻意放宽：Schema 的输入面比解析结果宽——`context` / `wakeup` 解析后必然是个对象，
 * 但 YAML 里可以整块不写，内置缺省会补上。这些用例只关心树的结构，不逐个声明引擎块。
 */
function resolve(raw: Record<string, unknown>, id = "neko"): SceneSpec[] {
  return resolveProfile(raw, id).presets.flatMap((preset) => preset.specs);
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
  it("坏 preset 只跳过自己：兄弟 preset 照常展开，原因留在 skipped 里", () => {
    const result = resolveProfile(
      {
        presets: {
          empty: { model: "gpt" },
          chat: { model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: ["private:*"] } } },
        },
      },
      "neko",
    );

    expect(result.presets.map((preset) => preset.name)).toEqual(["chat"]);
    expect(result.presets[0]!.specs.map((spec) => spec.name)).toEqual(["dms"]);
    expect(result.skipped).toEqual([{ preset: "empty", message: `Preset "empty" of profile "neko" has no scenes and is not cross` }]);
  });

  it("preset 的 Schema 错误同样只跳过自己", () => {
    const result = resolveProfile(
      {
        presets: {
          bad: { model: 42 },
          chat: { model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: [] } } },
        },
      },
      "neko",
    );

    expect(result.presets.map((preset) => preset.name)).toEqual(["chat"]);
    expect(result.skipped.map((skip) => skip.preset)).toEqual(["bad"]);
  });

  it("Profile 根结构错误：整个 profile 失败，没有可展开的 preset", () => {
    expect(() => resolveProfile({}, "neko")).toThrow(/presets/);
    expect(() => resolveProfile({ presets: [] }, "neko")).toThrow(/presets/);
    expect(() => resolveProfile({ id: 42, presets: {} }, "neko")).toThrow(/id/);
  });

  it("scenes 写成空块与整个不写同罪：认不出形态", () => {
    const result = resolveProfile({ presets: { empty: { model: "gpt", scenes: {} } } }, "neko");

    expect(result.presets).toEqual([]);
    expect(result.skipped[0]!.message).toContain("has no scenes and is not cross");
  });

  it("cross: true 且写了 scenes：报互斥", () => {
    const result = resolveProfile(
      {
        presets: {
          fused: {
            model: "gpt",
            cross: true,
            scenes: { dms: { sid: "onebot:111", whitelist: ["private:*"] } },
            claims: { "onebot:111": { whitelist: ["group:1"] } },
          },
        },
      },
      "neko",
    );

    expect(result.skipped[0]!.message).toBe(`Cross preset "fused" of profile "neko" must not have scenes`);
  });

  it("cross: true 缺 claims：报错", () => {
    const result = resolveProfile({ presets: { fused: { model: "gpt", cross: true } } }, "neko");

    expect(result.skipped[0]!.message).toBe(`Cross preset "fused" of profile "neko" needs "claims"`);
  });

  it("scene 缺 sid：报错并指出它在树里的位置", () => {
    const result = resolveProfile({ presets: { chat: { model: "gpt", scenes: { dms: { whitelist: ["private:*"] } } } } }, "neko");

    expect(result.skipped[0]!.message).toBe(`Scene "chat/dms" of profile "neko" needs a "sid"`);
  });

  it("scene 缺 whitelist：报错；whitelist: [] 不算缺", () => {
    const missing = resolveProfile({ presets: { chat: { model: "gpt", scenes: { dms: { sid: "onebot:111" } } } } }, "neko");
    expect(missing.skipped[0]!.message).toBe(`Scene "chat/dms" of profile "neko" needs a "whitelist"`);

    const empty = resolveProfile({ presets: { chat: { model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: [] } } } } }, "neko");
    expect(empty.presets[0]!.specs).toHaveLength(1);
  });

  it("同 sid 下 `*` 与具体 pattern 重叠：该 preset 被跳过", () => {
    const result = resolveProfile(
      {
        presets: { chat: { model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["*"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } } } },
      },
      "neko",
    );

    expect(result.presets).toEqual([]);
    expect(result.skipped[0]!.message).toBe(`Scene "chat/all" and scene "chat/ops" of profile "neko" both claim channels of "onebot:111"`);
  });

  it("同 sid 下前缀模式与具体值重叠：该 preset 被跳过", () => {
    const result = resolveProfile(
      {
        presets: { chat: { model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["group:*"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } } } },
      },
      "neko",
    );

    expect(result.skipped[0]!.message).toContain("both claim channels");
  });

  it("不同 sid 认领同名频道不算冲突：频道 id 空间按账号分开", () => {
    const result = resolveProfile(
      {
        presets: {
          chat: {
            model: "gpt",
            scenes: { a: { sid: "onebot:111", whitelist: ["group:1"] }, b: { sid: "onebot:222", whitelist: ["group:1"] } },
          },
        },
      },
      "neko",
    );

    expect(result.skipped).toEqual([]);
    expect(result.presets[0]!.specs).toHaveLength(2);
  });

  it("不同前缀各认各的：不算冲突", () => {
    const result = resolveProfile(
      {
        presets: {
          chat: {
            model: "gpt",
            scenes: { groups: { sid: "onebot:111", whitelist: ["group:*"] }, dms: { sid: "onebot:111", whitelist: ["private:*"] } },
          },
        },
      },
      "neko",
    );

    expect(result.skipped).toEqual([]);
    expect(result.presets[0]!.specs).toHaveLength(2);
  });

  it("preset 之间认领同一频道：整个 profile 无法装载", () => {
    expect(() =>
      resolveProfile(
        {
          presets: {
            chat: { model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:111_ops"] } } },
            fused: { model: "gpt", cross: true, claims: { "onebot:111": { whitelist: ["group:111_ops"] } } },
          },
        },
        "neko",
      ),
    ).toThrow(`Scene "chat/ops" and scene "fused/fused" of profile "neko" both claim channels of "onebot:111"`);
  });

  it("blacklist 排除后交集为空：仍按白名单相交报冲突（保守判定）", () => {
    const result = resolveProfile(
      {
        presets: {
          chat: {
            model: "gpt",
            scenes: { all: { sid: "onebot:111", whitelist: ["group:*"], blacklist: ["group:1"] }, ops: { sid: "onebot:111", whitelist: ["group:1"] } },
          },
        },
      },
      "neko",
    );

    expect(result.skipped[0]!.message).toContain("both claim channels");
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
