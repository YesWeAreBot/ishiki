import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import {
  createAgent,
  createJsonlStorage,
  type Agent,
  type AgentEvent,
  type AgentPlugin,
  type AgentStorage,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { parse } from "yaml";

import { contextEngineServiceName, type ContextEngine, type ContextEngineInstance, type ContextEngines } from "./context/index.js";
import type { InstanceDomain } from "./domain.js";
import { type Disposer, type ExtensionHandler, type ExtensionService, extensionServiceName } from "./extension.js";
import { FailoverModel } from "./failover.js";
import {
  claimsChannel,
  engineParams,
  matchSceneSpec,
  resolveProfile,
  sceneDirectoryName,
  type CodemodeConfig,
  type ResolvedPreset,
  type SceneSpec,
} from "./profile.js";
import { toolcallEngineServiceName, type ToolcallEngine, type ToolcallEngines } from "./toolcall/index.js";
import { CODE_MODE, createCodemode } from "./tools/codemode.js";
import { createFinish } from "./tools/finish.js";
import { withInnerThoughts } from "./tools/inner-thoughts.js";
import { createSendMessage } from "./tools/send-message.js";
import type { IshikiEvent } from "./types.js";
import { wakeupEngineServiceName, type WakeupEngine, type WakeupEngineInstance, type WakeupEngines } from "./wakeup/index.js";

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

/**
 * 从 Service 取引擎 provider。preset 的 fiber 已把这些服务声明为依赖，取不到只有一种可能：
 * 装配次序错了（instances 先于服务诞生，或服务被卸载后旧引用还在用）。抛错而不回退到内置实现。
 */
function engineProvider<T>(ctx: Context, service: string): T {
  const provider = ctx.get(service) as T | undefined;
  if (provider === undefined) throw new Error(`engine service "${service}" is not available`);
  return provider;
}

/** 一个频道实例的完整运行配置：落址、目录，以及已就绪的构造件。 */
export interface AgentRuntimeConfig {
  /** 实例标识，用于日志与 agent id。 */
  label: string;
  /** 该频道号；聚合视窗取首个触发它的频道，仅用于日志。 */
  channelId: string;
  /** 该频道的独立目录，存放 `events.jsonl` 及后续的附件。 */
  directory: string;
  model: LanguageModel;
  /** 平台能力与其它 Koishi 服务的入口；扩展包经 {@link AgentRuntime.addTools} 一类的挂载面用到它。 */
  ctx: Context;
  /** 本实例的可见域。 */
  domain: InstanceDomain;
  /** 平台能力之外的模型入口；上下文引擎要自己调模型时用它。 */
  gateway?: Gateway;
  /** 基础提示词：内核那一段（身份与处境），聚合形态的地址簿跟在后面。扩展包的在它们之后。 */
  instructions: string;
  /**
   * 上下文引擎的造法：由所属生效单位从 provider 取到，不在这里造实例。
   *
   * 推迟到 AgentRuntime 构造期，是因为引擎要看的工具面与提示词要到扩展包挂完才定。
   * 提前造就等于让它拿着半份上下文开工。
   */
  context: ContextEngine;
  /** 该引擎名下的参数块：profile 与 scene 合并后的结果，可能为空。 */
  contextParams: Partial<ContextEngines[keyof ContextEngines]>;
  /** 内核工具面（`send_message` 与 `finish`）。扩展包在构造期间往这里加，加完才算定。 */
  tools: ToolSet;
  /**
   * 本实例启用的扩展包，按 preset 配置里的书写顺序。包名到 provider 的解析由所属生效单位完成，
   * 这里只按顺序各叫一次 `provide()`。
   */
  extensions: Array<{ handler: ExtensionHandler; config: unknown }>;
  /** 是否给整份工具面前置 `inner_thoughts`；扩展包加的工具一并覆盖。 */
  innerThoughts: boolean;
  /** 代码模式配置；收窄在扩展包加完工具之后进行，所以包的工具也进得了沙箱表。 */
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

/**
 * core 侧的插件：上下文引擎与停轮判定在这一点收拢成 core 见的唯一入口。
 *
 * 上下文引擎说自己干预上下文哪几段，方法名是它自己的；core 的钩子名只出现在这个函数里，
 * 按固定顺序转发过去。停轮判定读本步消息流，不设跨步标志：嵌套调用（code mode 沙箱内）的
 * 结果不落 step messages，扫描天然看不见它们，于是程序内说过的、做过的都不结束轮次，
 * 轮次的收尾只由直调产生。
 */
export function createAgentPlugin(parts: { context: ContextEngineInstance }): AgentPlugin {
  const { context } = parts;
  const disposers: Array<() => void> = [];
  return {
    name: "ishiki",
    // 引擎要在 agent 上挂东西（订阅、压缩水位），收尾控制没有。
    init: (agent) => {
      const disposer = context.attach?.(agent);
      if (disposer) disposers.push(disposer);
    },
    stop: async () => {
      for (const dispose of disposers) dispose();
    },
    // 上下文两段加工：一段段往下传。引擎缺席或返回 undefined 都表示这一步不改，原样放行。
    transformEntries: (entries, options) => context.prepareEntries?.(entries, { turnId: options.turnId, signal: options.signal }) ?? entries,
    transformMessages: (messages, options) => context.renderMessages?.(messages, { turnId: options.turnId, signal: options.signal }) ?? messages,
    // 引擎给出的那一段提示词接在内核拼好的提示词之后。
    extendInstructions: () => context.instructions?.(),
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
  };
}

/** 收尾类工具名。停轮判定按名读消息流；这两个名字是内核机制的一部分，不由工具注册决定。 */
const FINISH_TOOL = "finish";
const SEND_MESSAGE_TOOL = "send_message";

/** 一 Scene = 一 Channel = 一 Agent。 */
export class AgentRuntime {
  /** 实例标识，用于日志与 agent id。 */
  readonly label: string;
  readonly channelId: string;
  readonly directory: string;
  readonly storage: AgentStorage;
  /** 平台能力与其它 Koishi 服务的入口。扩展包挂载期间经它取用别的服务。 */
  readonly ctx: Context;
  /** 本实例的可见域：单频道视窗给出那个频道，聚合视窗给出认领的账号与各自名单。 */
  readonly domain: InstanceDomain;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngineInstance;
  private readonly agent: Agent;
  /** 唤醒引擎这次挂载的拆卸函数：场景停止时调它，取消订阅并丢掉这次挂载攒下的账。 */
  private disposeWakeup?: () => void;
  /** 装配期的工具面：内核工具先落进来，扩展包逐个往上加，加完才交给 core。 */
  private readonly tools: ToolSet;
  /** 扩展包交回来的提示词段，按包的挂载顺序；收尾时接在内核那一段与地址簿之后。 */
  private readonly addedTexts: string[] = [];
  /** 扩展包各自交回的拆卸函数，按挂载先后入队；停止时逆序执行，先挂的后拆。 */
  private readonly disposers: Disposer[] = [];
  /** 装配是否仍在进行：只在这段里 `addTools` / `addInstructions` 可用，Agent 诞生后工具面即固定。 */
  private assembling = true;
  /** 事件自身不带时间戳，跨度只能在这一侧相减：起点由对应的 start 事件记下。 */
  private readonly toolStartedAt = new Map<string, number>();
  private readonly stepStartedAt = new Map<string, number>();

  constructor(config: AgentRuntimeConfig) {
    this.label = config.label;
    this.channelId = config.channelId;
    this.directory = config.directory;
    this.ctx = config.ctx;
    this.domain = config.domain;
    this.logger = config.logger;
    this.wakeup = config.wakeup;

    mkdirSync(this.directory, { recursive: true });
    this.storage = createJsonlStorage(path.join(this.directory, "events.jsonl"));

    // 扩展包在 Agent 诞生之前加法：工具面与提示词都还没定下来，撞名在这里抛，
    // 代码模式的收窄表也还看得见包加的工具。往后这个口就关了——工具面在实例生命周期内固定。
    this.tools = { ...config.tools };
    for (const { handler, config: presetConfig } of config.extensions) {
      try {
        const dispose = handler(presetConfig, this);
        if (dispose !== undefined) this.disposers.push(dispose);
      } catch (error) {
        // 装配失败就等于这个实例从未存在：已拿到拆卸函数的挂载按逆序拆掉，不给包留悬挂的引用。
        // 包自己在返回拆卸函数之前开的资源由它自己负责——内核拿不到拆卸函数就拆不了。
        for (const dispose of this.disposers.splice(0).reverse()) dispose();
        throw error;
      }
    }

    const base = config.innerThoughts ? withInnerThoughts(this.tools, this.logger) : this.tools;
    const instructions = [config.instructions, ...this.addedTexts].filter((text) => text.length > 0).join("\n\n");

    // 上下文引擎到这里才造：它的工具面与提示词两项依赖，此刻才算定。
    // `base` 是模型目录收窄之前的那份——沙箱工具还没算进去，引擎看到的是本实例真实提供的工具，
    // 不是代码模式改写后的投影。
    const context = config.context.create(config.contextParams, {
      logger: this.logger,
      gateway: config.gateway,
      directory: this.directory,
      resources: resourcePath(),
      domain: this.domain,
      tools: base,
      instructions,
    });

    // 代码模式只改工具面：宿主工具一件不动，模型目录收窄成只剩沙箱那一件。
    // 收窄与沙箱工具是同一次装配的两半——表里点名的进沙箱，没点名的留在目录。
    const sandbox = config.codemode.enable ? createCodemode(config.codemode, base) : undefined;

    this.agent = createAgent({
      id: this.label,
      model: config.model,
      instructions,
      storage: this.storage,
      // core 只见一个插件：上下文引擎与停轮判定在这一点收拢。
      plugins: [createAgentPlugin({ context })],
      tools: sandbox === undefined ? base : { ...base, [CODE_MODE]: sandbox.tool },
      // core 的配置字段叫 toolCallers；它转发给 streamText 时才改名为 experimental_toolCallers。
      ...(sandbox === undefined ? {} : { toolCallers: sandbox.callers }),
    });
    this.assembling = false;

    // 引擎自己订阅事实流、读存储；运行时不替它转述发生了什么，也不告诉它记账归谁——
    // 账的归属由事实流里每条消息自带的频道号给出，跨频道聚合与单频道走同一份代码。
    this.disposeWakeup = config.wakeup.attach?.(this.agent);
    this.agent.channel.subscribe("agent", (event) => this.logEvent(event));
  }

  /**
   * 往本实例的工具面加一组工具：与内核工具或先挂的包撞名在这里抛错，不静默覆盖。
   * 只在装配期（Agent 诞生之前）可用，之后工具面固定。
   */
  addTools(tools: ToolSet): void {
    if (!this.assembling) throw new Error(`[${this.label}] tools are fixed once the agent exists`);
    for (const [name, value] of Object.entries(tools)) {
      if (name in this.tools) throw new Error(`tool "${name}" is already provided`);
      this.tools[name] = value;
    }
  }

  /** 追加一段系统提示词，位置在内核那一段与地址簿之后；按 {@link AgentRuntimeConfig.extensions} 的顺序接续。 */
  addInstructions(instructions: string): void {
    if (!this.assembling) throw new Error(`[${this.label}] instructions are fixed once the agent exists`);
    if (instructions.length > 0) this.addedTexts.push(instructions);
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
    this.disposeWakeup?.();
    // 与扩展包的拆卸同一个道理：拆卸函数随实例走一次，重复 stop 不再摘第二次。
    this.disposeWakeup = undefined;
    await this.agent.stop();
    // 逆序拆：后挂的包可能用着先挂的包开的资源，先挂的拆了就悬空。
    for (const dispose of this.disposers.splice(0).reverse()) await dispose();
  }
}

export interface ProfileRuntimeOptions {
  id: string;
  /** 这个 profile 的目录，`scenes/` 与 `persona.md` 都在里面。 */
  directory: string;
  ctx: Context;
  gateway: Gateway;
  logger: Logger;
}

/**
 * 一份人设的运行态：常驻的路由壳 + 已激活的 preset 单元。
 * 宿主在装载时立住，不随扩展服务起落；可运行的只有 preset 单元——每个 preset 等自己的依赖（见 `activateProfiles`），
 * 一个在等或坏掉，不影响兄弟。
 */
export class ProfileRuntime {
  readonly id: string;

  private readonly ctx: Context;
  private readonly logger: Logger;
  private readonly gateway: Gateway;
  private readonly directory: string;
  private readonly scenesDir: string;
  /** 已激活的 preset 单元；fiber 建立时加入，拆卸或停止时摘出。 */
  private readonly presets: PresetRuntime[] = [];
  /** 提示词源码按 profile 缓存一次；当前频道在渲染时注入。 */
  private persona?: string;
  private systemTemplate?: string;

  constructor(options: ProfileRuntimeOptions) {
    this.id = options.id;
    this.ctx = options.ctx;
    this.logger = options.logger;
    this.gateway = options.gateway;
    this.directory = options.directory;
    this.scenesDir = path.join(options.directory, "scenes");
  }

  /** 激活一份 preset：它依赖的扩展服务就位后由 fiber 调用。 */
  activate(load: ResolvedPreset): PresetRuntime {
    const preset = new PresetRuntime({
      name: load.name,
      specs: load.specs,
      extensions: load.extensions,
      directory: this.directory,
      scenesDir: this.scenesDir,
      ctx: this.ctx,
      gateway: this.gateway,
      logger: this.logger,
      instructions: () => this.instructions(),
    });
    this.presets.push(preset);
    this.logger.info(`[${this.id}/${preset.name}] preset active: ${load.specs.length} scene spec(s)`);
    return preset;
  }

  /** 摘掉一个 preset 单元：返回它此前是否处于激活状态，调用方据此决定要不要再停一次。 */
  deactivate(preset: PresetRuntime): boolean {
    const index = this.presets.indexOf(preset);
    if (index < 0) return false;
    this.presets.splice(index, 1);
    return true;
  }

  /** 按事件在已激活的 preset 里定位其归属频道实例，未创建时按需创建。 */
  route(event: IshikiEvent): AgentRuntime | undefined {
    for (const preset of this.presets) {
      const scene = preset.route(event);
      if (scene !== undefined) return scene;
    }
    return undefined;
  }

  /** 停掉全部已激活的 preset；先摘出再停，父级先停时 fiber 的后续拆卸不会二次停止实例。 */
  async stop(): Promise<void> {
    const presets = this.presets.splice(0, this.presets.length);
    await Promise.all(presets.map((preset) => preset.stop()));
  }

  private instructions(): string {
    if (this.persona === undefined) this.persona = readSnippet(path.join(this.directory, "persona.md")) ?? "";
    if (this.systemTemplate === undefined) this.systemTemplate = readFileSync(resourcePath("templates", "system.jinja"), "utf8");

    const rendered = new Template(this.systemTemplate).render({});
    return [rendered.trim(), this.persona].filter((part) => part.length > 0).join("\n\n");
  }
}

export interface PresetRuntimeOptions {
  /** preset 名：日志与 cross 实例的聚合键都取自它。 */
  name: string;
  /** 本 preset 的装配清单；加载后不变。 */
  specs: SceneSpec[];
  /** 本 preset 启用的扩展包：包名到 `config` 原样内容，按书写顺序。 */
  extensions: Record<string, unknown>;
  /** 所属 profile 的目录：事实根与人设都在这里。 */
  directory: string;
  /** 实例根目录：`<profileDir>/scenes`。 */
  scenesDir: string;
  ctx: Context;
  gateway: Gateway;
  logger: Logger;
  /** 基础提示词（内核模板 + persona）的取用点；缓存由 profile 侧持有。 */
  instructions: () => string;
}

/** 一个 preset 的激活单元：specs 与按需长出来的频道实例；生命周期跟着自己那条 fiber。 */
export class PresetRuntime {
  readonly name: string;

  private readonly specs: SceneSpec[];
  /** 启用的扩展包，包名到 config；provider 每次实例化时现取，服务因此不必被 preset 记住。 */
  private readonly extensions: Record<string, unknown>;
  private readonly directory: string;
  private readonly scenesDir: string;
  private readonly ctx: Context;
  private readonly gateway: Gateway;
  private readonly logger: Logger;
  private readonly instructions: () => string;
  private readonly scenes: Record<string, AgentRuntime | undefined> = {};

  constructor(options: PresetRuntimeOptions) {
    this.name = options.name;
    this.specs = options.specs;
    this.extensions = options.extensions;
    this.directory = options.directory;
    this.scenesDir = options.scenesDir;
    this.ctx = options.ctx;
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.instructions = options.instructions;
  }

  /** 按事件定位其归属频道实例，未创建时按需创建。 */
  route(event: IshikiEvent): AgentRuntime | undefined {
    const { platform, selfId, channelId } = event.data;
    const spec = matchSceneSpec(this.specs, { sid: `${platform}:${selfId}`, channelId });
    if (spec === undefined) return undefined;
    return this.ensure(spec, channelId, { platform, selfId });
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.scenes).map((scene) => scene?.stop()));
  }

  /**
   * 按需创建实例：首次有事件落到它头上时创建，同时初始化目录、引擎与存储。
   * 装配的唯一决策点：模型、上下文引擎、唤醒引擎、工具调用层都随本实例在此诞生，
   * 随实例停止一起销毁——生命周期只有「实例」一种单位，不再有 preset 级的共享活物。
   *
   * 实例坐标随形态分岔：非聚合形态是 `(sid, channelId)`，每个频道一块视窗；聚合形态整块视窗
   * 以 preset 名为键，claims 里的全部频道汇进同一份 `events.jsonl`——合流的范围就是声明处所写的那些行。
   */
  private ensure(spec: SceneSpec, channelId: string, address: { platform: string; selfId: string }): AgentRuntime {
    const cross = spec.cross;
    const key = cross ? `cross_${spec.name}` : channelKey(spec.sid, channelId);
    const existing = this.scenes[key];
    if (existing !== undefined) return existing;

    // 聚合视窗没有「自己所在的那个频道」：sid 取事件来源的账号，决定本实例从哪个 bot 发消息。
    const sid = cross ? `${address.platform}:${address.selfId}` : spec.sid;

    /** 聚合形态的出站寻址：可达清单与坐标解析都从 claims 现算一次，装配时冻结在工具里。非聚合形态取不到 claims。 */
    const claims = spec.claims ?? {};
    /** 认领的频道模式，逐行写成 `sid/模式`；地址簿与工具的报错文本都取这两份，不各写一套。 */
    const reachable = Object.entries(claims).flatMap(([account, claim]) => (claim.whitelist ?? []).map((pattern) => `${account}/${pattern}`));
    const excluded = Object.entries(claims).flatMap(([account, claim]) => (claim.blacklist ?? []).map((pattern) => `${account}/${pattern}`));
    const directory = path.join(this.scenesDir, sceneDirectoryName(key));
    const baseTools: ToolSet = {
      send_message: createSendMessage({
        ctx: this.ctx,
        logger: this.logger,
        sid,
        channelId,
        typing: spec.typing,
        // 坐标由模型给，内核只验它落不落在本视窗认领的频道集合内。
        // 坐标两种写法都收：带 sid 的复合坐标直接取；裸 channelId 只在恰好被一个 sid 认领时才算数——
        // 多个账号都认领同名频道时它指不准，宁可报错让模型补上 sid，也不猜一个发出去。
        ...(cross
          ? {
              routing: {
                reachable,
                excluded,
                resolve: (target: string) => {
                  const slash = target.indexOf("/");
                  if (slash > 0) {
                    const account = target.slice(0, slash);
                    const claimed = target.slice(slash + 1);
                    return claimsChannel(claims[account] ?? {}, claimed) ? { sid: account, channelId: claimed } : undefined;
                  }
                  // 裸频道号只在恰好被一个账号认领时才算数。认领判定只有 claimsChannel 一处，
                  // 白名单与黑名单都算进去：被排除的频道不该因为「只有它认领这个名字」而可达。
                  const owners = Object.entries(claims).filter(([, claim]) => claimsChannel(claim, target));
                  return owners.length === 1 ? { sid: owners[0]![0], channelId: target } : undefined;
                },
              },
            }
          : {}),
      }),
      finish: createFinish(),
    };

    const domain: InstanceDomain = cross
      ? { form: "cross", accounts: Object.entries(claims).map(([sid, claim]) => ({ sid, claim })) }
      : { form: "channel", platform: address.platform, selfId: address.selfId, channelId };

    // 扩展包按 preset 配置里的书写顺序挂到这一个实例上。取不到服务只有一种可能：这条 fiber 已经
    // 把它声明为依赖，装配次序错了，或服务卸载后旧引用还在用。抛错，不静默跳过。
    const extensions = Object.entries(this.extensions).map(([pkg, config]) => {
      const service = extensionServiceName(pkg);
      const handler = (this.ctx.get(service) as ExtensionService | undefined)?.handler;
      if (handler === undefined) throw new Error(`extension service "${service}" is not available`);
      return { handler, config };
    });

    // 引擎在这里从各自的 provider 诞生，随本实例同生共死：provider 只管造，运行状态都在运行体里，
    // 上下文引擎记着本实例的 agent 与压缩水位，唤醒引擎的账本只看本视窗的事实流，不跨实例共享。
    // provider 都已由 preset 的 fiber 声明为依赖，这里取一次即可。
    const failover = this.gateway.groups().includes(spec.model) || (spec.failover.attempts ?? 1) > 1;
    const raw = failover ? new FailoverModel(this.gateway, spec.model, spec.failover, this.logger) : this.gateway.languageModel(spec.model);
    const toolcall = engineProvider<ToolcallEngine>(this.ctx, toolcallEngineServiceName(spec.toolcall.engine));
    const model = toolcall.create(engineParams<ToolcallEngines>(spec.toolcall)).wrap(raw);

    // 系统提示词：内核那一段（身份与处境）在前，聚合形态的地址簿居中，扩展包的加法在最后。
    const instructionTexts = [this.instructions()];
    if (cross) {
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
      label: cross ? `${spec.profile}/${spec.name}` : `${spec.profile}/${spec.name}/${channelId}`,
      channelId,
      directory,
      model,
      // 聚合形态把可达地址清单拼进 instructions：坐标不进工具 schema（每个工具都挂一份会让工具目录膨胀），
      // 模型的出发点只有系统提示与事实行上的寻址头。非聚合形态照旧不带地址簿。
      instructions: instructionTexts.filter((text) => text.length > 0).join("\n\n"),
      ctx: this.ctx,
      domain,
      gateway: this.gateway,
      // 引擎实例在 AgentRuntime 构造期才造：它的工具面与提示词依赖，要到扩展包挂完才定。
      // 这里只交出造法与参数。
      context: engineProvider<ContextEngine>(this.ctx, contextEngineServiceName(spec.context.engine)),
      contextParams: engineParams<ContextEngines>(spec.context),
      tools: baseTools,
      extensions,
      innerThoughts: spec.innerThoughts,
      codemode: spec.codemode,
      wakeup: engineProvider<WakeupEngine>(this.ctx, wakeupEngineServiceName(spec.wakeup.engine)).create(engineParams<WakeupEngines>(spec.wakeup), {
        logger: this.logger,
      }),
      logger: this.logger,
    });
    this.scenes[key] = scene;
    this.logger.info(`[${spec.profile}/${spec.name}] scene created: ${key}`);
    return scene;
  }
}

