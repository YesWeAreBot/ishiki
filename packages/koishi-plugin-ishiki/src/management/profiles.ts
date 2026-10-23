import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type Logger from "reggol";
import { parse, stringify } from "yaml";

import type Ishiki from "../index.js";
import { ProfileConfig, resolveProfile } from "../profile/index.js";
import { writeAtomic } from "./atomic.js";
import { describeError, ManagementError, redact } from "./errors.js";
import type { ManagementEventBus } from "./events.js";
import { isRecord } from "./guards.js";
import type { AuditLog, UsageLedger } from "./observability.js";
import type { RuntimesManager } from "./runtimes.js";
import type { SessionsManager } from "./sessions.js";
import type { ProfileSaveInput, ProfileState, ProfileStatus, ProfileSummary, ProfileView } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id) || id.includes("..")) throw new ManagementError("invalid", `Profile 标识无效: ${id}`);
}

interface LoadedProfile {
  text: string;
  file: string;
  raw: Record<string, unknown>;
  savedAt: number;
}

/** 补上缺省引擎，未通过校验的草稿也能原样展示。 */
function resolvedConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const engine = (key: "context" | "wakeup" | "toolcall", fallback: string) => {
    const config = isRecord(raw[key]) ? raw[key] : {};
    return { ...config, engine: typeof config.engine === "string" ? config.engine : fallback };
  };
  return {
    ...raw,
    context: engine("context", "standard"),
    wakeup: engine("wakeup", "standard"),
    toolcall: engine("toolcall", "native"),
  };
}

