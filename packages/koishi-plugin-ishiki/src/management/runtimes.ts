import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { AgentEvent } from "@yesimagent/core";
import type Logger from "reggol";

import type Ishiki from "../index.js";
import type { AgentRuntime } from "../runtime.js";
import { describeError, ManagementError } from "./errors.js";
import type { ManagementEventBus } from "./events.js";
import type { AuditLog } from "./observability.js";
import type { SessionsManager } from "./sessions.js";
import type { RuntimeMeta, RuntimeState, RuntimeView, RuntimeWakeResult } from "./types.js";

interface Tracked {
  state: RuntimeState;
  activeTurnId?: string;
  lastActivity?: number;
  error?: string;
}

function metaPath(home: string): string {
  return path.join(home, "runtime.json");
}

function readMeta(runtime: { id: string; home: string }): RuntimeMeta | undefined {
  const file = metaPath(runtime.home);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RuntimeMeta;
  } catch {
    return undefined;
  }
}

function domainLabel(domain: RuntimeMeta["domain"]): string {
  return domain.mode === "cross" ? "跨频道" : `${domain.platform} · ${domain.channelId}`;
}

export class RuntimesManager {
  private readonly tracked = new Map<string, Tracked>();
  private readonly metadata = new Map<string, RuntimeMeta>();
  private readonly unsubscribes = new Map<string, () => void>();
  private runtimeTimer?: NodeJS.Timeout;
  private sessionTimer?: NodeJS.Timeout;
  private readonly appended = new Map<string, { timestamp: number; profileId: string; runtimeId: string }>();

  constructor(
    private readonly host: Ishiki,
    private readonly events: ManagementEventBus,
    private readonly audit: AuditLog,
    private readonly sessions: SessionsManager,
    private readonly logger: Logger,
  ) {}

  track(runtime: AgentRuntime): void {
    this.unsubscribes.get(runtime.id)?.();
    const meta = readMeta(runtime) ?? {
      id: runtime.id,
      profileId: runtime.id.split("/")[0],
      domain: { mode: "cross" },
      createdAt: Date.now(),
    };
    this.metadata.set(runtime.id, meta);
    this.tracked.set(runtime.id, { state: "idle", lastActivity: Date.now() });
    this.unsubscribes.set(
      runtime.id,
      runtime.agent.channel.subscribe("agent", (event) => void this.observe(runtime, event)),
    );
  }

  list(): RuntimeView[] {
    this.scan();
    const views = [...this.host.runtimes.values()].map((runtime) => this.view(runtime));
    const active = new Set(views.map((view) => view.id));
    for (const [id, meta] of this.metadata) {
      if (active.has(id)) continue;
      const tracked = this.tracked.get(id);
      views.push(this.offlineView(meta, tracked));
    }
    return views.sort((left, right) => right.createdAt - left.createdAt);
  }

  read(id: string): RuntimeView {
    this.scan();
    const runtime = this.host.runtimes.get(id);
    if (runtime !== undefined) return this.view(runtime);
    const meta = this.metadata.get(id);
    if (meta === undefined) throw new ManagementError("not-found", `Runtime ${id} 不存在`);
    return this.offlineView(meta, this.tracked.get(id));
  }

