import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { ResourceCenter, ResourceError, ResourceStore, type ResourcePayload } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceConfig } from "../src/config.js";
import { SkillScheme, WorkspaceScheme } from "../src/resource-schemes.js";
import { createSandbox } from "../src/sandbox.js";
import { resolveLayout, type ShellOptions, type WorkspaceShell } from "../src/shell.js";

/** 一张合法 PNG 的开头（魔数足够让嗅探认出 image/png）。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

const SKILL = "---\nname: pdf\ndescription: 提取 PDF 文本\n---\n\n技能正文\n";

let base: string;
let home: string;
let root: string;
let dataPath: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-workspace-scheme-"));
  home = path.join(base, "home");
  root = path.join(base, "profiles", "neko");
  dataPath = path.join(base, "data");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(dataPath, "skills", "pdf", "references"), { recursive: true });
  await fs.writeFile(path.join(dataPath, "skills", "pdf", "SKILL.md"), SKILL);
  await fs.writeFile(path.join(dataPath, "skills", "pdf", "references", "notes.md"), "参考笔记\n");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function options(overrides: Partial<WorkspaceConfig> = {}, resources?: ResourceCenter): ShellOptions {
  const config: WorkspaceConfig = {
    backend: "sandbox",
    shell: "",
    cwd: "/home/workspace",
    timeoutMs: 30_000,
    maxExecutionOutputBytes: 32 * 1024 * 1024,
    network: false,
    javascript: false,
    python: false,
    skills: [],
    mounts: [],
    ...overrides,
  };
  return { config, home, root, dataPath, logger: silent, ...(resources === undefined ? {} : { resources }) };
}

async function mount(overrides: Partial<WorkspaceConfig> = {}, resources?: ResourceCenter): Promise<WorkspaceShell> {
  const shellOptions = options(overrides, resources);
  return createSandbox(resolveLayout(shellOptions), shellOptions);
}

/** 断言并收窄成文件 payload：联合类型的判别字段是测试唯一能依赖的东西。 */
function asFile(payload: ResourcePayload): Extract<ResourcePayload, { type: "file" }> {
  if (payload.type !== "file") throw new Error(`expected a file payload, got ${payload.type}`);
  return payload;
}

/** 断言并收窄成文本 payload。 */
function asText(payload: ResourcePayload): Extract<ResourcePayload, { type: "text" }> {
  if (payload.type !== "text") throw new Error(`expected a text payload, got ${payload.type}`);
  return payload;
}

describe("workspace URL", () => {
  it("reads persistent, virtual and mounted files exactly as the sandbox sees them", async () => {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "spec.md"), "文档正文\n");
    await fs.writeFile(path.join(home, "events.jsonl"), '{"type":"turn.start"}\n');
    const shell = await mount({ mounts: ["docs:/docs:ro", "data:/data"] });
    const urls = new WorkspaceScheme(async () => shell.fs);

    // 持久目录：URL、沙箱与宿主落盘三方是同一份字节。
    await shell.exec("echo 持久 > /home/workspace/note.txt");
    expect(asText(await urls.resolve("workspace:///home/workspace/note.txt")).text).toBe("持久\n");
    expect(await shell.read("/home/workspace/note.txt")).toBe("持久\n");
    expect(await fs.readFile(path.join(home, "workspace", "note.txt"), "utf8")).toBe("持久\n");

    // 虚拟文件：只存在于沙箱内存里，宿主上没有对应路径。
    await shell.exec("mkdir -p /tmp/ishiki && echo 虚拟 > /tmp/ishiki/v.txt");
    expect(asText(await urls.resolve("workspace:///tmp/ishiki/v.txt")).text).toBe("虚拟\n");
    await expect(fs.access(path.join(home, "tmp", "ishiki", "v.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    // 只读挂载：读得到，写不进去。
    expect(asText(await urls.resolve("workspace:///docs/spec.md")).text).toBe("文档正文\n");
    expect((await shell.exec("echo x > /docs/new.md")).exitCode).not.toBe(0);

    // 读写挂载：URL 读到的是沙箱写下的内容，改动落盘。
    await shell.exec("echo rw > /data/rw.txt");
    expect(asText(await urls.resolve("workspace:///data/rw.txt")).text).toBe("rw\n");
    expect(await fs.readFile(path.join(root, "data", "rw.txt"), "utf8")).toBe("rw\n");

    // 数据目录整体只读：读到既有文件，写入失败。
    expect(asText(await urls.resolve("workspace:///home/events.jsonl")).text).toBe('{"type":"turn.start"}\n');
    expect((await shell.exec("echo x > /home/new.txt")).exitCode).not.toBe(0);
  });

  it("returns binary files as file payloads with the raw bytes", async () => {
    await fs.mkdir(path.join(home, "workspace"), { recursive: true });
    await fs.writeFile(path.join(home, "workspace", "pic.png"), PNG);
    const shell = await mount();
    const payload = asFile(await new WorkspaceScheme(async () => shell.fs).resolve("workspace:///home/workspace/pic.png"));
    expect(payload.mediaType).toBe("image/png");
    expect(payload.bytes).toEqual(PNG);
    expect(payload.size).toBe(PNG.byteLength);
    // workspace 是实时引用：文件被覆盖后另一次读取必须看到新字节。
    expect(payload.immutable).toBe(false);
  });

  it("returns the selected line range with serializable read provenance", async () => {
    await fs.mkdir(path.join(home, "workspace"), { recursive: true });
    await fs.writeFile(path.join(home, "workspace", "lines.txt"), "l1\nl2\nl3\nl4\n");
    const shell = await mount();
    const urls = new WorkspaceScheme(async () => shell.fs);

    const page = asText(await urls.resolve("workspace:///home/workspace/lines.txt:2-3"));
    expect(page.text.trimEnd().split("\n")).toEqual(["l2", "l3"]);
    // 来源信息必须能跨调用/跨进程传递：纯数据、可序列化，并保留原 URL 的选择。
    expect(page.source).toBeDefined();
    expect(page.source?.url.startsWith("workspace:///home/workspace/lines.txt")).toBe(true);
    expect(page.source?.offset).toBe(0);
    expect(page.source?.line).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(JSON.stringify(page.source))).toEqual(page.source);

    const counted = asText(await urls.resolve("workspace:///home/workspace/lines.txt:3+2"));
    expect(counted.text.trimEnd().split("\n")).toEqual(["l3", "l4"]);
  });

  it("lists directories from the same view", async () => {
    await fs.mkdir(path.join(home, "workspace"), { recursive: true });
    await fs.writeFile(path.join(home, "workspace", "b.txt"), "b");
    await fs.writeFile(path.join(home, "workspace", "a.txt"), "a");
    const shell = await mount();
    const listing = asText(await new WorkspaceScheme(async () => shell.fs).resolve("workspace:///home/workspace")).text;
    expect(listing).toContain("a.txt");
    expect(listing).toContain("b.txt");
  });

  it("rejects URLs that do not name an absolute sandbox path", async () => {
    const shell = await mount();
    const urls = new WorkspaceScheme(async () => shell.fs);
    await expect(urls.resolve("workspace://")).rejects.toBeInstanceOf(ResourceError);
    await expect(urls.resolve("workspace://host/file.txt")).rejects.toBeInstanceOf(ResourceError);
  });
});

