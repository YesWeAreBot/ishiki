import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { Range, inc, satisfies, validRange, type ReleaseType } from "semver";

const { dirname, join, relative, resolve } = path;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGESET_TEMP = join(ROOT, ".changeset", "__release__.md");
const PLAN_FILE = join(ROOT, "cache", "release-plan.json");
const NOTES_FILE = join(ROOT, "cache", "release-notes.md");

type BumpType = "patch" | "minor" | "major";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackageInfo {
  name: string;
  version: string;
  isPrivate: boolean;
  dir: string;
  relDir: string;
  manifest: Manifest;
}

interface PlanRelease {
  name: string;
  type: string;
  oldVersion: string;
  newVersion: string;
  changesets: string[];
  firstRelease: boolean;
}

interface ReleasePackage {
  name: string;
  version: string;
  dir: string;
  manifest: Manifest;
}

interface Selection {
  publishedBumps: Map<string, BumpType>;
  firstReleases: Set<string>;
  skippedFirstReleases: Set<string>;
}

interface ChangesetStatus {
  releases: Array<{
    name: string;
    type: string;
    oldVersion: string;
    newVersion: string;
    changesets?: string[];
  }>;
}

function run(command: string, args: string[], options: { cwd?: string; capture?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${String(result.stderr ?? "").trim()}` : "";
    throw new Error(`${command} ${args.join(" ")} 失败，退出码 ${String(result.status)}${detail}`);
  }
  return options.capture ? String(result.stdout ?? "") : "";
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const GH = "gh";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function loadPackages(): PackageInfo[] {
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) throw new Error("缺少 packages 目录");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      if (!existsSync(join(dir, "package.json"))) return null;
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
      return {
        name: manifest.name,
        version: manifest.version,
        isPrivate: manifest.private === true,
        dir,
        relDir: `packages/${entry.name}`,
        manifest,
      } satisfies PackageInfo;
    })
    .filter((pkg): pkg is PackageInfo => pkg !== null);
}

function hasTag(tag: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: ROOT, stdio: "ignore" }).status === 0;
}

function lastTag(name: string): string | undefined {
  const output = run("git", ["tag", "--list", `${name}@*`, "--sort=-v:refname"], { capture: true });
  return output
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function changedSinceLastTag(pkg: PackageInfo): boolean {
  const tag = lastTag(pkg.name);
  if (!tag) return true;
  const output = run("git", ["diff", "--name-only", `${tag}..HEAD`, "--", pkg.relDir], { capture: true });
  return output.trim().length > 0;
}

async function registryHas(name: string, version: string): Promise<boolean> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`registry 查询失败：${name}@${version} 返回 ${response.status} ${response.statusText}`);
}

function getRepoUrl(): string {
  const remote = run("git", ["remote", "get-url", "origin"], { capture: true }).trim();
  const pathPart = remote
    .replace(/^.*github\.com[:/]/, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const [owner, repo] = pathPart.split("/");
  if (!owner || !repo) throw new Error(`无法从 origin 解析 GitHub 仓库：${remote}`);
  return `https://github.com/${owner}/${repo}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rewriteChangelog(
  content: string,
  name: string,
  oldVersion: string,
  newVersion: string,
  repoUrl: string,
  date: string,
  hasPreviousTag: boolean,
): string {
  const lines = content.split(/\r?\n/);
  const unreleasedIndex = lines.findIndex((line) => /^## \[Unreleased\]\s*$/.test(line));
  if (unreleasedIndex === -1) throw new Error(`${name} 的 CHANGELOG.md 缺少 ## [Unreleased]`);
  let nextHeading = lines.length;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      nextHeading = index;
      break;
    }
  }
  const body = lines.slice(unreleasedIndex + 1, nextHeading);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  if (body.length === 0) throw new Error(`${name} 的 ## [Unreleased] 没有内容`);
  const block = ["## [Unreleased]", "", `## [${newVersion}] - ${date}`, "", ...body, ""];
  const withoutOldLinks = [...lines.slice(0, unreleasedIndex), ...block, ...lines.slice(nextHeading)].filter(
    (line) => !line.startsWith("[Unreleased]:") && !line.startsWith(`[${newVersion}]:`),
  );
  const firstLinkIndex = withoutOldLinks.findIndex((line) => /^\[[^\]]+\]:\s*\S+/.test(line));
  const contentLines = withoutOldLinks.slice(0, firstLinkIndex === -1 ? withoutOldLinks.length : firstLinkIndex);
  while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === "") contentLines.pop();
  const existingLinks = firstLinkIndex === -1 ? [] : withoutOldLinks.slice(firstLinkIndex);
  const versionLink =
    hasPreviousTag && oldVersion !== newVersion
      ? `${repoUrl}/compare/${name}@${oldVersion}...${name}@${newVersion}`
      : `${repoUrl}/releases/tag/${name}@${newVersion}`;
  const linkLines = [`[Unreleased]: ${repoUrl}/compare/${name}@${newVersion}...HEAD`, `[${newVersion}]: ${versionLink}`];
  const result = [...contentLines, "", ...linkLines, ...existingLinks];
  return `${result.join("\n").replace(/\n+$/, "")}\n`;
}

