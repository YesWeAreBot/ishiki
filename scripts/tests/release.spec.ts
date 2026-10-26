import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getNewPeerRange, syncPeerDependencies } from "../release";

function tempPackage(manifest: Record<string, unknown>): string {
  mkdirSync(path.join(process.cwd(), "cache"), { recursive: true });
  const dir = mkdtempSync(path.join(process.cwd(), "cache", "release-test-"));
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

describe("getNewPeerRange", () => {
  it("保留双段区间的上界，只替换下界", () => {
    expect(getNewPeerRange(">=0.0.1 <0.1.0", "0.0.2", "patch")).toBe(">=0.0.2 <0.1.0");
  });

  it("新版本超出上界时按发布类型推进上界", () => {
    expect(getNewPeerRange(">=0.0.1 <0.1.0", "0.1.0", "minor")).toBe(">=0.1.0 <0.2.0");
  });

  it("保留插入符与波浪符语义", () => {
    expect(getNewPeerRange("^0.0.1", "0.0.2", "patch")).toBe("^0.0.2");
    expect(getNewPeerRange("~0.0.1", "0.0.2", "patch")).toBe("~0.0.2");
  });

  it("不动通配区间与 workspace 协议", () => {
    expect(getNewPeerRange("*", "0.0.2", "patch")).toBe("*");
    expect(getNewPeerRange("workspace:^", "0.0.2", "patch")).toBe("workspace:^");
  });

  it("复合区间无法自动更新时抛错", () => {
    expect(() => getNewPeerRange("^0.0.1 || ^0.1.0", "0.0.2", "patch")).toThrow("复合版本区间");
  });
});

describe("syncPeerDependencies", () => {
  it("同步 peerDependencies 并保留 devDependencies", () => {
    const manifest = {
      name: "koishi-plugin-ishiki-workspace",
      version: "0.0.2",
      devDependencies: { "koishi-plugin-ishiki": ">=0.0.2 <0.1.0" },
      peerDependencies: { "koishi-plugin-ishiki": ">=0.0.1 <0.1.0" },
    };
    const dir = tempPackage(manifest);
    try {
      syncPeerDependencies(
        [
          {
            name: "koishi-plugin-ishiki",
            type: "patch",
            oldVersion: "0.0.1",
            newVersion: "0.0.2",
            changesets: [],
            firstRelease: false,
          },
        ],
        [
          {
            name: manifest.name,
            version: manifest.version,
            isPrivate: false,
            dir,
            relDir: "cache/release-test",
            manifest,
          },
        ],
      );
      const written = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      expect(written.peerDependencies["koishi-plugin-ishiki"]).toBe(">=0.0.2 <0.1.0");
      expect(written.devDependencies["koishi-plugin-ishiki"]).toBe(">=0.0.2 <0.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
