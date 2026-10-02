import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOME_MOUNT, resolveMounts, resolveSkillMounts } from "../src/mounts.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "ishiki-workspace-mounts-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("挂载声明", () => {
  it("source 相对 profile 目录解析，缺省读写", () => {
    const mounted = resolveMounts(["data:/data"], base);
    expect(mounted).toHaveLength(1);
    expect(mounted[0].target).toBe("/data");
    expect(mounted[0].readOnly).toBe(false);
    // 读写挂载与 docker 一致：宿主目录不存在就建出来。
    expect(existsSync(path.join(base, "data"))).toBe(true);
  });

  it(":ro 后缀表示只读，且要求宿主目录已经存在", () => {
    mkdirSync(path.join(base, "docs"));
    expect(resolveMounts(["docs:/docs:ro"], base)[0]).toMatchObject({ target: "/docs", readOnly: true });
    expect(() => resolveMounts(["absent:/absent:ro"], base)).toThrow(/只读挂载的 source/);
  });

  it("带盘符的绝对 source 也从右侧切分", () => {
    // Windows 的 `D:\x:/data` 与 POSIX 的 `/srv/x:/data` 都只有最后一个冒号是分隔符。
    const host = path.join(base, "host");
    mkdirSync(host);
    expect(resolveMounts([`${host}:/data`], base)[0].source).toBe(host);
  });

  it("目标必须是沙箱内的绝对路径，且不含 . 或 .. 段", () => {
    expect(() => resolveMounts(["data:data"], base)).toThrow(/绝对路径/);
    expect(() => resolveMounts(["data:/a/../b"], base)).toThrow(/\. 或 \.\./);
    expect(() => resolveMounts(["data:/"], base)).toThrow(/根目录/);
  });

  it("目标重复、互相嵌套、踩在保留挂载点上都被拒绝", () => {
    expect(() => resolveMounts(["a:/data", "b:/data"], base)).toThrow(/重复/);
    expect(() => resolveMounts(["a:/data", "b:/data/sub"], base)).toThrow(/嵌套/);
    expect(() => resolveMounts([`a:${HOME_MOUNT}`], base)).toThrow(/保留/);
    expect(() => resolveMounts(["a:/home/workspace"], base)).toThrow(/保留/);
    expect(() => resolveMounts(["a:/home/skills"], base)).toThrow(/保留/);
    expect(() => resolveMounts(["a:/home/skills/pdf"], base)).toThrow(/保留/);
  });

  it("目标冲突时不在盘上建目录", () => {
    expect(() => resolveMounts(["create-me:/data", "also-me:/data"], base)).toThrow(/重复/);
    expect(existsSync(path.join(base, "create-me"))).toBe(false);
  });

  it("source 是文件时报错", () => {
    writeFileSync(path.join(base, "a.txt"), "x");
    expect(() => resolveMounts(["a.txt:/a.txt"], base)).toThrow(/必须是目录/);
  });

  it("用户声明不许占技能挂载点，技能挂载由发现结果自己生成", () => {
    expect(() => resolveMounts(["skill:/home/skills/pdf:ro"], base)).toThrow(/保留/);
    mkdirSync(path.join(base, "skill"));
    const mounted = resolveSkillMounts([{ name: "pdf", directory: path.join(base, "skill") }], base);
    expect(mounted[0]).toMatchObject({ target: "/home/skills/pdf", readOnly: true, source: path.join(base, "skill") });
  });
});