export function extractNotes(content: string, version: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^## \\[?${escapeRegExp(version)}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md 缺少 ${version} 的章节`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  if (body.length === 0) throw new Error(`CHANGELOG.md 的 ${version} 章节没有内容`);
  return `${body.join("\n")}\n`;
}

export function sortReleases(releases: ReleasePackage[]): ReleasePackage[] {
  const byName = new Map(releases.map((release) => [release.name, release]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const release of releases) {
    indegree.set(release.name, 0);
    dependents.set(release.name, []);
  }
  for (const release of releases) {
    const dependencies = { ...release.manifest.dependencies, ...release.manifest.peerDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (dependency === release.name || !byName.has(dependency)) continue;
      dependents.get(dependency)?.push(release.name);
      indegree.set(release.name, (indegree.get(release.name) ?? 0) + 1);
    }
  }
  const queue = releases
    .filter((release) => (indegree.get(release.name) ?? 0) === 0)
    .map((release) => release.name)
    .sort((left, right) => left.localeCompare(right));
  const ordered: ReleasePackage[] = [];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name) break;
    const release = byName.get(name);
    if (!release) continue;
    ordered.push(release);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  if (ordered.length !== releases.length) {
    const remaining = releases.filter((release) => !ordered.some((item) => item.name === release.name)).map((release) => release.name);
    throw new Error(`包依赖存在环：${remaining.join(", ")}`);
  }
  return ordered;
}

function preconditions(dryRun: boolean): void {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).trim();
  if (branch !== "main") throw new Error(`发布必须在 main 分支执行，当前是 ${branch}`);
  if (!dryRun) {
    const status = run("git", ["status", "--porcelain"], { capture: true }).trim();
    if (status) throw new Error(`工作区不干净：\n${status}`);
  }
  if (spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: ROOT, stdio: "ignore" }).status !== 0) {
    throw new Error("找不到 origin/main，请先执行 git fetch origin main");
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: ROOT, stdio: "ignore" }).status !== 0) {
    throw new Error("HEAD 不包含 origin/main，请先拉取或变基");
  }
  const configPath = join(ROOT, ".changeset", "config.json");
  if (!existsSync(configPath)) throw new Error("缺少 .changeset/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { changelog?: unknown; commit?: unknown };
  if (config.changelog !== false) throw new Error(".changeset/config.json 必须设置 changelog: false");
  if (config.commit !== false) throw new Error(".changeset/config.json 必须设置 commit: false");
  if (!existsSync(join(ROOT, "bun.lock"))) throw new Error("缺少 bun.lock");
  const stale = readdirSync(join(ROOT, ".changeset")).filter((file) => file.endsWith(".md") && file !== "README.md");
  if (stale.length > 0) throw new Error(`.changeset 下还有未处理的 changeset：${stale.join(", ")}`);
}