/** 读一段文本，文件不存在返回 undefined。 */
function readSnippet(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/**
 * 一个 preset 的可激活单元：展开好的清单与它依赖的服务。
 * 依赖决定这条 fiber 何时激活：服务缺席时停在非激活态，来了自动装载。
 */
export interface PresetLoad extends ResolvedPreset {
  /** 依赖的服务名：启用的扩展包，加上各 spec 最终用到的三个引擎变体。 */
  services: string[];
}

/**
 * 算一个 preset 依赖的服务：启用的扩展包与每个最终 spec 的三个引擎变体。
 * 引擎从展开后的 spec 扫描而不是读 preset 原始配置——scene 覆盖出来的引擎也算这个 preset 的依赖。
 * 扩展包在展开时已滤掉 `enable: false` 的项，剩下的逐个都是必需依赖：没有可选包这条线。
 */
function presetServices(preset: ResolvedPreset): string[] {
  const specs = preset.specs;
  const names = specs.flatMap((spec) => [
    contextEngineServiceName(spec.context.engine),
    wakeupEngineServiceName(spec.wakeup.engine),
    toolcallEngineServiceName(spec.toolcall.engine),
  ]);
  return [...new Set([...Object.keys(preset.extensions).map(extensionServiceName), ...names])];
}

/** 一份装载就绪的 profile：preset 分组已展开，尚未实例化——每个 preset 等自己依赖的服务就位。 */
export interface ProfileLoad {
  id: string;
  directory: string;
  /** 逐 preset 独立激活；一个 preset 的依赖不拖累同 profile 的其他 preset。 */
  presets: PresetLoad[];
}

/**
 * 扫描 profile 根目录并解析出全部可装载项：每个子目录读一份 profile.yml 或 profile.yaml。
 * 错误按作用域分治：profile 的根结构坏掉只跳过它自己；单个 preset 坏掉只跳过它自己（各记一条 error），其余照常。
 * 实例化不在这里——它按 preset 各开一条 fiber，等自己依赖的服务（扩展包与引擎变体）就位（见 `activateProfiles`）。
 */
export function loadProfiles(root: string, logger: Logger): ProfileLoad[] {
  const loads: ProfileLoad[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = ["profile.yml", "profile.yaml"].map((name) => path.join(root, entry.name, name)).find((candidate) => existsSync(candidate));
    if (file === undefined) {
      logger.warn(`no profile.yml under "${entry.name}", directory skipped`);
      continue;
    }
    try {
      const resolved = resolveProfile(parse(readFileSync(file, "utf8")), entry.name);
      for (const skip of resolved.skipped) logger.error(`[${resolved.id}] preset "${skip.preset}" skipped: ${skip.message}`);
      loads.push({
        id: resolved.id,
        directory: path.join(root, entry.name),
        presets: resolved.presets.map((preset) => ({
          name: preset.name,
          specs: preset.specs,
          extensions: preset.extensions,
          services: presetServices(preset),
        })),
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
 * 装载后的第二步：一个 profile 一个常驻宿主，一个 preset 一条 fiber。
 * 宿主立刻立住——目录与路由壳不依赖任何服务；每个 preset 等自己依赖的服务（扩展包与引擎变体）
 * 就位才激活，服务被卸载则它那条 fiber 复位：preset 单元停止并摘出，宿主与兄弟 preset 都不动；
 * 服务回来再重建（事实流在盘上，连续性不丢）。门控与拆卸都由 cordis 管，这里只写「建」与「停」。
 *
 * 服务此刻缺席只记一条 error 就放行：缺席是可恢复的等待态，不是装配失败——后加载的服务
 * 一到，cordis 自己会把这条 fiber 拉起来。装配失败是另一回事（provider 在，`create()` 抛错），
 * 那一条留给 cordis 的 fiber 报。
 *
 * 建出的宿主推进调用方给的数组：调用方（`Ishiki`）按同一个引用做路由。
 */
export function activateProfiles(loads: readonly ProfileLoad[], profiles: ProfileRuntime[], deps: { ctx: Context; gateway: Gateway; logger: Logger }): void {
  for (const load of loads) {
    const profile = new ProfileRuntime({ id: load.id, directory: load.directory, ...deps });
    profiles.push(profile);
    deps.logger.info(`profile "${profile.id}" loaded: ${load.presets.length} preset(s)`);

    for (const preset of load.presets) {
      const apply = (fiber: Context) => {
        const runtime = profile.activate(preset);
        fiber.on("dispose", () => {
          if (profile.deactivate(runtime)) void runtime.stop();
        });
      };
      // cordis 拿回调名当插件名：日志与面板里要能认出是哪个 preset。
      Object.defineProperty(apply, "name", { value: `ishiki/preset:${load.id}/${preset.name}`, configurable: true });
      const missing = preset.services.filter((service) => deps.ctx.get(service) === undefined);
      if (missing.length > 0) {
        deps.logger.error(`[${load.id}/${preset.name}] missing required service ${missing.map((service) => `"${service}"`).join(", ")}; preset is waiting`);
      }
      deps.ctx.inject(preset.services, apply);
    }
  }
}