describe("skill URL", () => {
  it("reads the skill directory by default entry, file and nested path", async () => {
    const skills = new SkillScheme((await mount()).skills);
    expect(asText(await skills.resolve("skill://pdf")).text).toBe(SKILL);
    expect(asText(await skills.resolve("skill://pdf/SKILL.md")).text).toBe(SKILL);
    expect(asText(await skills.resolve("skill://pdf/references/notes.md")).text).toBe("参考笔记\n");
  });

  it("returns binary skill files with their bytes and rejects unknown or escaping paths", async () => {
    await fs.writeFile(path.join(dataPath, "skills", "pdf", "logo.png"), PNG);
    const skills = new SkillScheme((await mount()).skills);
    expect([...asFile(await skills.resolve("skill://pdf/logo.png")).bytes]).toEqual([...PNG]);
    await expect(skills.resolve("skill://absent/SKILL.md")).rejects.toBeInstanceOf(ResourceError);
    await expect(skills.resolve("skill://pdf/../../secret.md")).rejects.toBeInstanceOf(ResourceError);
  });

  it("resolves links and blocks ones that leave the skill directory", async () => {
    const outside = path.join(base, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.md"), "外部秘密\n");
    // 目录联接/符号链接是真的能读到技能目录外的方式；按宿主真实路径判定越界。
    await fs.symlink(outside, path.join(dataPath, "skills", "pdf", "escape"), process.platform === "win32" ? "junction" : "dir");
    const skills = new SkillScheme((await mount()).skills);
    await expect(skills.resolve("skill://pdf/escape/secret.md")).rejects.toBeInstanceOf(ResourceError);
  });
});

describe("resource mounts", () => {
  it("serves the same bytes as the resource URL and stays read-only", async () => {
    const store = new ResourceStore(home);
    const center = new ResourceCenter("rt-a", home, store);
    const shell = await mount({}, center);
    const url = await store.writeArtifact("bash", Buffer.from("长输出正文", "utf8"));
    const name = url.split("/").at(-1)!;

    expect(asText(await center.resolve(url)).text).toBe("长输出正文");
    const mounted = await shell.exec(`cat /home/.ishiki/artifacts/bash/${name}`);
    expect(mounted.exitCode).toBe(0);
    expect(mounted.stdout).toBe("长输出正文");
    expect((await shell.exec(`echo x > /home/.ishiki/artifacts/bash/${name}`)).exitCode).not.toBe(0);
  });

  it("keeps runtimes isolated: another runtime's URL and mount see nothing", async () => {
    const other = options();
    other.home = path.join(base, "other-home");
    other.root = path.join(base, "profiles", "other");
    await fs.mkdir(other.home, { recursive: true });
    await fs.mkdir(other.root, { recursive: true });

    const storeA = new ResourceStore(home);
    const storeB = new ResourceStore(other.home);
    const centerA = new ResourceCenter("rt-a", home, storeA);
    const centerB = new ResourceCenter("rt-b", other.home, storeB);
    const url = await storeA.writeArtifact("bash", Buffer.from("rt-a 的内容", "utf8"));
    const name = url.split("/").at(-1)!;

    expect(asText(await centerA.resolve(url)).text).toBe("rt-a 的内容");
    await expect(centerB.resolve(url)).rejects.toBeInstanceOf(ResourceError);

    const shellB = await createSandbox(resolveLayout(other), other);
    expect((await shellB.exec(`cat /home/.ishiki/artifacts/bash/${name}`)).exitCode).not.toBe(0);

    // 另一个 Runtime 的 workspace 视图同样不共享：同名文件并不存在。
    const shellA = await mount();
    await shellA.write("/home/workspace/secret.txt", "rt-a 的秘密\n");
    centerB.attach(new WorkspaceScheme(async () => shellB.fs));
    await expect(centerB.resolve("workspace:///home/workspace/secret.txt")).rejects.toBeInstanceOf(ResourceError);
  });
});