async function selectReleases(candidates: PackageInfo[], published: Map<string, boolean>, yes: boolean): Promise<Selection> {
  const selection: Selection = {
    publishedBumps: new Map(),
    firstReleases: new Set(),
    skippedFirstReleases: new Set(),
  };
  if (yes) {
    for (const pkg of candidates) {
      if (published.get(pkg.name)) selection.publishedBumps.set(pkg.name, "patch");
      else selection.firstReleases.add(pkg.name);
    }
    return selection;
  }
  if (!process.stdin.isTTY) throw new Error("交互选择需要 TTY，或者传入 --yes");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const pkg of candidates) {
      const isPublished = published.get(pkg.name) === true;
      const answer = (
        await readline.question(
          isPublished
            ? `${pkg.name} ${pkg.version}（已发布）patch / minor / major / skip [patch]：`
            : `${pkg.name} ${pkg.version}（未发布）release / skip [release]：`,
        )
      )
        .trim()
        .toLowerCase();
      if (isPublished) {
        if (answer === "" || answer === "patch") selection.publishedBumps.set(pkg.name, "patch");
        else if (answer === "minor") selection.publishedBumps.set(pkg.name, "minor");
        else if (answer === "major") selection.publishedBumps.set(pkg.name, "major");
        else if (answer === "skip") continue;
        else throw new Error(`无法识别的选择：${answer}。请输入 patch、minor、major 或 skip。`);
      } else {
        if (answer === "" || answer === "release") selection.firstReleases.add(pkg.name);
        else if (answer === "skip") selection.skippedFirstReleases.add(pkg.name);
        else throw new Error(`无法识别的选择：${answer}。请输入 release 或 skip。`);
      }
    }
  } finally {
    readline.close();
  }
  return selection;
}

function renderChangeset(bumps: Map<string, BumpType>): string {
  const entries = [...bumps.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, type]) => `"${name}": ${type}`);
  return `---\n${entries.join("\n")}\n---\n\nRelease.\n`;
}

function runChangesetStatus(): ChangesetStatus {
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  rmSync(PLAN_FILE, { force: true });
  run(process.execPath, ["x", "changeset", "status", "--output", "packs/release-plan.json"]);
  if (!existsSync(PLAN_FILE)) throw new Error("changeset status 没有生成计划文件");
  return JSON.parse(readFileSync(PLAN_FILE, "utf8")) as ChangesetStatus;
}

function toPlanReleases(status: ChangesetStatus, firstReleases: Set<string>, skippedFirstReleases: Set<string>, packages: PackageInfo[]): PlanRelease[] {
  const plan = (status.releases ?? [])
    .filter((release) => release.type !== "none")
    .map((release) => ({
      name: release.name,
      type: release.type,
      oldVersion: release.oldVersion,
      newVersion: release.newVersion,
      changesets: release.changesets ?? [],
      firstRelease: firstReleases.has(release.name),
    }));
  for (const release of plan) {
    if (release.firstRelease) release.newVersion = release.oldVersion;
    if (skippedFirstReleases.has(release.name)) {
      throw new Error(`${release.name} 是未发布包，本次依赖升级会强制发布它；请重新选择 release，或者把相关升级改为 patch`);
    }
  }
  for (const name of firstReleases) {
    if (plan.some((release) => release.name === name)) continue;
    const pkg = packages.find((item) => item.name === name);
    if (!pkg) throw new Error(`找不到包：${name}`);
    plan.push({ name, type: "first-release", oldVersion: pkg.version, newVersion: pkg.version, changesets: [], firstRelease: true });
  }
  return plan;
}

