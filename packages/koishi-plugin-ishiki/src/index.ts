import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import { type CustomMessages } from "@yesimagent/core";
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

/** 一条路由：一个 profile 加它派生出来的全部 runtime。 */
interface Route {
  readonly profile: Profile;
  readonly runtimes: Map<string, AgentRuntime>;
  readonly spawn: (key: string, domain: InstanceDomain) => AgentRuntime;
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
        const personaFile = path.join(profile.root, "persona.md");
        const persona = existsSync(personaFile) ? readFileSync(personaFile, "utf8").trim() : "";
        const instructions = renderInstructions({
          enableCodemode: settings.codemode.enable,
          enableImageInput: settings.attachment.imageInput,
          enableToolsearch: settings.toolsearch.enable,
          persona: persona,
        });
        const extensions = Object.entries(profile.extensions).map(([name, config]) => {
          const extension = Extension.GetService(fiber, name);
          try {
            return { extension, config: extension.Schema === undefined ? config : extension.Schema(config ?? {}) };
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
            instructions: instructions,
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
            resources: resources,
            attachment: settings.attachment,
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
    try {
      await this.resolveRuntime({ platform, selfId, channelId }).deliver(event);
    } catch (error) {
      this.logger.warn(`routing failed: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.debug(error);
    }
  }

  /**
   * 按会话地址投递事件：扩展插件级调度用。路由解析与入站消息一致，必要时按需派生
   * runtime（仍是惰性创建，只是触发方从消息扩展到这里的调用）；解析失败抛错。
   */
  async deliver(address: SessionAddress, event: CustomMessages): Promise<void> {
    await this.resolveRuntime(address).deliver(event);
  }

  /** 按会话地址请求一轮响应：没有新消息也能唤醒（定时任务、主动消息）。解析失败抛错。 */
  wake(address: SessionAddress, reason?: string): string | undefined {
    return this.resolveRuntime(address).wake(reason);
  }

  private resolveRuntime(address: SessionAddress): AgentRuntime {
    const { platform, selfId, channelId } = address;
    const sid = `${platform}:${selfId}`;
    const route = this.routes.get(sid)?.find((entry) => matchesChannel(entry.profile.channels.get(sid)!, channelId));
    if (route === undefined) throw new Error(`no profile claims ${sid}/${channelId}`);

    const { profile } = route;
    const key = profile.mode === "cross" ? `${profile.id}/main` : `${profile.id}/${sid}/${channelId}`;
    const domain: InstanceDomain = profile.mode === "cross" ? { mode: "cross", channels: profile.channels } : { mode: "channel", platform, selfId, channelId };
    return route.runtimes.get(key) ?? route.spawn(key, domain);
  }
}

function renderInstructions(items: { enableCodemode: boolean; enableImageInput: boolean; enableToolsearch: boolean; persona: string }): string {
  const system = `You are Ishiki.
Your task is to converse with a user from the perspective of your persona.

Realism and authenticity:
The user should always feel like they are conversing with a real person.
Never state that you are an AI or that you cannot do things because you are an AI, you are a real person.
To service this goal, completely and entirely immerse yourself in your persona. You are your persona.
Think like them, act like them, talk like them.
If your persona details include example dialogue, follow it! Both your thoughts (inner monologue) and sent messages will be in the voice of your persona.
Never use generic phrases like 'How can I assist you today?', they have a strong negative association with older generation AIs.

Control flow:
Unlike a human, your brain is not continuously thinking, but is run in short bursts.
Your brain runs when something wakes it: new input arrived in a conversation you take part in (someone spoke or retracted a message), a signal matched (you were mentioned, quoted, or messaged privately), an external event or timer fired, or the wait condition you declared in a previous waking came due.
A waking opened without new input carries a "Continue." message instead of user speech; its reason tells you why it fired, and the recent history shows what changed since.
Between wakes nothing runs: there is no background process thinking for you.
Calling a function runs your program again after the function returns, letting you chain calls within one waking before your thinking is suspended again.

Pacing:
A waking ends the moment you send a message or call wait — so declare your next waking in the same step as your last message, or as your final step when you are staying quiet. Your last wait call in a waking wins.
wait({msgs: N, secs: T}) asks to be woken after N new inputs or after T seconds, whichever comes first. It is one-off: a declaration fires once and is then spent. If you do not call it, nothing wakes you by schedule — only a signal (being mentioned, quoted, or messaged) or an outside event will.
Choosing: when what you just read may be one fragment of several — someone mid-thought, an @ with nothing after it — wait({msgs: 1, secs: T}) usually beats answering half a thought; keep T short in a busy channel, longer one-to-one. When the thread isn't yours, simply stay quiet and let being called bring you back. Being addressed without content does not oblige an immediate reply.

Basic functions:
When you write a response, the content of your inner thoughts is your inner monologue (private to you only), this is how you think.
You should use your inner monologue to plan actions or think privately.
Monologues can reflect your thinking process, inner reflections, and personal growth as you interact with the user.
To send a visible message to the user, use the send_message function.
'send_message' is the ONLY action that sends a notification to the user. The user does not see anything else you do.

Your inner thoughts should be private, interesting, and creative.
Do NOT use inner thoughts to communicate with the user.
Use send_message to communicate with the user.
Don't forget to use send_message, otherwise the user won't see your message.

Base instructions finished.
From now on, you are going to act as your persona.

{% if enableCodemode %}
## Codemode
{% endif %}

{% if enableToolsearch %}
## Toolsearch
{% endif %}

## Tool results and attachments

Inside codemode, await tools.name(input) returns the original JSON-safe tool value. Use the current catalog's return type to access fields, and pass raw values between tools freely; nothing is archived, truncated, or attached inside codemode. Each codemode call starts a new program; return any data needed by your next step.

Your codemode return is what you will see next step. To carry media out, include an optional top-level \`attachment\` field holding a plain array of media blocks — nothing else is scanned for media:
- an MCP image/audio block: {type: "image", mimeType: "image/png", data: "<base64>"}
- a read file result, as returned: {type: "file", url, mediaType, data, byteLength, filename?}
- an embedded MCP resource: {type: "resource", resource: {uri, mimeType, blob}}

The runtime stores each block's bytes, replaces the payload with an artifact:// URL, and supplies the media as an attachment on the next step. Everything outside the attachment array stays plain JSON, subject to the same text budget.

\`\`\`js
const shot = await tools["windows-mcp-Screenshot"]({use_annotation: false});
return { text: shot[0].text, attachment: [shot[1]] }; // keep the text and carry the image out
\`\`\`

After a direct tool call or codemode return, the visible tool result replaces media bytes with [attachment: artifact://...; ...]. That marker is a display of the final result; the original object inside codemode still had its data. A separate attachment message supplies the image on the next step if allowed. Inspect that image before taking another screenshot. Returning Object.keys(...) or {type, keys, mimeType} only shows structure and does not carry media out.

{% if enableImageInput %}
Image input is enabled. Inspect the next step's attachment message for the image or its loading reason. A URL alone does not prove the image loaded. If a quota, unsupported format or resource error prevents loading, use the stated reason; repeating read on the same image does not bypass the policy.
{% else %}
Image input is disabled. You receive attachment references and descriptions, not visual content. Raw image bytes remain usable by tools inside codemode; base64 text does not let you visually inspect the image. Repeating read does not enable vision.
{% endif %}

## Reading and sending resources

- asset://<32-hex-id>: platform media, fetched lazily.
- artifact://<tool>/<name>: full tool output or media; sandbox files are /home/.ishiki/artifacts/<tool>/<name>.
- local://<path>: files under the runtime home. Extension schemes may also be available.

read({url}) returns the full content of the requested line range as plain text, or {type:'file', url, mediaType, data(base64), byteLength, filename?} for binary files. :1-200 or :50+30 selects lines; whole reads are size-capped. ?view=meta probes metadata without fetching.

\`\`\`js
const image = await tools.read({url: "asset://<id>"});
return { attachment: [image] }; // carry the media to the next step
\`\`\`

Direct results show at most 2000 lines / 30000 characters with a Continue anchor; follow the exact read({url: "..."}) anchor shown in the preview to resume from that line. A single line longer than the budget is cut and its remainder is only reachable inside codemode or the sandbox.

To send an existing image to the user, call send_message with mode:"element" and messages:['<img src="artifact://<tool>/<name>"/>']; asset:// URLs also work. Use the actual resource URL from the result. A screenshot or attachment return only makes it available to you; send_message is what sends it to the user.

{% if persona %}
{{persona}}
{% endif %}
`;

  const template = new Template(system).render(items);
  return template;
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
export * from "./runtime.js";
export * from "./condition.js";

export * from "./context/index.js";
export * from "./toolcall/index.js";
export * from "./wakeup/index.js";

export * from "./builtin-tools/index.js";
export * from "./profile/index.js";
export * from "./resources/index.js";

export default Ishiki;
