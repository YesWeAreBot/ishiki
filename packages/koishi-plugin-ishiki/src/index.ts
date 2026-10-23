import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlugin } from "@yesimagent/core";
import { createGateway, type Gateway, type GatewayConfig } from "@yesimagent/gateway";
import { Context, Service, type Session } from "koishi";
import Logger from "reggol";
import Schema from "schemastery";
import { parse as parceYaml } from "yaml";

import { loadCodemode } from "./builtin-tools/codemode.js";
import { createFinish } from "./builtin-tools/finish.js";
import { createReadTool } from "./builtin-tools/read.js";
import { createSendMessage } from "./builtin-tools/send-message.js";
import { installConsole } from "./console/index.js";
import { ContextEngine, StandardContextEngine } from "./context/index.js";
import { createDumpFetch } from "./debugger.js";
import { Extension, type ExtensionContext } from "./extension.js";
import { FailoverModel } from "./failover.js";
import { loadInstructionFiles, renderInstructions } from "./instructions.js";
import { Management } from "./management/index.js";
import type { RuntimeMeta } from "./management/types.js";
import { directoryName, loadProfiles, matchesChannel, type InstanceDomain, type Profile } from "./profile/index.js";
import { supportsImageInput } from "./resource/capabilities.js";
import { ResourceCenter } from "./resource/center.js";
import { AgentRuntime } from "./runtime.js";
import { StandardHandler } from "./session-handler.js";
import {
  HermesToolcallEngine,
  MorphXmlToolcallEngine,
  NativeToolcallEngine,
  Qwen3CoderToolcallEngine,
  ToolcallEngine,
  YamlXmlToolcallEngine,
} from "./toolcall/index.js";
import { loadParser } from "./toolcall/parser.js";
import type { IshikiEvent } from "./types.js";
import { JevWakeupEngine, StandardWakeupEngine, WakeupEngine } from "./wakeup/index.js";

/** 一条路由：一个 profile 加它派生出来的全部 runtime。 */
interface Route {
  readonly profile: Profile;
  readonly runtimes: Map<string, AgentRuntime>;
  readonly domains: Map<string, InstanceDomain>;
  readonly spawn: (key: string, domain: InstanceDomain) => AgentRuntime;
}

export interface ProfileRecord {
  readonly profile: Profile;
  readonly runtimes: Map<string, AgentRuntime>;
  readonly externalPlugins: readonly AgentPlugin[];
  scope?: { dispose: () => boolean };
  activation?: PromiseWithResolvers<void>;
  mounted: boolean;
  stopped: Promise<void>;
}

/** 按址入口的会话坐标：host 经它把事件与唤醒路由到对应 runtime。 */
export interface SessionAddress {
  platform: string;
  selfId: string;
  channelId: string;
}

class Ishiki extends Service<Ishiki.Config> {
  static name = "ishiki";

  public readonly dataPath: string;
  public readonly logger: Logger;
  public readonly gateway: Gateway;

  private readonly handler = new StandardHandler();
  private readonly routes = new Map<string, Route[]>();
  private readonly active = new Set<Route>();
  public readonly profiles = new Map<string, ProfileRecord>();
  public readonly runtimes = new Map<string, AgentRuntime>();
  public readonly management: Management;