function preflight(plan: PlanRelease[], packages: PackageInfo[], repoUrl: string, date: string, dryRun: boolean): Map<string, string> {
  const rewrites = new Map<string, string>();
  for (const release of plan) {
    const pkg = packages.find((item) => item.name === release.name);
    if (!pkg) throw new Error(`找不到包：${release.name}`);
    if (pkg.manifest.version !== release.oldVersion) {
      throw new Error(`${release.name} 的 package.json 版本 ${pkg.manifest.version} 与计划 ${release.oldVersion} 不一致`);
    }
    if (release.firstRelease && release.newVersion !== release.oldVersion) {
      throw new Error(`${release.name} 的首次发布版本必须保持 ${release.oldVersion}`);
    }
    if (!release.firstRelease && release.newVersion === release.oldVersion) {
      throw new Error(`${release.name} 的版本没有变化`);
    }
    const tag = `${release.name}@${release.newVersion}`;
    if (hasTag(tag)) throw new Error(`tag 已存在：${tag}`);
    const changelogPath = join(pkg.dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) throw new Error(`缺少 ${relative(ROOT, changelogPath)}`);
    const content = readFileSync(changelogPath, "utf8");
    const hasPreviousTag = hasTag(`${release.name}@${release.oldVersion}`);
    const rewritten = rewriteChangelog(content, release.name, release.oldVersion, release.newVersion, repoUrl, date, hasPreviousTag);
    rewrites.set(release.name, rewritten);
    if (dryRun) {
      const link = hasPreviousTag && release.oldVersion !== release.newVersion ? "compare" : "releases/tag";
      console.log(`[dry-run] ${relative(ROOT, changelogPath)}: ${release.newVersion}，链接使用 ${link}`);
    }
  }
  return rewrites;
}

function printPlan(plan: PlanRelease[]): void {
  console.log("发布计划：");
  for (const release of [...plan].sort((left, right) => left.name.localeCompare(right.name))) {
    const kind = release.firstRelease ? "首次发布" : release.changesets.length === 0 ? "依赖升级" : release.type;
    console.log(`  ${release.name} ${release.oldVersion} -> ${release.newVersion}（${kind}）`);
  }
}

function buildAndTest(): void {
  console.log("运行构建和测试...");
  run(process.execPath, ["run", "build"]);
  run(process.execPath, ["run", "test"]);
}

