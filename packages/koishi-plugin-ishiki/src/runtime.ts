import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import {
  createAgent,
  createJsonlStorage,
  ToolConflictError,
  type Agent,
  type AgentEvent,
  type AgentStorage,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolCallers,
  type ToolSet,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { parse } from "yaml";

import { ContextEngine, type ContextEngineInstance } from "./context/index.js";
import { claimLines, type InstanceDomain } from "./domain.js";
import { type Extension, type ExtensionHandler } from "./extension.js";
import { FailoverModel } from "./failover.js";
import { assertNoOverlap, CROSS_KEY, matchSceneSpec, resolveProfile, sceneDirectoryName, type CodemodeConfig, type SceneSpec } from "./profile.js";
import { ToolcallEngine } from "./toolcall/index.js";
import { CODE_MODE, createCodemode } from "./tools/codemode.js";
import { createFinish } from "./tools/finish.js";
import { withInnerThoughts } from "./tools/inner-thoughts.js";
import { createSendMessage } from "./tools/send-message.js";
import type { IshikiEvent } from "./types.js";
import { WakeupEngine, type WakeupEngineInstance } from "./wakeup/index.js";

/** 实例键，同时是目录名的来源：sid 与 channelId 一并编码，避免不同账号下的同名频道冲突。 */
function channelKey(sid: string, channelId: string): string {
  return `${sid}/${channelId}`;
}

/** 包内 resources/ 下的路径；ESM 与 CJS 构建都能用（CJS 下 import.meta 为空，靠 __dirname）。 */
function resourcePath(...segments: string[]): string {
  let here: string;
  if (import.meta.url) {
    here = path.dirname(new URL(import.meta.url).pathname);
    // Windows 下 URL 的 pathname 以 /C:/… 开头，去掉这个多余的斜杠。
    if (process.platform === "win32" && here.startsWith("/")) here = here.slice(1);
  } else {
    // eslint-disable-next-line no-restricted-globals -- CJS 全局，ESM 类型定义里没有
    here = __dirname;
  }
  return path.resolve(here, "..", "resources", ...segments);
}

/** 一个频道实例的完整运行配置：落址、目录，以及已就绪的构造件。 */
export interface AgentRuntimeConfig {
  /** 实例标识，用于日志与 agent id。 */
  label: string;
  /** 本实例的数据目录，`events.jsonl` 及后续的附件都在里面。 */
  home: string;
  /** 所属 profile 的目录：`profile.yaml` 与人设都在这一层，`home` 是它的下属。 */
  root: string;
  model: LanguageModel;
  /** 平台能力与其它 Koishi 服务的入口；扩展包挂载期间经它取用别的服务。 */
  ctx: Context;
  /** 本实例的可见域。 */
  domain: InstanceDomain;
  /** 平台能力之外的模型入口；上下文引擎要自己调模型时用它。 */
  gateway: Gateway;
  /** 基础提示词：内核那一段（身份与处境），聚合形态的地址簿跟在后面。扩展包的在它们之后。 */
  instructions: string;
  context: ContextEngineInstance;
  /** 内核工具面（`send_message` 与 `finish`）。扩展包的增量每轮加在它之上。 */
  tools: ToolSet;
  /**
   * 本实例启用的扩展包，按 profile 配置里的书写顺序。包名到 handler 的解析由所属生效单位完成，
   * 这里只按顺序各叫一次这个 handler。
   */
  extensions: Array<{ handler: ExtensionHandler; config: unknown }>;
  /** 是否给整份工具面前置 `inner_thoughts`；扩展包加的工具一并覆盖。 */
  innerThoughts: boolean;
  /** 代码模式配置；收窄每轮在扩展增量之后进行，所以包这一轮给的工具照样进沙箱表。 */
  codemode: CodemodeConfig;
  /** 唤醒引擎运行体：本实例一份，账本只记本视窗的事实流。 */
  wakeup: WakeupEngineInstance;
  logger: Logger;
}

/** 一次工具调用的键：优先用 provider 给的 id，缺了就用轮次加名字兜底。 */
function toolCallKey(event: { turnId: string; toolName: string; toolCallId?: string }): string {
  return event.toolCallId ?? `${event.turnId}:${event.toolName}`;
}

/** 距离起点过了多少毫秒；起点缺席（没见到对应的 start 事件）时不报数。 */
function formatElapsed(startedAt: number | undefined): string {
  return startedAt === undefined ? "elapsed=?" : `elapsed=${Date.now() - startedAt}ms`;
}

/** 一步的用量。provider 少给字段就少报字段，不拿 0 冒充。 */
function formatUsage(usage: Partial<LanguageModelUsage> | undefined): string {
  if (usage === undefined) return "usage=?";
  const parts = [`in=${usage.inputTokens ?? "?"}`, `out=${usage.outputTokens ?? "?"}`, `total=${usage.totalTokens ?? "?"}`];
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  if (cached !== undefined) parts.push(`cached=${cached}`);
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  if (reasoning !== undefined) parts.push(`reasoning=${reasoning}`);
  return `usage(${parts.join(" ")})`;
}

/** 收尾类工具名。停轮判定按名读消息流；这两个名字是内核机制的一部分，不由工具注册决定。 */
const FINISH_TOOL = "finish";
const SEND_MESSAGE_TOOL = "send_message";

/** 一 Scene = 一 Channel = 一 Agent。 */
export class AgentRuntime {
  /** 实例标识，用于日志与 agent id。 */
  readonly label: string;
  /** 本实例的数据目录，`events.jsonl` 在里面。 */
  readonly home: string;
  /** 所属 profile 的目录：`profile.yaml` 与 profile 级配置（如 `mcp.json`）从它定位。 */
  readonly root: string;
  readonly storage: AgentStorage;
  /** 平台能力与其它 Koishi 服务的入口。扩展包挂载期间经它取用别的服务。 */
  readonly ctx: Context;
  /** 本实例的可见域：单频道视窗给出那个频道，聚合视窗给出认领的账号与各自名单。 */
  readonly domain: InstanceDomain;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngineInstance;
  private readonly context: ContextEngineInstance;
  private readonly agent: Agent;
  /** 本实例挂上的扩展包：它们的钩子每轮现取，这里只留着贡献物本身。 */
  private readonly extensions: Extension[] = [];
  /** 扩展包各自交回的拆卸函数，按挂载先后入队；停止时逆序执行，先挂的后拆。 */
  private readonly disposers: Array<() => void> = [];
  /** 事件自身不带时间戳，跨度只能在这一侧相减：起点由对应的 start 事件记下。 */
  private readonly toolStartedAt = new Map<string, number>();
  private readonly stepStartedAt = new Map<string, number>();

  constructor(config: AgentRuntimeConfig) {
    this.label = config.label;
    this.home = config.home;
    this.root = config.root;
    this.ctx = config.ctx;
    this.domain = config.domain;
    this.logger = config.logger;
    this.wakeup = config.wakeup;
    this.context = config.context;

    mkdirSync(this.home, { recursive: true });
    this.storage = createJsonlStorage(path.join(this.home, "events.jsonl"));

    // 扩展包在 Agent 诞生之前挂上：每个包交回一个有限的加法贡献物，这里只登记、不取用。
    // 取用发生在 core 每轮第一步的那两个钩子里（见下面的 extendTools / extendInstructions）。
    for (const { handler, config: profileConfig } of config.extensions) {
      try {
        const extension = handler(profileConfig, this);
        if (extension === undefined) continue;
        this.extensions.push(extension);
        const { dispose } = extension;
        if (dispose !== undefined) this.disposers.push(() => dispose());
      } catch (error) {
        // 装配失败就等于这个实例从未存在：已登记的挂载按逆序拆掉，不给包留悬挂的引用。
        // 包自己在返回 Extension 之前开的资源由它自己负责——内核拿不到 Extension 就拆不了。
        for (const dispose of this.disposers.splice(0).reverse()) dispose();
        throw error;
      }
    }

    // 代码模式只改工具面：宿主工具一件不动，模型目录收窄成只剩沙箱那一件。
    // 表与工具面同源，所以工具面每轮重算时表也重填，core 读的是这个对象的引用。
    const toolCallers: ToolCallers = {};

    this.agent = createAgent({
      id: this.label,
      model: config.model,
      storage: this.storage,
      // core 只见一个插件：上下文引擎与停轮判定在这一点收拢。
      plugins: [
        {
          name: "ishiki",
          init: (agent) => {
            const disposeContext = this.context.attach?.(agent);
            if (disposeContext) this.disposers.push(disposeContext);
            const disposeWakeup = this.wakeup.attach?.(agent);
            if (disposeWakeup) this.disposers.push(disposeWakeup);
            const unsubscribe = agent.channel.subscribe("agent", (event) => this.logEvent(event));
            this.disposers.push(unsubscribe);
          },
          // 上下文两段加工：一段段往下传。引擎缺席或返回 undefined 都表示这一步不改，原样放行。
          transformEntries: (entries, options) => this.context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries,
          transformMessages: (messages, options) => this.context.renderMessages?.(messages, { turnId: options.turnId, signal: options.signal }) ?? messages,
          // 提示词段每轮现算：内核那一段（聚合形态的地址簿在其中）→ 扩展增量（按 extends 顺序）
          // → 上下文引擎那一段。空段不占位，免得拼出一串空行。
          extendInstructions: async () => {
            const parts = [config.instructions];
            for (const extension of this.extensions) {
              const contributed = await extension.extendInstructions?.();
              if (contributed !== undefined && contributed.length > 0) parts.push(contributed);
            }
            const extended = (await this.context.instructions?.()) ?? "";
            if (extended.length > 0) parts.push(extended);
            return parts.filter((text) => text.length > 0).join("\n\n");
          },
          // 工具面每轮现算：内核工具 → 扩展增量（按 extends 顺序，与内核工具或先装的包撞名抛错）
          // → innerThoughts 前置 → 代码模式收窄。core 每轮第一步来取一次，这里不缓存；
          // 跨轮稳定由包自己在钩子里保证。逐个 await：顺序就是拼装顺序，也是撞名的判定顺序。
          extendTools: async () => {
            const merged: ToolSet = { ...config.tools };
            for (const extension of this.extensions) {
              const contributed = await extension.extendTools?.();
              if (contributed === undefined) continue;
              for (const [name, tool] of Object.entries(contributed)) {
                if (name in merged) throw new ToolConflictError(name);
                merged[name] = tool;
              }
            }
            const base = config.innerThoughts ? withInnerThoughts(merged, this.logger) : merged;
            if (!config.codemode.enable) return base;
            const sandbox = createCodemode(config.codemode, base);
            // 先清旧键：上一轮收窄过的工具不能永远留在表里。
            for (const name of Object.keys(toolCallers)) delete toolCallers[name];
            Object.assign(toolCallers, sandbox.callers);
            return { ...base, [CODE_MODE]: sandbox.tool };
          },
          // 停轮：唯一决策点，读本步消息流。finish 出现即停；否则发言（send_message 直调且全部
          // continue!==true 且结果全成功）且本步没有别的实义工具时停；其余交 core 默认。
          // 发言判定展开在这一点：只见本步消息，逐条找 send_message 的调用与结果——调用缺席判未发言，
          // continue:true 是模型显式要求续轮（发了话但话没说完），error-text（执行抛错）与 ok:false 都算没说成，
          // 部分失败（同批发送中一条 ok:false）判未完成，轮次留给模型看到失败再决定重试或改口。
          onStepFinish: (info) => {
            const calls = new Set<string>();
            let sending = false;
            // 显式要求续轮：话没说完，直接判不能停。
            let continueRequested = false;
            for (const message of info.result.messages) {
              if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
              for (const part of message.content) {
                if (part.type !== "tool-call") continue;
                calls.add(part.toolName);
                if (part.toolName !== SEND_MESSAGE_TOOL) continue;
                if ((part.input as { continue?: boolean } | undefined)?.continue === true) {
                  continueRequested = true;
                  break;
                }
                sending = true;
              }
              if (continueRequested) break;
            }

            // 发言是否完成：本步每个 send_message 结果是否成功。
            let sentOk = sending;
            for (const message of info.result.messages) {
              if (!sentOk) break;
              if (message.role !== "tool" || !Array.isArray(message.content)) continue;
              for (const part of message.content) {
                if (part.type !== "tool-result" || part.toolName !== SEND_MESSAGE_TOOL) continue;
                if (part.output.type === "error-text" || part.output.type === "error-json") {
                  sentOk = false;
                  break;
                }
                const value = part.output.type === "json" ? part.output.value : undefined;
                if ((value as { ok?: boolean } | undefined)?.ok !== true) {
                  sentOk = false;
                  break;
                }
              }
            }

            const others = [...calls].some((name) => name !== FINISH_TOOL && name !== SEND_MESSAGE_TOOL);
            if (calls.has(FINISH_TOOL) || (!others && calls.has(SEND_MESSAGE_TOOL) && !continueRequested && sentOk)) {
              return { continue: false };
            }
            return undefined;
          },
        },
      ],
      // core 的配置字段叫 toolCallers；它转发给 streamText 时才改名为 experimental_toolCallers。
      // 传的是那个可变对象本身：表每轮被重填，core 读的是引用。
      ...(config.codemode.enable ? { toolCallers } : {}),
    });
  }

  /**
   * agent 事件的日志面。`tool.done` 与 `turn.step` 是仅有的两个带数据的边界：
   * 前者报本次工具调用的耗时，后者报这一步的用量、结束原因与耗时；其余事件只记类型。
   * 步耗时自上一步结束（首个步自 turn.start）算起，含该步的模型流与其中的工具调用。
   */
  private logEvent(event: AgentEvent): void {
    const tag = `[${this.label}]`;

    switch (event.type) {
      case "turn.start":
        this.stepStartedAt.set(event.turnId, Date.now());
        break;
      case "turn.step": {
        const startedAt = this.stepStartedAt.get(event.turnId);
        this.stepStartedAt.set(event.turnId, Date.now());
        this.logger.debug(
          `${tag} turn.step #${event.stepNumber} ${formatUsage(event.usage)} finish=${event.finishReason ?? "unknown"} ${formatElapsed(startedAt)}`,
        );
        return;
      }
      case "turn.done":
        this.stepStartedAt.delete(event.turnId);
        break;
      case "turn.failed":
      case "turn.aborted":
        this.stepStartedAt.delete(event.turnId);
        break;
      case "tool.start":
        this.toolStartedAt.set(toolCallKey(event), Date.now());
        break;
      case "tool.done":
        this.logger.debug(`${tag} tool.done ${event.toolName} ${formatElapsed(this.toolStartedAt.get(toolCallKey(event)))}`);
        this.toolStartedAt.delete(toolCallKey(event));
        return;
      case "tool.failed":
        this.toolStartedAt.delete(toolCallKey(event));
        break;
      case "message.appended":
        if (event.message.role === "assistant" && Array.isArray(event.message.content)) {
          const text = event.message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
          this.logger.debug(`${tag} message.appended ${event.message.role} "${text}"`);
        }
        break;
      default:
        // 其余事件没有要算的量，落到下面统一记一行类型。
        break;
    }

    if (event.type === "turn.failed") {
      this.logger.warn(`${tag} turn failed: ${event.error?.message ?? "unknown error"}`);
      return;
    }
    this.logger.debug(`${tag} ${event.type}`);
  }

  /** 向该频道投递一条事件：按唤醒结果决定只写入事件流还是触发一轮。 */
  async deliver(event: IshikiEvent): Promise<void> {
    const trigger = (await this.wakeup.decide(event)) === "trigger";
    this.agent.send(event, { trigger, ifBusy: "join" });
  }

  /** 等待当前轮次结束。 */
  async idle(): Promise<void> {
    await this.agent.wait();
  }

  async stop(): Promise<void> {
    await this.agent.stop();
    // 逆序拆：后挂的包可能用着先挂的包开的资源，先挂的拆了就悬空。
    for (const dispose of this.disposers.splice(0).reverse()) await dispose();
  }
}

export interface ProfileRuntimeOptions {
  /** 本 profile 的 id，即它的目录名。 */
  id: string;
  /** 这个 profile 的目录：`profile.yaml`、`persona.md`、`scenes/` 与 `cross/` 都在里面。 */
  root: string;
  /** 本 profile 的装配清单；加载后不变。 */
  specs: SceneSpec[];
  /** 本 profile 启用的扩展包：包名到 `config` 原样内容，按书写顺序。 */
  extensions: Record<string, unknown>;
  ctx: Context;
  gateway: Gateway;
  logger: Logger;
}

/**
 * 一个 profile 的激活单元：清单与按需长出来的频道实例，生命周期跟着自己那条 fiber。
 * 与任何服务无关的东西（目录、清单）在构造时立住；引擎与扩展包等到实例诞生才取，因此依赖缺席时
 * 这条 fiber 停住，服务回来再重建——事实流在盘上，连续性不丢。
 */
export class ProfileRuntime {
  readonly id: string;

  private readonly specs: SceneSpec[];
  /** 启用的扩展包，包名到 config；provider 每次实例化时现取，服务因此不必被 profile 记住。 */
  private readonly extensions: Record<string, unknown>;
  private readonly root: string;
  private readonly ctx: Context;
  private readonly logger: Logger;
  private readonly gateway: Gateway;
  private readonly scenes: Record<string, AgentRuntime | undefined> = {};
  /** 提示词源码按 profile 缓存一次；当前频道在渲染时注入。 */
  private persona?: string;
  private systemTemplate?: string;

  constructor(options: ProfileRuntimeOptions) {
    this.id = options.id;
    this.specs = options.specs;
    this.extensions = options.extensions;
    this.root = options.root;
    this.ctx = options.ctx;
    this.logger = options.logger;
    this.gateway = options.gateway;
  }

  /** 按事件定位其归属频道实例，未创建时按需创建。 */
  route(event: IshikiEvent): AgentRuntime | undefined {
    const { platform, selfId, channelId } = event.data;
    const spec = matchSceneSpec(this.specs, { sid: `${platform}:${selfId}`, channelId });
    if (spec === undefined) return undefined;
    return this.ensure(spec, platform, channelId, selfId);
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.scenes).map((scene) => scene?.stop()));
  }

  /**
   * 按需创建实例：首次有事件落到它头上时创建，同时初始化目录、引擎与存储。
   * 装配的唯一决策点：模型、上下文引擎、唤醒引擎、工具调用层都随本实例在此诞生，
   * 随实例停止一起销毁——生命周期只有「实例」一种单位，不再有 profile 级的共享活物。
   *
   * 实例坐标随形态分岔：非聚合形态是 `(sid, channelId)`，每个频道一块视窗；聚合形态整块视窗
   * 只有一处，claims 里的全部频道汇进同一份 `events.jsonl`——合流的范围就是声明处所写的那些行。
   */
  private ensure(spec: SceneSpec, platform: string, channelId: string, selfId: string): AgentRuntime {
    const cross = spec.cross;
    const key = cross ? CROSS_KEY : channelKey(spec.sid, channelId);
    const existing = this.scenes[key];
    if (existing !== undefined) return existing;

    /** 聚合形态的认领账号；非聚合形态取不到 claims，缺席即坐标唯一。 */
    const accounts = cross ? Object.entries(spec.claims ?? {}).map(([sid, claim]) => ({ sid, claim })) : [];
    const domain: InstanceDomain = cross ? { form: "cross", accounts } : { form: "channel", platform: platform, selfId: selfId, channelId };
    // 普通形态一个频道一个子目录；cross 形态整块视窗就一个 `cross/`，与 scene 名同字。
    const home = cross ? path.join(this.root, CROSS_KEY) : path.join(this.root, "scenes", sceneDirectoryName(key));
    const baseTools: ToolSet = {
      send_message: createSendMessage({
        ctx: this.ctx,
        logger: this.logger,
        domain,
        typing: spec.typing,
      }),
      finish: createFinish(),
    };

    // 扩展包按 profile 配置里的书写顺序挂到这一个实例上。取不到服务只有一种可能：这条 fiber 已经
    // 把它声明为依赖，装配次序错了，或服务卸载后旧引用还在用。抛错，不静默跳过。
    const extensions = Object.entries(this.extensions).map(([pkg, config]) => {
      // 这里的 `this.ctx` 是 Ishiki 插件自己的 ctx，它的 inject 链里没有 `ishiki`（就是它提供的），
      // 属性访问 `ctx.ishiki` 因此每次都被 cordis 记一条 not-registered 警告。取法与同类处一致：走 `ctx.get`。
      const handler = this.ctx.get("ishiki")?.getExtension(pkg);
      if (handler === undefined) throw new Error(`extension service "ishiki.ext.${pkg}" is not available`);
      return { handler, config };
    });

    // 引擎在这里从各自的 provider 诞生，随本实例同生共死：provider 只管造，运行状态都在运行体里，
    // 上下文引擎记着本实例的 agent 与压缩水位，唤醒引擎的账本只看本视窗的事实流，不跨实例共享。
    // provider 都已由 profile 的 fiber 声明为依赖，这里取一次即可。
    const failover = this.gateway.groups().includes(spec.model) || (spec.failover.attempts ?? 1) > 1;
    const raw = failover ? new FailoverModel(this.gateway, spec.model, spec.failover, this.logger) : this.gateway.languageModel(spec.model);
    const toolcall = ToolcallEngine.GetService(this.ctx, spec.toolcall.engine);
    const model = toolcall(spec.toolcall).wrap(raw);

    const contextProvider = ContextEngine.GetService(this.ctx, spec.context.engine);
    const context = contextProvider(spec.context, {
      logger: this.logger,
      gateway: this.gateway,
      // 引擎的数据目录是 profile 目录，不是实例目录：记忆块这类 profile 级资料在这里读写。
      directory: this.root,
      resources: resourcePath(),
      domain: domain,
    });

    const wakeupProvider = WakeupEngine.GetService(this.ctx, spec.wakeup.engine);
    const wakeup = wakeupProvider(spec.wakeup, {
      logger: this.logger,
    });

    // 系统提示词：内核那一段（身份与处境）在前，聚合形态的地址簿居中，扩展包的加法在最后。
    const instructionTexts = [this.instructions()];
    if (cross) {
      /** 认领模式逐行写成 `sid/模式`；地址簿与工具的报错文本都取这一份，不各算一次。 */
      const { reachable, excluded } = claimLines(accounts);
      instructionTexts.push(
        [
          "本视窗合并了下列频道，每段事实行前的 [ #坐标 ] 标出它的出处，正文行自带发送者。",
          "发言时用 send_message 的 target 显式写明坐标：单值写频道号，跨账号时写 sid/频道号。",
          "可达频道：",
          // 写认领模式而不是频道清单：认领通常写成 `group:*` 这类通配，逐个频道要等运行时才知道，
          // 模式本身才是配置者写下的那句事实。坐标校验也按同一份模式判，两边不会漂。
          ...reachable.map((line) => `- ${line}`),
          // 排除项也要说：它们在认领范围里但不达，不写出来模型会照着模式反复试。
          ...(excluded.length === 0 ? [] : ["排除：", ...excluded.map((line) => `- ${line}`)]),
        ].join("\n"),
      );
    }
    const scene = new AgentRuntime({
      label: cross ? `${this.id}/${spec.name}` : `${this.id}/${spec.name}/${channelId}`,
      home,
      root: this.root,
      model,
      // 聚合形态把可达地址清单拼进 instructions：坐标不进工具 schema（每个工具都挂一份会让工具目录膨胀），
      // 模型的出发点只有系统提示与事实行上的寻址头。非聚合形态照旧不带地址簿。
      instructions: instructionTexts.filter((text) => text.length > 0).join("\n\n"),
      ctx: this.ctx,
      domain,
      gateway: this.gateway,
      context: context,
      tools: baseTools,
      extensions,
      innerThoughts: spec.innerThoughts,
      codemode: spec.codemode,
      wakeup: wakeup,
      logger: this.logger,
    });
    this.scenes[key] = scene;
    this.logger.info(`[${this.id}/${spec.name}] scene created: ${key}`);
    return scene;
  }

  private instructions(): string {
    if (this.persona === undefined) this.persona = readSnippet(path.join(this.root, "persona.md")) ?? "";
    if (this.systemTemplate === undefined) this.systemTemplate = readFileSync(resourcePath("templates", "system.jinja"), "utf8");

    const rendered = new Template(this.systemTemplate).render({});
    return [rendered.trim(), this.persona].filter((part) => part.length > 0).join("\n\n");
  }
}

