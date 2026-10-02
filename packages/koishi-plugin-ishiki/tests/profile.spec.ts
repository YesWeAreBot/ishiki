import { describe, expect, it } from "vitest";

import { assertNoOverlap, matchSceneSpec, resolveProfile, type SceneSpec } from "../src/profile.js";

/**
 * 展开一份 profile 配置并取出生效单位清单；`raw` 是原始配置对象，`id` 是目录名，也就是 profile 的 id。
 *
 * 入参刻意放宽：Schema 的输入面比解析结果宽——`context` / `wakeup` 解析后必然是个对象，
 * 但 YAML 里可以整块不写，内置缺省会补上。这些用例只关心配置面到 spec 的展开，不逐个声明引擎块。
 */
function resolve(raw: Record<string, unknown>, id = "neko"): SceneSpec[] {
  return resolveProfile(raw, id).specs;
}

describe("profile tree shape", () => {
  it("普通 profile 挂 scene：每个 scene 一个生效单位，名单与合并结果各自独立", () => {
    const specs = resolve({
      model: "gpt",
      typing: { baseDelay: 300 },
      scenes: {
        ops: { sid: "onebot:111", whitelist: ["group:111_ops"] },
        lounge: { sid: "onebot:111", whitelist: ["group:111_lounge"] },
      },
    });

    expect(specs.map((spec) => [spec.name, spec.profile, spec.cross])).toEqual([
      ["ops", "neko", false],
      ["lounge", "neko", false],
    ]);
    // profile 基线逐 scene 复制一份，缺省层仍是内置值
    expect(specs.map((spec) => spec.typing)).toEqual([
      { baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
      { baseDelay: 300, charPerSecond: 5, minDelay: 800, maxDelay: 4000 },
    ]);
    expect(specs.map((spec) => spec.whitelist)).toEqual([["group:111_ops"], ["group:111_lounge"]]);
  });

  it("cross profile 自身即生效单位：配置在 profile 层，频道是各 sid claim 的并集", () => {
    const specs = resolve({
      model: "gpt",
      cross: true,
      typing: { baseDelay: 42 },
      claims: {
        "onebot:111": { whitelist: ["group:111_ops", "group:111_chat"] },
        "onebot:222": { whitelist: ["private:*"], blacklist: ["private:9"] },
      },
    });

    expect(specs).toHaveLength(1);
    const [spec] = specs;
    expect(spec!.cross).toBe(true);
    expect(spec!.name).toBe("cross");
    expect(spec!.profile).toBe("neko");
    expect(spec!.whitelist).toEqual(["group:111_ops", "group:111_chat", "private:*"]);
    expect(spec!.blacklist).toEqual(["private:9"]);
    expect(spec!.typing).toEqual({ baseDelay: 42, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("scene 就地扩展：只影响自己的合并结果，兄弟 scene 保持 profile 基线", () => {
    const specs = resolve({
      model: "gpt",
      scenes: {
        ops: { sid: "onebot:111", whitelist: ["group:1"], model: "claude", typing: { charPerSecond: 8 } },
        lounge: { sid: "onebot:111", whitelist: ["group:2"] },
      },
    });

    expect(specs[0]!.model).toBe("claude");
    expect(specs[0]!.typing).toEqual({ baseDelay: 500, charPerSecond: 8, minDelay: 800, maxDelay: 4000 });
    expect(specs[1]!.model).toBe("gpt");
    expect(specs[1]!.typing).toEqual({ baseDelay: 500, charPerSecond: 5, minDelay: 800, maxDelay: 4000 });
  });

  it("空 whitelist 是合法的「不认领任何频道」，与缺失不同", () => {
    const specs = resolve({ model: "gpt", scenes: { idle: { sid: "onebot:111", whitelist: [] } } });

    expect(specs[0]!.whitelist).toEqual([]);
    expect(matchSceneSpec(specs, { sid: "onebot:111", channelId: "group:1" })).toBeUndefined();
  });
});

describe("profile tree validation", () => {
  it("缺 scenes 又非 cross：resolveProfile 抛错，整个 profile 失败", () => {
    expect(() => resolveProfile({ model: "gpt" }, "neko")).toThrow(`Profile "neko" has no scenes and is not cross`);
  });

  it("Schema 错误：resolveProfile 抛错并指出字段", () => {
    expect(() => resolveProfile({ model: 42, scenes: { dms: { sid: "onebot:111", whitelist: [] } } }, "neko")).toThrow(/model/);
  });

  it("Profile 根结构错误：整个 profile 失败，没有可展开的生效单位", () => {
    expect(() => resolveProfile({}, "neko")).toThrow(/model/);
    expect(() => resolveProfile({ model: "gpt", scenes: [] }, "neko")).toThrow(/scenes/);
    expect(() => resolveProfile({ model: "gpt", scenes: "dms" }, "neko")).toThrow(/scenes/);
  });

  it("scenes 写成空块与整个不写同罪：认不出形态", () => {
    expect(() => resolveProfile({ model: "gpt", scenes: {} }, "neko")).toThrow(`Profile "neko" has no scenes and is not cross`);
  });

  it("cross: true 且写了 scenes：报互斥", () => {
    expect(() =>
      resolveProfile(
        {
          model: "gpt",
          cross: true,
          scenes: { dms: { sid: "onebot:111", whitelist: ["private:*"] } },
          claims: { "onebot:111": { whitelist: ["group:1"] } },
        },
        "neko",
      ),
    ).toThrow(`Cross profile "neko" must not have scenes`);
  });

  it("cross: true 缺 claims：报错", () => {
    expect(() => resolveProfile({ model: "gpt", cross: true }, "neko")).toThrow(`Cross profile "neko" needs "claims"`);
  });

  it("scene 缺 sid：报错并指出它在树里的位置", () => {
    expect(() => resolveProfile({ model: "gpt", scenes: { dms: { whitelist: ["private:*"] } } }, "neko")).toThrow(`Scene "neko/dms" needs a "sid"`);
  });

  it("scene 缺 whitelist：报错；whitelist: [] 不算缺", () => {
    expect(() => resolveProfile({ model: "gpt", scenes: { dms: { sid: "onebot:111" } } }, "neko")).toThrow(`Scene "neko/dms" needs a "whitelist"`);

    const specs = resolve({ model: "gpt", scenes: { dms: { sid: "onebot:111", whitelist: [] } } });
    expect(specs).toHaveLength(1);
  });

  it("跨 profile 下 `*` 与具体 pattern 重叠：assertNoOverlap 报出冲突", () => {
    const broad = resolve({ model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["*"] } } }, "neko");
    const narrow = resolve({ model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:1"] } } }, "other");

    expect(() => assertNoOverlap([...broad, ...narrow])).toThrow(`Scene "neko/all" and scene "other/ops" both claim channels of "onebot:111"`);
  });

  it("跨 profile 下前缀模式与具体值重叠：同样报冲突", () => {
    const broad = resolve({ model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["group:*"] } } }, "neko");
    const narrow = resolve({ model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:1"] } } }, "other");

    expect(() => assertNoOverlap([...broad, ...narrow])).toThrow("both claim channels");
  });

  it("不同 sid 认领同名频道不算冲突：频道 id 空间按账号分开", () => {
    const specs = resolve({
      model: "gpt",
      scenes: { a: { sid: "onebot:111", whitelist: ["group:1"] }, b: { sid: "onebot:222", whitelist: ["group:1"] } },
    });

    expect(specs).toHaveLength(2);
    expect(() => assertNoOverlap(specs)).not.toThrow();
  });

  it("不同前缀各认各的：不算冲突", () => {
    const specs = resolve({
      model: "gpt",
      scenes: { groups: { sid: "onebot:111", whitelist: ["group:*"] }, dms: { sid: "onebot:111", whitelist: ["private:*"] } },
    });

    expect(specs).toHaveLength(2);
    expect(() => assertNoOverlap(specs)).not.toThrow();
  });

  it("不同 profile 认领同一频道：整个 profile 无法装载", () => {
    const chat = resolve({ model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:111_ops"] } } }, "neko");
    const fused = resolve({ model: "gpt", cross: true, claims: { "onebot:111": { whitelist: ["group:111_ops"] } } }, "fused");

    expect(() => assertNoOverlap([...chat, ...fused])).toThrow(`Scene "neko/ops" and scene "fused/cross" both claim channels of "onebot:111"`);
  });

  it("同一个 profile 内两个 scene 撞上同一频道：同样报冲突", () => {
    const specs = resolve({
      model: "gpt",
      scenes: { a: { sid: "onebot:111", whitelist: ["group:*"] }, b: { sid: "onebot:111", whitelist: ["group:1"] } },
    });

    expect(() => assertNoOverlap(specs)).toThrow(`Scene "neko/a" and scene "neko/b" both claim channels of "onebot:111"`);
  });

  it("blacklist 排除后交集为空：仍按白名单相交报冲突（保守判定）", () => {
    const broad = resolve({ model: "gpt", scenes: { all: { sid: "onebot:111", whitelist: ["group:*"], blacklist: ["group:1"] } } }, "neko");
    const narrow = resolve({ model: "gpt", scenes: { ops: { sid: "onebot:111", whitelist: ["group:1"] } } }, "other");

    expect(() => assertNoOverlap([...broad, ...narrow])).toThrow("both claim channels");
  });
});

describe("channel routing across specs", () => {
  const specs = [
    ...resolve(
      {
        model: "gpt",
        scenes: {
          groups: { sid: "onebot:111", whitelist: ["group:*"], blacklist: ["group:quiet"] },
          dms: { sid: "onebot:111", whitelist: ["private:*"] },
        },
      },
      "neko",
    ),
    ...resolve({ model: "gpt", cross: true, claims: { "onebot:222": { whitelist: ["group:*"] }, "onebot:333": { whitelist: ["private:*"] } } }, "fused"),
  ];

  const owner = (sid: string, channelId: string) => {
    const spec = matchSceneSpec(specs, { sid, channelId });
    return spec && `${spec.profile}/${spec.name}`;
  };

  it("普通 scene 按 sid + 名单认领，黑名单照旧排除", () => {
    expect(owner("onebot:111", "group:1")).toBe("neko/groups");
    expect(owner("onebot:111", "group:quiet")).toBeUndefined();
    expect(owner("onebot:111", "private:9")).toBe("neko/dms");
  });

  it("cross 按 claims 逐 sid 认领，换账号仍是同一块生效单位", () => {
    expect(owner("onebot:222", "group:1")).toBe("fused/cross");
    expect(owner("onebot:333", "private:9")).toBe("fused/cross");
    expect(owner("onebot:222", "private:9")).toBeUndefined();
  });

  it("没人认领的频道不落到任何 spec 上", () => {
    expect(owner("onebot:999", "group:1")).toBeUndefined();
  });
});