  async wake(id: string, prompt: string | undefined, operator: string): Promise<RuntimeWakeResult> {
    const runtime = this.ensure(id);
    let turnId: string | undefined;
    try {
      turnId = runtime.wake(prompt);
    } catch (error) {
      const message = describeError(error).message;
      await this.audit.append({
        kind: "runtime.wake",
        operator,
        summary: `唤醒 Runtime ${id}`,
        result: "failed",
        runtimeId: id,
        profileId: this.metadata.get(id)?.profileId,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    const result: RuntimeWakeResult = { runtimeId: id, queued: turnId === undefined, turnId };
    await this.audit.append({
      kind: "runtime.wake",
      operator,
      summary: result.queued ? `Runtime ${id} 正忙，唤醒已合并` : `唤醒 Runtime ${id}`,
      result: "ok",
      runtimeId: id,
      profileId: this.metadata.get(id)?.profileId,
      detail: { queued: result.queued },
    });
    this.changed(id);
    return result;
  }

  async restart(id: string, operator: string): Promise<RuntimeView> {
    try {
      const runtime = this.host.runtimes.has(id) ? await this.host.restartRuntime(id) : this.ensure(id);
      this.track(runtime);
    } catch (error) {
      const message = describeError(error).message;
      await this.audit.append({
        kind: "runtime.restart",
        operator,
        summary: `重启 Runtime ${id}`,
        result: "failed",
        runtimeId: id,
        profileId: this.metadata.get(id)?.profileId,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    await this.audit.append({
      kind: "runtime.restart",
      operator,
      summary: `重启 Runtime ${id}`,
      result: "ok",
      runtimeId: id,
      profileId: this.metadata.get(id)?.profileId,
    });
    this.changed(id);
    return this.read(id);
  }

  async stop(id: string, operator: string): Promise<RuntimeView> {
    try {
      await this.host.deactivateRuntime(id);
    } catch (error) {
      const message = describeError(error).message;
      await this.audit.append({
        kind: "runtime.stop",
        operator,
        summary: `停止 Runtime ${id}`,
        result: "failed",
        runtimeId: id,
        profileId: this.metadata.get(id)?.profileId,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    this.tracked.set(id, { ...this.tracked.get(id), state: "stopped", activeTurnId: undefined });
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    await this.audit.append({
      kind: "runtime.stop",
      operator,
      summary: `停止 Runtime ${id}`,
      result: "ok",
      runtimeId: id,
      profileId: this.metadata.get(id)?.profileId,
    });
    this.changed(id);
    return this.read(id);
  }

  async interrupt(id: string, operator: string): Promise<RuntimeView> {
    const runtime = this.host.runtimes.get(id);
    if (runtime === undefined) throw new ManagementError("not-found", `Runtime ${id} 未在运行`);
    try {
      await runtime.agent.interrupt("console");
    } catch (error) {
      const message = describeError(error).message;
      await this.audit.append({
        kind: "runtime.interrupt",
        operator,
        summary: `中断 Runtime ${id}`,
        result: "failed",
        runtimeId: id,
        profileId: this.metadata.get(id)?.profileId,
        error: message,
      });
      throw new ManagementError("failed", message);
    }
    await this.audit.append({
      kind: "runtime.interrupt",
      operator,
      summary: `中断 Runtime ${id}`,
      result: "ok",
      runtimeId: id,
      profileId: this.metadata.get(id)?.profileId,
    });
    this.changed(id);
    return this.read(id);
  }

  dispose(): void {
    clearTimeout(this.runtimeTimer);
    clearTimeout(this.sessionTimer);
    for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
    this.unsubscribes.clear();
  }

  private scan(): void {
    const root = path.join(this.host.dataPath, "profiles");
    if (!existsSync(root)) return;
    for (const profile of readdirSync(root, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const runtimes = path.join(root, profile.name, "runtimes");
      if (!existsSync(runtimes)) continue;
      for (const directory of readdirSync(runtimes, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const home = path.join(runtimes, directory.name);
        const meta = readMeta({ id: "", home });
        if (meta !== undefined) this.metadata.set(meta.id, meta);
      }
    }
  }

  private ensure(id: string): AgentRuntime {
    this.scan();
    const runtime = this.host.runtimes.get(id);
    if (runtime !== undefined) return runtime;
    const meta = this.metadata.get(id);
    if (meta === undefined) throw new ManagementError("not-found", `Runtime ${id} 不存在`);
    const record = this.host.profiles.get(meta.profileId);
    if (record === undefined) throw new ManagementError("rejected", `Profile ${meta.profileId} 未运行，无法唤醒`);
    const domain = meta.domain.mode === "cross" ? ({ mode: "cross", channels: record.profile.channels } as const) : meta.domain;
    try {
      return this.host.ensureRuntime(meta.profileId, domain);
    } catch (error) {
      throw new ManagementError("failed", describeError(error).message);
    }
  }

  private view(runtime: AgentRuntime): RuntimeView {
    const meta = this.metadata.get(runtime.id) ??
      readMeta(runtime) ?? {
        id: runtime.id,
        profileId: runtime.id.split("/")[0],
        domain: { mode: "cross" },
        createdAt: Date.now(),
      };
    this.metadata.set(runtime.id, meta);
    const tracked = this.tracked.get(runtime.id) ?? { state: "idle" as const };
    const idle = runtime.agent.isIdle();
    const state: RuntimeState = idle && tracked.state === "running" ? "idle" : tracked.state;
    return {
      id: runtime.id,
      profileId: meta.profileId,
      mode: meta.domain.mode,
      domainLabel: domainLabel(meta.domain),
      platform: meta.domain.mode === "channel" ? meta.domain.platform : undefined,
      selfId: meta.domain.mode === "channel" ? meta.domain.selfId : undefined,
      channelId: meta.domain.mode === "channel" ? meta.domain.channelId : undefined,
      state: idle && state !== "failed" ? "idle" : state,
      activeTurnId: runtime.agent.getActiveTurnId() ?? undefined,
      createdAt: meta.createdAt,
      lastActivity: tracked.lastActivity,
      home: runtime.home,
      model: meta.model ?? "",
      engines: meta.engines ?? { context: "", wakeup: "", toolcall: "" },
      sessionId: runtime.id,
      error: tracked.error,
    };
  }

  private offlineView(meta: RuntimeMeta, tracked: Tracked | undefined): RuntimeView {
    return {
      id: meta.id,
      profileId: meta.profileId,
      mode: meta.domain.mode,
      domainLabel: domainLabel(meta.domain),
      platform: meta.domain.mode === "channel" ? meta.domain.platform : undefined,
      selfId: meta.domain.mode === "channel" ? meta.domain.selfId : undefined,
      channelId: meta.domain.mode === "channel" ? meta.domain.channelId : undefined,
      state: "stopped",
      createdAt: meta.createdAt,
      lastActivity: tracked?.lastActivity,
      home: meta.home ?? "",
      model: meta.model ?? "",
      engines: meta.engines ?? { context: "", wakeup: "", toolcall: "" },
      sessionId: meta.id,
    };
  }

  private async observe(runtime: AgentRuntime, event: AgentEvent): Promise<void> {
    const meta = this.metadata.get(runtime.id);
    const profileId = meta?.profileId;
    const current = this.tracked.get(runtime.id) ?? { state: "idle" };
    const stamp = Date.now();
    switch (event.type) {
      case "turn.start":
        this.tracked.set(runtime.id, { state: "running", activeTurnId: event.turnId, lastActivity: stamp });
        await this.record("turn.start", runtime.id, profileId, event.turnId, `轮次 ${event.turnId} 开始`);
        break;
      case "turn.done":
        this.tracked.set(runtime.id, { state: "idle", lastActivity: stamp });
        await this.record("turn.done", runtime.id, profileId, event.turnId, `轮次 ${event.turnId} 完成`, {
          usage: event.totalUsage,
        });
        break;
      case "turn.failed":
        this.tracked.set(runtime.id, {
          state: "failed",
          lastActivity: stamp,
          error: event.error?.message ?? "轮次失败",
        });
        await this.record("turn.failed", runtime.id, profileId, event.turnId, `轮次 ${event.turnId} 失败`, {
          error: event.error?.message,
        });
        break;
      case "turn.aborted":
        this.tracked.set(runtime.id, { state: "idle", lastActivity: stamp });
        await this.record("turn.aborted", runtime.id, profileId, event.turnId, `轮次 ${event.turnId} 中断`, {
          reason: event.reason,
        });
        break;
      case "tool.failed":
        await this.record("tool.failed", runtime.id, profileId, event.turnId, `工具 ${event.toolName} 调用失败`, {
          tool: event.toolName,
          error: event.error?.message,
        });
        break;
      case "message.appended":
        this.tracked.set(runtime.id, { ...current, lastActivity: stamp });
        this.appended.set(runtime.id, { timestamp: stamp, profileId: profileId ?? "", runtimeId: runtime.id });
        this.scheduleSessions();
        break;
      case "agent.stop":
        this.tracked.set(runtime.id, { state: "stopped", lastActivity: stamp });
        this.changed(runtime.id);
        break;
      default:
        return;
    }
    this.changed(runtime.id);
  }

  private async record(
    kind: string,
    runtimeId: string,
    profileId: string | undefined,
    turnId: string | undefined,
    summary: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.append({
        kind,
        operator: "runtime",
        summary,
        result: kind === "turn.failed" || kind === "tool.failed" ? "failed" : "ok",
        runtimeId,
        profileId,
        turnId,
        detail,
      });
    } catch (error) {
      this.logger.warn(`audit append failed: ${describeError(error).message}`);
    }
  }

  private changed(runtimeId: string): void {
    if (this.runtimeTimer !== undefined) return;
    this.runtimeTimer = setTimeout(() => {
      this.runtimeTimer = undefined;
      this.events.emit("runtimes.changed", { runtimeId });
    }, 200);
  }

  private scheduleSessions(): void {
    if (this.sessionTimer !== undefined) return;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      for (const [sessionId, payload] of this.appended) {
        this.sessions.notifyAppended({ id: sessionId, profileId: payload.profileId }, payload.timestamp);
      }
      this.appended.clear();
    }, 400);
  }
}