function resetFirstReleaseVersions(plan: PlanRelease[], packages: PackageInfo[]): void {
  for (const release of plan) {
    if (!release.firstRelease) continue;
    const pkg = packages.find((item) => item.name === release.name);
    if (!pkg) throw new Error(`找不到包：${release.name}`);
    const manifestPath = join(pkg.dir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.version === release.oldVersion) continue;
    manifest.version = release.oldVersion;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function getVersionRangeType(versionRange: string): string {
  if (versionRange.charAt(0) === "^") return "^";
  if (versionRange.charAt(0) === "~") return "~";
  if (versionRange.startsWith(">=")) return ">=";
  if (versionRange.startsWith("<=")) return "<=";
  if (versionRange.charAt(0) === ">") return ">";
  return "";
}

export function getNewPeerRange(versionRange: string, newVersion: string, releaseType: string): string {
  if (versionRange.startsWith("workspace:") || versionRange.startsWith("file:") || versionRange.startsWith("link:")) {
    return versionRange;
  }
  if (!validRange(versionRange)) throw new Error(`无法解析版本区间：${versionRange}`);
  if (/^\s*(\*|x|X)\s*$/.test(versionRange)) return versionRange;
  const sets = new Range(versionRange).set;
  if (sets.length !== 1) throw new Error(`无法自动更新复合版本区间：${versionRange}`);
  const comparators = sets[0];
  if (comparators.length === 2 && versionRange.includes(">") && versionRange.includes("<")) {
    const lowerBound = comparators.find(({ operator }) => operator.startsWith(">"));
    const upperBound = comparators.find(({ operator }) => operator.startsWith("<"));
    if (lowerBound && upperBound) {
      let newUpperBound = upperBound.value;
      if (!satisfies(newVersion, newUpperBound)) {
        const incremented = inc(newVersion, (releaseType === "minor" || releaseType === "major" ? releaseType : "patch") as ReleaseType);
        if (!incremented) throw new Error(`无法计算 ${newVersion} 的下一个版本`);
        newUpperBound = `<${incremented}`;
      }
      return comparators[0] === lowerBound ? `>=${newVersion} ${newUpperBound}` : `${newUpperBound} >=${newVersion}`;
    }
  }
  return `${getVersionRangeType(versionRange)}${newVersion}`;
}

export function syncPeerDependencies(plan: PlanRelease[], packages: PackageInfo[]): void {
  const releases = new Map(plan.filter((release) => release.type !== "none").map((release) => [release.name, release]));
  for (const pkg of packages) {
    const manifestPath = join(pkg.dir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const peers = manifest.peerDependencies;
    if (!peers) continue;
    let changed = false;
    for (const [name, release] of releases) {
      if (name === manifest.name) continue;
      const versionRange = peers[name];
      if (!versionRange) continue;
      const nextRange = getNewPeerRange(versionRange, release.newVersion, release.type);
      if (nextRange === versionRange) continue;
      peers[name] = nextRange;
      changed = true;
    }
    if (!changed) continue;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    pkg.manifest = manifest;
    console.log(`同步 ${relative(ROOT, manifestPath)} 的 peerDependencies`);
  }
}

function writeChangelogs(plan: PlanRelease[], packages: PackageInfo[], rewrites: Map<string, string>): void {
  for (const release of plan) {
    const pkg = packages.find((item) => item.name === release.name);
    if (!pkg) throw new Error(`找不到包：${release.name}`);
    const rewritten = rewrites.get(release.name);
    if (!rewritten) throw new Error(`缺少 ${release.name} 的 CHANGELOG 改写结果`);
    writeFileSync(join(pkg.dir, "CHANGELOG.md"), rewritten);
  }
}

export function releaseCommitMessage(plan: PlanRelease[]): { subject: string; body: string } {
  const releases = [...plan].sort((left, right) => left.name.localeCompare(right.name));
  return {
    subject: "chore(release): bump version",
    body: releases.map((release) => `- ${release.name}@${release.newVersion}`).join("\n"),
  };
}

function commitAndTag(plan: PlanRelease[]): void {
  const releases = [...plan].sort((left, right) => left.name.localeCompare(right.name));
  const message = releaseCommitMessage(plan);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", message.subject, "-m", message.body]);
  for (const release of releases) {
    const tag = `${release.name}@${release.newVersion}`;
    run("git", ["tag", "-a", tag, "-m", tag]);
  }
  console.log(`已提交并创建 ${releases.length} 个包 tag（未推送）：${releases.map((release) => `${release.name}@${release.newVersion}`).join(", ")}`);
}

async function bump(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const yes = args.includes("--yes");
  preconditions(dryRun);
  const packages = loadPackages();
  const candidates = packages.filter((pkg) => !pkg.isPrivate && (all || changedSinceLastTag(pkg)));
  if (candidates.length === 0) {
    console.log("没有需要发布的公开包。");
    return;
  }
  const published = new Map<string, boolean>();
  for (const pkg of candidates) published.set(pkg.name, await registryHas(pkg.name, pkg.version));
  console.log("包状态：");
  for (const pkg of candidates) console.log(`  ${pkg.name} ${pkg.version} ${published.get(pkg.name) ? "已发布" : "未发布"}`);
  const selection = await selectReleases(candidates, published, yes);
  if (selection.publishedBumps.size === 0 && selection.firstReleases.size === 0) {
    console.log("没有选择任何发布。");
    return;
  }
  const repoUrl = getRepoUrl();
  const date = dateString();
  let plan: PlanRelease[];
  let usedChangesets = false;
  try {
    if (selection.publishedBumps.size > 0) {
      writeFileSync(CHANGESET_TEMP, renderChangeset(selection.publishedBumps));
      const status = runChangesetStatus();
      usedChangesets = true;
      plan = toPlanReleases(status, selection.firstReleases, selection.skippedFirstReleases, packages);
    } else {
      plan = [...selection.firstReleases].map((name) => {
        const pkg = packages.find((item) => item.name === name);
        if (!pkg) throw new Error(`找不到包：${name}`);
        return { name, type: "first-release", oldVersion: pkg.version, newVersion: pkg.version, changesets: [], firstRelease: true };
      });
    }
    for (const release of plan.filter((item) => item.firstRelease)) {
      if (await registryHas(release.name, release.oldVersion)) {
        throw new Error(`${release.name}@${release.oldVersion} 已经在 registry 出现，停止首次发布`);
      }
    }
    const rewrites = preflight(plan, packages, repoUrl, date, dryRun);
    printPlan(plan);
    if (dryRun) {
      console.log("[dry-run] 不写入文件，不构建，不提交。");
      return;
    }
    buildAndTest();
    if (usedChangesets) run(process.execPath, ["x", "changeset", "version"]);
    resetFirstReleaseVersions(plan, packages);
    syncPeerDependencies(plan, packages);
    writeChangelogs(plan, packages, rewrites);
    run(process.execPath, ["install"]);
    rmSync(CHANGESET_TEMP, { force: true });
    commitAndTag(plan);
  } finally {
    rmSync(CHANGESET_TEMP, { force: true });
  }
}

async function publish(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const packages = loadPackages();
  const tags = run("git", ["tag", "--points-at", "HEAD"], { capture: true })
    .split("\n")
    .map((line) => line.trim())
    .filter((tag) => tag.length > 0 && tag.includes("@"));
  if (tags.length === 0) throw new Error("HEAD 上没有 package tag");
  const releases = tags.map((tag) => {
    const at = tag.lastIndexOf("@");
    const name = tag.slice(0, at);
    const version = tag.slice(at + 1);
    const pkg = packages.find((item) => item.name === name && !item.isPrivate);
    if (!pkg) throw new Error(`tag ${tag} 找不到对应的公开包`);
    if (pkg.manifest.version !== version) throw new Error(`${name} 的 package.json 版本 ${pkg.manifest.version} 与 tag ${version} 不一致`);
    return { name, version, dir: pkg.dir, manifest: pkg.manifest };
  });
  const ordered = sortReleases(releases);
  const notes = new Map<string, string>();
  for (const release of ordered) {
    const changelogPath = join(release.dir, "CHANGELOG.md");
    if (!existsSync(changelogPath)) throw new Error(`缺少 ${relative(ROOT, changelogPath)}`);
    notes.set(release.name, extractNotes(readFileSync(changelogPath, "utf8"), release.version));
  }
  console.log("发布顺序：");
  for (const release of ordered) console.log(`  ${release.name}@${release.version}`);
  if (dryRun) {
    console.log("[dry-run] 不发布，不创建 Release。");
    return;
  }
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  try {
    for (const release of ordered) {
      const tag = `${release.name}@${release.version}`;
      if (await registryHas(release.name, release.version)) {
        console.log(`跳过 ${tag}：registry 已存在`);
      } else {
        const distTag = release.version.includes("-") ? "next" : "latest";
        run(NPM, ["publish", "--workspace", release.name, "--access", "public", "--tag", distTag]);
        console.log(`已发布 ${tag}`);
      }
      const note = notes.get(release.name);
      if (!note) throw new Error(`缺少 ${tag} 的 Release 正文`);
      writeFileSync(NOTES_FILE, note);
      const view = spawnSync(GH, ["release", "view", tag, "--json", "tagName"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (view.status === 0) {
        run(GH, ["release", "edit", tag, "--notes-file", NOTES_FILE]);
      } else {
        run(GH, ["release", "create", tag, "--title", `${release.name} ${release.version}`, "--notes-file", NOTES_FILE, "--verify-tag"]);
      }
    }
  } finally {
    rmSync(NOTES_FILE, { force: true });
  }
}

async function main(): Promise<void> {
  const [command = "bump", ...args] = process.argv.slice(2);
  if (command === "bump") await bump(args);
  else if (command === "publish") await publish(args);
  else if (command === "help" || command === "--help" || command === "-h") {
    console.log(`用法：
  bun scripts/release.ts bump [--dry-run] [--all] [--yes]
  bun scripts/release.ts publish [--dry-run]

bump     选择版本、更新 CHANGELOG、提交、创建 tag
publish  按依赖顺序发布 HEAD 上的 package tag，并创建 GitHub Release`);
  } else throw new Error(`未知命令：${command}`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
