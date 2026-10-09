import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import { createGateway, type Gateway, type GatewayConfig } from "@yesimagent/gateway";
import { Context, Logger, Schema, Service, type Session } from "koishi";
import { parse } from "yaml";

import { supportsImageInput } from "./attachment/capabilities.js";
import { loadCodemode } from "./builtin-tools/codemode.js";
import { createFinish } from "./builtin-tools/finish.js";
import { createReadTool } from "./builtin-tools/read.js";
import { createSendMessage } from "./builtin-tools/send-message.js";
import { ContextEngine, StandardContextEngine, V3ContextEngine } from "./context/index.js";
import { createDumpFetch } from "./debugger.js";
import { Extension, type ExtensionContext } from "./extension.js";
import { FailoverModel } from "./failover.js";
import { directoryName, loadProfiles, matchesChannel, type InstanceDomain, type Profile } from "./profile/index.js";
import { ResourceCenter } from "./resources/center.js";
import { AgentRuntime } from "./runtime.js";
import { StandardHandler } from "./session-handler.js";
import {
  HermesToolcallEngine,
  MorphXmlToolcallEngine,
  NativeToolcallEngine,
  Qwen3CoderToolcallEngine,
  ToolcallEngine,
  V3ToolcallEngine,
  YamlXmlToolcallEngine,
} from "./toolcall/index.js";
import { loadParser } from "./toolcall/parser.js";
import { JevWakeupEngine, StandardWakeupEngine, V3WakeupEngine, WakeupEngine } from "./wakeup/index.js";

// 内联自 resource.ts：包内 resources 目录的绝对路径。
// 从当前文件向上找到包根（含 package.json 的目录），兼容源码布局与打包后的单文件布局。
let here = import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname;
if (process.platform === "win32" && here.startsWith("/")) here = here.slice(1);
while (!existsSync(path.join(here, "package.json"))) here = path.dirname(here);
const RESOURCES_DIR = path.join(here, "resources");

/** 一条路由：一个 profile 加它派生出来的全部 runtime。 */
interface Route {
  readonly profile: Profile;
  readonly runtimes: Map<string, AgentRuntime>;
  readonly spawn: (key: string, domain: InstanceDomain) => AgentRuntime;
}

class Ishiki extends Service<Ishiki.Config> {
  static name = "ishiki";

  public readonly dataPath: string;
  public readonly logger: Logger;
  public readonly gateway: Gateway;

  private readonly handler = new StandardHandler();
  private readonly routes = new Map<string, Route[]>();
  private readonly active = new Set<Route>();

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
    const modelConfig = (parse(readFileSync(modelConfigFile, "utf-8")) as GatewayConfig) ?? {};
    this.gateway = createGateway({
      config: modelConfig,
      fetch: this.config.dumpRequests ? createDumpFetch({ logger: this.logger, directory: path.resolve(this.dataPath, "requests") }) : undefined,
    });

    ctx.plugin(StandardContextEngine);
    ctx.plugin(V3ContextEngine);

    ctx.plugin(StandardWakeupEngine);
    ctx.plugin(V3WakeupEngine);
    ctx.plugin(JevWakeupEngine);

    ctx.plugin(NativeToolcallEngine);
    ctx.plugin(V3ToolcallEngine);
    ctx.plugin(HermesToolcallEngine);
    ctx.plugin(Qwen3CoderToolcallEngine);
    ctx.plugin(MorphXmlToolcallEngine);
    ctx.plugin(YamlXmlToolcallEngine);