export class ProfilesManager {
  private readonly root: string;
  private readonly appliedAt = new Map<string, number>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly host: Ishiki,
    private readonly events: ManagementEventBus,
    private readonly audit: AuditLog,
    private readonly sessions: SessionsManager,
    private readonly usage: UsageLedger,
    private readonly runtimes: RuntimesManager,
    private readonly logger: Logger,
  ) {
    this.root = path.join(host.dataPath, "profiles");
  }

  async list(): Promise<ProfileSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const summaries: ProfileSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      try {
        summaries.push(await this.summary(entry.name));
      } catch (error) {
        this.logger.warn(`[profile:${entry.name}] ${describeError(error).message}`);
      }
    }
    return summaries.sort((left, right) => left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<ProfileView> {
    assertId(id);
    const [summary, loaded] = await Promise.all([this.summary(id), this.load(id)]);
    const instructions = await this.instructionFiles(id, loaded.raw);
    const persona = instructions.find((file) => !file.missing);
    return {
      ...summary,
      config: resolvedConfig(loaded.raw),
      persona: persona === undefined ? "" : await readFile(path.join(this.root, id, persona.path), "utf8").catch(() => ""),
      instructions,
      runtimes: this.runtimes.list().filter((runtime) => runtime.profileId === id),
      sessionCount: (await this.sessions.list({ profileId: id })).length,
    };
  }

  async status(id: string): Promise<ProfileStatus> {
    assertId(id);
    const [summary, loaded] = await Promise.all([this.summary(id), this.load(id)]);
    return {
      id,
      state: summary.state,
      active: this.host.profiles.has(id),
      savedAt: loaded.savedAt,
      appliedAt: this.appliedAt.get(id),
      revision: summary.revision,
      lastError: this.errors.get(id),
      runtimes: [...(this.host.profiles.get(id)?.runtimes.keys() ?? [])],
    };
  }

  async save(id: string, input: ProfileSaveInput, revision: string, operator: string): Promise<ProfileView> {
    assertId(id);
    const loaded = await this.load(id);
    if (digest(loaded.text) !== revision) {
      throw new ManagementError("conflict", "Profile 已被其他操作者修改，请刷新后重试");
    }

    let config: Record<string, unknown>;
    try {
      config = ProfileConfig(input.config as unknown as ProfileConfig) as unknown as Record<string, unknown>;
    } catch (error) {
      throw new ManagementError("invalid", `Profile 配置无效: ${this.describe(error)}`);
    }

    const target = input.persona === undefined ? undefined : await this.personaPath(id, config);
    if (input.persona !== undefined && target !== undefined) await mkdir(path.resolve(target, ".."), { recursive: true });
    await writeAtomic(loaded.file, stringify(config, { lineWidth: 0 }));
    if (target !== undefined && input.persona !== undefined) await writeAtomic(target, input.persona);

    const next = await this.read(id);
    await this.audit.append({
      kind: "profile.save",
      operator,
      summary: `保存 Profile ${id}`,
      result: "ok",
      profileId: id,
      target: id,
      revision: next.revision,
    });
    this.events.emit("profiles.changed", { profileId: id, revision: next.revision });
    return next;
  }

  async apply(id: string, operator: string): Promise<ProfileView> {
    return this.activate(id, operator, "profile.apply", "应用 Profile");
  }

  async reload(id: string, operator: string): Promise<ProfileView> {
    return this.activate(id, operator, "profile.reload", "重新加载 Profile");
  }

  async stop(id: string, operator: string): Promise<ProfileStatus> {
    assertId(id);
    try {
      if (this.host.profiles.has(id)) await this.host.deactivate(id);
    } catch (error) {
      const message = this.describe(error);
      this.errors.set(id, message);
      await this.audit.append({
        kind: "profile.stop",
        operator,
        summary: `停止 Profile ${id}`,
        result: "failed",
        profileId: id,
        target: id,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    this.errors.delete(id);
    await this.audit.append({
      kind: "profile.stop",
      operator,
      summary: `停止 Profile ${id}`,
      result: "ok",
      profileId: id,
      target: id,
    });
    this.events.emit("profiles.changed", { profileId: id });
    return this.status(id);
  }

  async remove(id: string, operator: string): Promise<void> {
    assertId(id);
    if (this.host.profiles.has(id)) {
      throw new ManagementError("rejected", "Profile 正在运行，先停止再删除");
    }
    const loaded = await this.load(id);
    await this.usage.sync();
    try {
      await rm(path.join(this.root, id), { recursive: true, force: true });
    } catch (error) {
      const message = `删除 Profile 失败: ${this.describe(error)}`;
      await this.audit.append({
        kind: "profile.remove",
        operator,
        summary: `删除 Profile ${id}`,
        result: "failed",
        profileId: id,
        target: id,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    this.appliedAt.delete(id);
    this.errors.delete(id);
    await this.audit.append({
      kind: "profile.remove",
      operator,
      summary: `删除 Profile ${id}`,
      result: "ok",
      profileId: id,
      target: id,
      revision: digest(loaded.text),
    });
    this.events.emit("profiles.changed", { profileId: id });
  }

  public markApplied(id: string): void {
    this.appliedAt.set(id, Date.now());
    this.errors.delete(id);
  }

  private async activate(id: string, operator: string, kind: string, label: string): Promise<ProfileView> {
    assertId(id);
    const loaded = await this.load(id);
    let profile;
    try {
      profile = resolveProfile(loaded.raw, id, path.join(this.root, id));
    } catch (error) {
      const message = this.describe(error);
      this.errors.set(id, message);
      await this.audit.append({
        kind,
        operator,
        summary: `${label} ${id}`,
        result: "failed",
        profileId: id,
        target: id,
        error: message,
      });
      throw new ManagementError("invalid", message);
    }

    try {
      if (this.host.profiles.has(id)) await this.host.deactivate(id);
      await this.host.activate(profile);
    } catch (error) {
      const message = this.describe(error);
      this.errors.set(id, message);
      await this.audit.append({
        kind,
        operator,
        summary: `${label} ${id}`,
        result: "failed",
        profileId: id,
        target: id,
        error: message,
      });
      throw new ManagementError("failed", message);
    }

    this.appliedAt.set(id, Date.now());
    this.errors.delete(id);
    await this.audit.append({
      kind,
      operator,
      summary: `${label} ${id}`,
      result: "ok",
      profileId: id,
      target: id,
      revision: digest(loaded.text),
    });
    this.events.emit("profiles.changed", { profileId: id, revision: digest(loaded.text) });
    return this.read(id);
  }

  private async summary(id: string): Promise<ProfileSummary> {
    const loaded = await this.load(id);
    const record = this.host.profiles.get(id);
    const state: ProfileState = record === undefined ? "inactive" : record.mounted ? "active" : "loading";
    return {
      id,
      model: typeof loaded.raw.model === "string" ? loaded.raw.model : "",
      mode: loaded.raw.mode === "cross" ? "cross" : "channel",
      channels: Object.keys((loaded.raw.channels as Record<string, unknown> | undefined) ?? {}),
      state,
      runtimeCount: record?.runtimes.size ?? 0,
      savedAt: loaded.savedAt,
      appliedAt: this.appliedAt.get(id),
      revision: digest(loaded.text),
      lastError: this.errors.get(id),
    };
  }

  private async load(id: string): Promise<LoadedProfile> {
    const directory = path.join(this.root, id);
    for (const name of ["profile.yml", "profile.yaml"]) {
      const file = path.join(directory, name);
      try {
        const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        const raw = parse(text);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          throw new ManagementError("invalid", `Profile ${id} 的配置不是对象`);
        }
        return { text, file, raw: raw as Record<string, unknown>, savedAt: info.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof ManagementError) throw error;
        throw new ManagementError("invalid", `Profile ${id} 配置无法读取: ${this.describe(error)}`);
      }
    }
    throw new ManagementError("not-found", `Profile ${id} 不存在`);
  }

  private async instructionFiles(id: string, raw: Record<string, unknown>): Promise<Array<{ path: string; missing: boolean }>> {
    const listed = Array.isArray(raw.instructions) ? raw.instructions : ["PERSONA.md"];
    const files: Array<{ path: string; missing: boolean }> = [];
    for (const item of listed) {
      if (typeof item !== "string" || item.length === 0) continue;
      const target = path.isAbsolute(item) ? item : path.join(this.root, id, item);
      const info = await stat(target).catch(() => undefined);
      files.push({ path: item, missing: info === undefined });
    }
    return files;
  }

  private async personaPath(id: string, config: Record<string, unknown>): Promise<string | undefined> {
    const listed = Array.isArray(config.instructions) ? config.instructions : ["PERSONA.md"];
    const first = listed.find((item): item is string => typeof item === "string" && item.length > 0);
    if (first === undefined || path.isAbsolute(first)) return undefined;
    const root = path.join(this.root, id);
    const target = path.resolve(root, first);
    const relativePath = path.relative(root, target);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new ManagementError("rejected", `人格文件必须位于 Profile 目录内: ${first}`);
    }
    return target;
  }

  private describe(error: unknown): string {
    return redact(describeError(error).message, []);
  }
}