/** 读一段文本，文件不存在返回 undefined。 */
function readSnippet(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/** 一份装载就绪的 profile：清单已展开，尚未实例化——等它依赖的服务就位才激活。 */
export interface ProfileLoad {
  /** 目录名，全局唯一标识。 */
  id: string;
  /** profile 目录，`profile.yaml` 与 persona 都在里面。 */
  root: string;
  /** 本 profile 的装配清单；加载后不变。 */
  specs: SceneSpec[];
  /** 本 profile 启用的扩展包：包名到 `config` 原样内容，按书写顺序。 */
  extensions: Record<string, unknown>;
  /** 依赖的服务名：启用的扩展包，加上各 spec 最终用到的三个引擎变体。 */
  services: string[];
}

/**
 * 算一个 profile 依赖的服务：启用的扩展包与每个最终 spec 的三个引擎变体。
 * 引擎从展开后的 spec 扫描而不是读原始配置——scene 覆盖出来的引擎也算这个 profile 的依赖。
 * 扩展包在展开时已滤掉 `enable: false` 的项，剩下的逐个都是必需依赖：没有可选包这条线。
 */
function profileServices(specs: readonly SceneSpec[], extensions: Record<string, unknown>): string[] {
  const names = specs.flatMap((spec) => [
    ContextEngine.GetName(spec.context.engine),
    WakeupEngine.GetName(spec.wakeup.engine),
    ToolcallEngine.GetName(spec.toolcall.engine),
  ]);
  return [...new Set([...Object.keys(extensions).map((pkg) => `ishiki.ext.${pkg}`), ...names])];
}

/**
 * 扫描 profile 根目录并解析出全部可装载项：每个子目录读一份 profile.yml 或 profile.yaml，目录名即 id。
 * 坏掉的目录只跳过它自己（错误各记一条），其余照常装载。
 * 频道归属在这一步统一判定：一个频道只能属于一个 spec，与已接收的清单相交的那一份整体跳过。
 * 实例化不在这里——它按 profile 各开一条 fiber，等自己依赖的服务（扩展包与引擎变体）就位（见 `activateProfiles`）。
 */
export function loadProfiles(root: string, logger: Logger): ProfileLoad[] {
  const loads: ProfileLoad[] = [];
  const claimed: SceneSpec[] = [];
  // 排序后处理：冲突时谁被跳过由目录名决定，不随文件系统的枚举顺序摇摆。
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = ["profile.yml", "profile.yaml"].map((name) => path.join(root, entry.name, name)).find((candidate) => existsSync(candidate));
    if (file === undefined) {
      logger.warn(`no profile.yml under "${entry.name}", directory skipped`);
      continue;
    }
    try {
      const resolved = resolveProfile(parse(readFileSync(file, "utf8")), entry.name);
      // 比较的是「已接收的 + 这一份」的全量：profile 内两个 scene 撞上同一频道同样要拦。
      assertNoOverlap([...claimed, ...resolved.specs]);
      claimed.push(...resolved.specs);
      loads.push({
        id: resolved.id,
        root: path.join(root, entry.name),
        specs: resolved.specs,
        extensions: resolved.extensions,
        services: profileServices(resolved.specs, resolved.extensions),
      });
    } catch (error) {
      logger.error(`[${entry.name}] profile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (loads.length === 0) {
    logger.warn(`No profile to load under ${root}`);
  }

  return loads;
}

/**
 * 装载后的第二步：一个 profile 一条 fiber，等自己依赖的服务（扩展包与引擎变体）就位才激活，
 * 服务被卸载则这条 fiber 复位：运行体停止并摘出路由表；服务回来再重建（事实流在盘上，连续性不丢）。
 * 门控与拆卸都由 cordis 管，这里只写「建」与「停」。
 *
 * 服务此刻缺席只记一条 error 就放行：缺席是可恢复的等待态，不是装配失败——后加载的服务
 * 一到，cordis 自己会把这条 fiber 拉起来。装配失败是另一回事（provider 在，调用 provider 抛错），
 * 那一条留给 cordis 的 fiber 报。
 *
 * 建出的运行体推进调用方给的数组：调用方（`Ishiki`）按同一个引用做路由。
 */
export function activateProfiles(loads: readonly ProfileLoad[], profiles: ProfileRuntime[], deps: { ctx: Context; gateway: Gateway; logger: Logger }): void {
  for (const load of loads) {
    const apply = (fiber: Context) => {
      const profile = new ProfileRuntime({ id: load.id, root: load.root, specs: load.specs, extensions: load.extensions, ...deps });
      profiles.push(profile);
      deps.logger.info(`profile "${profile.id}" loaded: ${load.specs.length} scene spec(s)`);
      fiber.on("dispose", () => {
        const index = profiles.indexOf(profile);
        if (index >= 0) profiles.splice(index, 1);
        void profile.stop();
      });
    };
    // cordis 拿回调名当插件名：日志与面板里要能认出是哪个 profile。
    Object.defineProperty(apply, "name", { value: `ishiki/profile:${load.id}`, configurable: true });
    const missing = load.services.filter((service) => deps.ctx.get(service) === undefined);
    if (missing.length > 0) {
      deps.logger.error(`[${load.id}] missing required service ${missing.map((service) => `"${service}"`).join(", ")}; profile is waiting`);
    }
    deps.ctx.inject(load.services, apply);
  }
}