    ctx.on("ready", () => void this.load());
    ctx.on("internal/session", (session) => void this.onSession(session));
    ctx.on("dispose", async () => {
      const runtimes = [...this.active].flatMap((route) => [...route.runtimes.values()]);
      this.active.clear();
      this.routes.clear();
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
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

    try {
      for (const profile of loadProfiles(profilesRoot, this.logger)) this.activate(profile);
    } catch (error) {
      this.logger.error(`profile loading failed, nothing loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activate(profile: Profile): void {
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
        // profile 级装配只做一次：模型、引擎 provider、扩展 Service、instructions。
        if (settings.resources.imageInput && !supportsImageInput(this.gateway, settings.model)) {
          throw new Error(`profile imageInput requires declared image input on every candidate of "${settings.model}"`);
        }
        const toolcall = ToolcallEngine.GetService(fiber, settings.toolcall.engine);
        const failover = this.gateway.groups().includes(settings.model) || (settings.failover.attempts ?? 1) > 1;
        const model = toolcall(settings.toolcall).wrap(
          failover ? new FailoverModel(this.gateway, settings.model, settings.failover, this.logger) : this.gateway.languageModel(settings.model),
        );
        const contextProvider = ContextEngine.GetService(fiber, settings.context.engine);
        const wakeupProvider = WakeupEngine.GetService(fiber, settings.wakeup.engine);
        const instructions = renderInstructions(profile.root);
        const extensions = Object.entries(profile.extensions).map(([name, config]) => {
          const extension = Extension.GetService(fiber, name);
          try {
            return { extension, config: extension.parse(config) };
          } catch (error) {
            throw new Error(`extension "${name}" config invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

        const runtimes = new Map<string, AgentRuntime>();
        const spawn = (key: string, domain: InstanceDomain): AgentRuntime => {
          const home = path.join(profile.root, "runtimes", directoryName(key.slice(profile.id.length + 1)));
          const resources = new ResourceCenter(key, home);
          const context: ExtensionContext = { runtimeId: key, fiber, domain, home, root: profile.root, logger: this.logger, resources };
          const runtime = new AgentRuntime({
            id: key,
            home,
            model,
            instructions: [instructions, resourceSchemeDoc(settings.resources.imageInput)].filter(Boolean).join("\n\n"),
            tools: {
              read: createReadTool({ center: resources }),
              send_message: createSendMessage({ ctx: this.ctx, logger: this.logger, domain, typing: settings.typing, resources }),
              finish: createFinish(),
            },
            extensions: extensions.map(({ extension, config }) => extension(config, context)).filter((ext) => ext !== undefined),
            context: contextProvider(settings.context, context),
            wakeup: wakeupProvider(settings.wakeup, context),
            codemode: settings.codemode,
            toolsearch: settings.toolsearch,
            debugStream: this.config.debugStream,
            logger: this.logger,
            resources,
            attachmentPolicy: settings.resources,
          });
          runtimes.set(key, runtime);
          this.logger.info(`[${profile.id}] runtime created: ${key}`);
          return runtime;
        };

        const route: Route = { profile, runtimes, spawn };
        for (const sid of profile.channels.keys()) {
          const list = this.routes.get(sid);
          if (list === undefined) this.routes.set(sid, [route]);
          else list.push(route);
        }
        this.active.add(route);
        this.logger.info(`profile "${profile.id}" activated: mode=${profile.mode}, accounts=${profile.channels.size}`);

        fiber.on("dispose", () => {
          for (const sid of profile.channels.keys()) {
            const list = this.routes.get(sid);
            const index = list?.indexOf(route) ?? -1;
            if (list !== undefined && index >= 0) list.splice(index, 1);
            if (list !== undefined && list.length === 0) this.routes.delete(sid);
          }
          this.active.delete(route);
          void Promise.all([...runtimes.values()].map((runtime) => runtime.stop()));
        });
      } catch (error) {
        this.logger.error(`[${profile.id}] profile activation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    Object.defineProperty(apply, "name", { value: `ishiki/profile:${profile.id}`, configurable: true });
    this.ctx.inject(services, apply);
  }

  private async onSession(session: Session): Promise<void> {
    if (session.userId !== undefined && session.userId === session.selfId) return;

    const event = this.handler.handle(session);
    if (event === undefined) return;
    if (event.type !== "ishiki.message.created" && event.type !== "ishiki.message.deleted") return;

    const { platform, selfId, channelId } = event.data;
    const sid = `${platform}:${selfId}`;
    const route = this.routes.get(sid)?.find((entry) => matchesChannel(entry.profile.channels.get(sid)!, channelId));
    if (route === undefined) return;

    const { profile } = route;
    const key = profile.mode === "cross" ? `${profile.id}/main` : `${profile.id}/${sid}/${channelId}`;
    const domain: InstanceDomain = profile.mode === "cross" ? { mode: "cross", channels: profile.channels } : { mode: "channel", platform, selfId, channelId };

    try {
      const runtime = route.runtimes.get(key) ?? route.spawn(key, domain);
      await runtime.deliver(event);
    } catch (error) {
      this.logger.warn(`routing failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.debug(error);
    }
  }
}

function renderInstructions(root: string): string {
  const personaFile = path.join(root, "persona.md");
  const persona = existsSync(personaFile) ? readFileSync(personaFile, "utf8").trim() : "";
  const template = new Template(readFileSync(path.join(RESOURCES_DIR, "templates", "system.jinja"), "utf8")).render({});
  return [template.trim(), persona].filter((part) => part.length > 0).join("\n\n");
}

/** One-paragraph system-prompt doc for the resource URL space, driven by live extensions. */
function resourceSchemeDoc(imageInput: boolean): string {
  return [
    "## Resources",
    "",
    "Return structured results from codemode; do not stringify or slice media or large results. Internal tool values stay JSON-safe and unmodified. The runtime archives final media and full long results, then supplies text previews and attachment references.",
    "Use read({url}) to read resources. Text pages contain at most 2000 lines / 30000 characters. Use :1-200 or :50+30 for lines, and the returned #offset=N continuation (UTF-16 characters, including newlines).",
    "Append ?view=meta for metadata without downloading, or artifact ?view=original for the original JSON/text instead of its stable readable view. Original text is also paged.",
    "- asset://<32-hex-id>: platform media, fetched lazily.",
    "- artifact://<tool>/<name>: original tool media or full output; sandbox files are /home/.ishiki/artifacts/<tool>/<name>.",
    "- local://<path>: files under the runtime home. Extension schemes may also be available.",
    "read returns base64 file bytes inside codemode even for text-only models. Unchanged read files reuse their source; modified files become new artifacts.",
    imageInput
      ? "Attachments are projected into user image parts subject to the request-wide image quota."
      : "Attachments remain references and descriptions because image input is disabled.",
  ].join("\n");
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

export * from "@yesimagent/core";

export * from "./extension.js";
export * from "./profile/index.js";
export * from "./runtime.js";

export * from "./context/index.js";
export * from "./toolcall/index.js";
export * from "./wakeup/index.js";
export * from "./resources/index.js";
export * from "./builtin-tools/index.js";

export default Ishiki;