  constructor(ctx: Context, config: Ishiki.Config) {
    super(ctx, "ishiki");
    this.config = config;
    this.logger = ctx.logger("ishiki");
    this.logger.level = config.logLevel;

    this.dataPath = path.resolve(ctx.baseDir, config.dataPath);
    const modelConfigFile = path.resolve(this.dataPath, "models.yaml");
    if (!existsSync(modelConfigFile)) {
      this.logger.warn(`Model config file not found: ${modelConfigFile}, creating an empty one.`);
      mkdirSync(path.dirname(modelConfigFile), { recursive: true });
      writeFileSync(modelConfigFile, "");
    }
    const modelConfig = (parceYaml(readFileSync(modelConfigFile, "utf-8")) as GatewayConfig) ?? {};
    this.gateway = createGateway({
      config: modelConfig,
      fetch: this.config.dumpRequests ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.dataPath, "requests") }) : undefined,
    });

    ctx.plugin(StandardContextEngine);

    ctx.plugin(StandardWakeupEngine);
    ctx.plugin(JevWakeupEngine);

    ctx.plugin(NativeToolcallEngine);
    ctx.plugin(HermesToolcallEngine);
    ctx.plugin(Qwen3CoderToolcallEngine);
    ctx.plugin(MorphXmlToolcallEngine);
    ctx.plugin(YamlXmlToolcallEngine);

    this.management = new Management(this, ctx, this.logger);
    ctx.inject(["console"], (ctx) => installConsole(ctx, this));

    ctx.on("ready", () => void this.load());
    ctx.on("internal/session", (session) => void this.onSession(session));
    ctx.on("dispose", async () => {
      this.management.dispose();
      await Promise.all([...this.profiles.keys()].map((profileId) => this.deactivate(profileId)));
      this.active.clear();
      this.routes.clear();
      this.runtimes.clear();
    });
  }

  private async load(): Promise<void> {
    const profilesRoot = path.resolve(this.dataPath, "profiles");
    if (!existsSync(profilesRoot)) {
      this.logger.warn(`Profiles directory not found: ${profilesRoot}`);
      return;
    }

    try {
      await loadParser();
      await loadCodemode();
    } catch (error) {
      this.logger.error(`toolcall runtime unavailable, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const profile of loadProfiles(profilesRoot, this.logger)) {
      try {
        await this.activate(profile);
      } catch (error) {
        this.logger.error(`[${profile.id}] profile loading failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.management.events.emit("profiles.changed", {});
  }

  public async activate(profile: Profile, externalPlugins: readonly AgentPlugin[] = []): Promise<void> {
    if (this.profiles.has(profile.id)) throw new Error(`profile "${profile.id}" is already active`);
    await loadParser();
    await loadCodemode();

    const record: ProfileRecord = {
      profile,
      runtimes: new Map(),
      externalPlugins,
      mounted: false,
      stopped: Promise.resolve(),
    };
    const activation = Promise.withResolvers<void>();
    record.activation = activation;
    this.profiles.set(profile.id, record);
    const { settings } = profile;
    const services = [
      ...new Set([
        ...Object.keys(profile.extensions).map((name) => Extension.GetName(name)),
        ContextEngine.GetName(settings.context.engine),
        WakeupEngine.GetName(settings.wakeup.engine),
        ToolcallEngine.GetName(settings.toolcall.engine),
      ]),
    ];

    const missing = services.filter((service) => this.ctx.get(service) === undefined);
    if (missing.length > 0) {
      this.logger.error(`[${profile.id}] missing required service ${missing.map((service) => `"${service}"`).join(", ")}; profile is waiting`);
    }

    const apply = (fiber: Context): void => {
      try {
        if (this.profiles.get(profile.id) !== record) return;
        if (settings.attachment.imageInput && !supportsImageInput(this.gateway, settings.model)) {
          throw new Error(`profile imageInput requires declared image input on every candidate of "${settings.model}"`);
        }
        const toolcall = ToolcallEngine.GetService(fiber, settings.toolcall.engine);
        const failover = this.gateway.groups().includes(settings.model) || (settings.failover.attempts ?? 1) > 1;
        const model = toolcall(settings.toolcall).wrap(
          failover ? new FailoverModel(this.gateway, settings.model, settings.failover, this.logger) : this.gateway.languageModel(settings.model),
        );
        const contextProvider = ContextEngine.GetService(fiber, settings.context.engine);
        const wakeupProvider = WakeupEngine.GetService(fiber, settings.wakeup.engine);
        const instructionFiles = loadInstructionFiles(settings.instructions, profile.root);
        for (const file of instructionFiles.missing) this.logger.warn(`[${profile.id}] instruction file missing: ${file}`);
        const readLifetime = settings.attachment.imageInput && !settings.codemode.enable;
        const instructions = renderInstructions({
          enableCodemode: settings.codemode.enable,
          enableImageInput: settings.attachment.imageInput,
          enableReadLifetime: readLifetime,
          instructions: instructionFiles.text,
        });
        const extensions = Object.entries(profile.extensions).map(([name, config]) => {
          const extension = Extension.GetService(fiber, name);
          try {
            return { extension, config: extension.Schema === undefined ? config : extension.Schema(config ?? {}) };
          } catch (error) {
            throw new Error(`extension "${name}" config invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

        let mounted = true;
        const domains = new Map<string, InstanceDomain>();
        const spawn = (key: string, domain: InstanceDomain): AgentRuntime => {
          if (!mounted) throw new Error(`profile "${profile.id}" is disposed`);
          const home = path.join(profile.root, "runtimes", directoryName(key.slice(profile.id.length + 1)));
          const resources = new ResourceCenter(key, home);
          const context: ExtensionContext = { runtimeId: key, fiber, domain, home, root: profile.root, logger: this.logger, resources };
          const runtime = new AgentRuntime({
            id: key,
            home,
            model,
            instructions,
            tools: {
              read: createReadTool({ center: resources, lifetime: readLifetime }),
              send_message: createSendMessage({ ctx: this.ctx, logger: this.logger, domain, typing: settings.typing, resources }),
              finish: createFinish(),
            },
            extensions: extensions.map(({ extension, config }) => extension(config, context)).filter((ext) => ext !== undefined),
            context: contextProvider(settings.context, context),
            wakeup: wakeupProvider(settings.wakeup, context),
            codemode: settings.codemode,
            pacing: settings.pacing,
            debugStream: this.config.debugStream,
            logger: this.logger,
            resources,
            attachment: settings.attachment,
            externalPlugins,
          });
          record.runtimes.set(key, runtime);
          domains.set(key, domain);
          this.runtimes.set(key, runtime);
          const meta: RuntimeMeta = {
            id: key,
            profileId: profile.id,
            domain:
              domain.mode === "cross" ? { mode: "cross" } : { mode: "channel", platform: domain.platform, selfId: domain.selfId, channelId: domain.channelId },
            createdAt: Date.now(),
            home,
            model: settings.model,
            engines: { context: settings.context.engine, wakeup: settings.wakeup.engine, toolcall: settings.toolcall.engine },
          };
          writeFileSync(path.join(home, "runtime.json"), JSON.stringify(meta, null, 2));
          this.management.runtimes.track(runtime);
          this.logger.info(`[${profile.id}] runtime created: ${key}`);
          return runtime;
        };

        const route: Route = { profile, runtimes: record.runtimes, domains, spawn };
        for (const sid of profile.channels.keys()) {
          const list = this.routes.get(sid);
          if (list === undefined) this.routes.set(sid, [route]);
          else list.push(route);
        }
        this.active.add(route);
        record.mounted = true;
        this.logger.info(`profile "${profile.id}" activated: mode=${profile.mode}, accounts=${profile.channels.size}`);

        fiber.on("dispose", () => {
          mounted = false;
          for (const sid of profile.channels.keys()) {
            const list = this.routes.get(sid);
            const index = list?.indexOf(route) ?? -1;
            if (list !== undefined && index >= 0) list.splice(index, 1);
            if (list !== undefined && list.length === 0) this.routes.delete(sid);
          }
          this.active.delete(route);
          for (const key of record.runtimes.keys()) this.runtimes.delete(key);
          record.stopped = Promise.all([...record.runtimes.values()].map((runtime) => runtime.stop())).then(() => undefined);
          if (this.profiles.get(profile.id) === record) this.profiles.delete(profile.id);
        });
        activation.resolve();
      } catch (error) {
        this.profiles.delete(profile.id);
        activation.reject(error);
      }
    };
    Object.defineProperty(apply, "name", { value: `ishiki/profile:${profile.id}`, configurable: true });

    try {
      record.scope = this.ctx.inject([...services, "ishiki"], apply);
    } catch (error) {
      this.profiles.delete(profile.id);
      throw error;
    }
    await activation.promise;
    this.management.profiles.markApplied(profile.id);
  }

  public findProfile(profileId: string): Profile | undefined {
    return this.profiles.get(profileId)?.profile;
  }

  public findRuntime(runtimeId: string): AgentRuntime | undefined {
    return this.runtimes.get(runtimeId);
  }

  public ensureRuntime(profileId: string, domain: InstanceDomain): AgentRuntime {
    const record = this.profiles.get(profileId);
    if (record === undefined) throw new Error(`profile "${profileId}" is not active`);
    if (domain.mode !== record.profile.mode) throw new Error(`runtime domain mode does not match profile "${profileId}"`);
    const normalizedDomain: InstanceDomain =
      domain.mode === "cross"
        ? { mode: "cross", channels: record.profile.channels }
        : (() => {
            const sid = `${domain.platform}:${domain.selfId}`;
            const filter = record.profile.channels.get(sid);
            if (filter === undefined || !matchesChannel(filter, domain.channelId)) {
              throw new Error(`profile "${profileId}" does not claim ${sid}/${domain.channelId}`);
            }
            return domain;
          })();
    const key =
      normalizedDomain.mode === "cross"
        ? `${profileId}/main`
        : `${profileId}/${normalizedDomain.platform}:${normalizedDomain.selfId}/${normalizedDomain.channelId}`;
    const route = [...this.active].find((entry) => entry.profile.id === profileId);
    if (route === undefined) throw new Error(`profile "${profileId}" is not mounted`);
    return record.runtimes.get(key) ?? route.spawn(key, normalizedDomain);
  }

  public async deactivate(profileId: string): Promise<void> {
    const record = this.profiles.get(profileId);
    if (record === undefined) return;
    if (!record.mounted) {
      this.profiles.delete(profileId);
      record.activation?.reject(new Error(`profile "${profileId}" was deactivated before activation completed`));
    }
    record.scope?.dispose();
    await record.stopped;
    if (this.profiles.get(profileId) === record) this.profiles.delete(profileId);
  }

  public async restart(profileId: string): Promise<void> {
    const record = this.profiles.get(profileId);
    if (record === undefined) throw new Error(`profile "${profileId}" is not active`);
    const { profile, externalPlugins } = record;
    await this.deactivate(profileId);
    await this.activate(profile, externalPlugins);
  }

  public async deactivateRuntime(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime === undefined) return;
    for (const record of this.profiles.values()) {
      if (!record.runtimes.has(runtimeId)) continue;
      record.runtimes.delete(runtimeId);
      this.runtimes.delete(runtimeId);
      for (const route of this.active) route.domains.delete(runtimeId);
      await runtime.stop();
      return;
    }
  }

  public async restartRuntime(runtimeId: string): Promise<AgentRuntime> {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime === undefined) throw new Error(`runtime "${runtimeId}" is not active`);
    for (const route of this.active) {
      const domain = route.domains.get(runtimeId);
      if (domain === undefined) continue;
      await this.deactivateRuntime(runtimeId);
      return this.ensureRuntime(route.profile.id, domain);
    }
    throw new Error(`runtime "${runtimeId}" has no active route`);
  }

  public async deliver(runtimeId: string, event: IshikiEvent): Promise<void> {
    const runtime = this.findRuntime(runtimeId);
    if (runtime === undefined) throw new Error(`runtime "${runtimeId}" is not active`);
    await runtime.deliver(event);
  }

  public wake(runtimeId: string, prompt?: string): string | undefined {
    const runtime = this.findRuntime(runtimeId);
    if (runtime === undefined) throw new Error(`runtime "${runtimeId}" is not active`);
    return runtime.wake(prompt);
  }

  private async onSession(session: Session): Promise<void> {
    if (session.userId !== undefined && session.userId === session.selfId) return;

    const event = this.handler.handle(session);
    if (event === undefined) return;
    if (event.type !== "ishiki.message.created" && event.type !== "ishiki.message.deleted") return;

    const { platform, selfId, channelId } = event.data;
    try {
      const runtime = this.resolveRuntime({ platform, selfId, channelId });
      if (runtime) {
        await runtime.deliver(event);
      }
    } catch (error) {
      this.logger.warn(`routing failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.debug(error);
    }
  }

  private resolveRuntime(address: SessionAddress): AgentRuntime | undefined {
    const { platform, selfId, channelId } = address;
    const sid = `${platform}:${selfId}`;
    const route = this.routes.get(sid)?.find((entry) => matchesChannel(entry.profile.channels.get(sid)!, channelId));
    if (route === undefined) {
      this.logger.warn(`no profile claims ${sid}/${channelId}`);
      return;
    }

    const { profile } = route;
    const key = profile.mode === "cross" ? `${profile.id}/main` : `${profile.id}/${sid}/${channelId}`;
    const domain: InstanceDomain = profile.mode === "cross" ? { mode: "cross", channels: profile.channels } : { mode: "channel", platform, selfId, channelId };
    return route.runtimes.get(key) ?? route.spawn(key, domain);
  }
}

namespace Ishiki {
  export interface Config {
    dataPath: string;
    dumpRequests: boolean;
    debugStream: boolean;
    logLevel: number;
  }
  export const Config: Schema<Ishiki.Config> = Schema.object({
    dataPath: Schema.string().role("path").description("数据存储路径").default("data/ishiki"),
    dumpRequests: Schema.boolean().description("是否将请求数据保存到本地").default(false),
    debugStream: Schema.boolean().description("是否将模型流的分片实时输出到控制台（开发调试用）").default(false),
    logLevel: Schema.union([0, 1, 2, 3]).description("日志级别").default(Logger.INFO) as Schema<number>,
  });
}

declare module "koishi" {
  interface Context {
    ishiki: Ishiki;
  }
}

export * from "@huggingface/jinja";
export * from "@yesimagent/core";

export * from "./debugger.js";
export * from "./extension.js";
export * from "./failover.js";
export * from "./runtime.js";
export * from "./types.js";

export * from "./context/index.js";
export * from "./toolcall/index.js";
export * from "./wakeup/index.js";

export * from "./builtin-tools/index.js";
export * from "./debug/agent-overlay.js";
export * from "./profile/index.js";
export * from "./resource/index.js";

export { renderInstructions } from "./instructions.js";
export { parser as toolcallParser, type TCMProtocol, type ToolResponsePromptTemplateResult } from "./toolcall/parser.js";

export default Ishiki;
