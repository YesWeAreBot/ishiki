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
  type StepFinishDecision,
  type StepFinishInfo,
  type ToolSet,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { parse } from "yaml";

import { createContextEngine, type ContextEngine } from "./context/index.js";
import { FailoverModel } from "./failover.js";
import {
  claimsChannel,
  isSelected,
  matchSceneSpec,
  matchesChannel,
  ProfileConfig,
  resolveProfile,
  sceneDirectoryName,
  type PresetEngineConfig,
  type ResolvedProfile,
  type SceneSpec,
} from "./profile.js";
import { createToolcallEngine, type ToolcallEngine } from "./toolcall/index.js";
import { createFinish } from "./tools/finish.js";
import { withInnerThoughts } from "./tools/inner-thoughts.js";
import { createSendMessage } from "./tools/send-message.js";
import type { IshikiEvent } from "./types.js";
import { createWakeupEngine, type WakeupEngine } from "./wakeup/index.js";

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
 * 一轮的收尾控制：工具只置标志，收尾在步边界决定。
 *
 * `finish` 直接请求结束。`send_message` 只在「没写 continue 且全部发出成功」时置请求
 * （判定在工具里，见 send-message），请求还要等本批没有再调用别的工具才生效——
 * 同一批里可能还有别的实义工具，它们的失败不该被静默地当成「说完了」。
 */
class TurnControl implements AgentPlugin {
  readonly name = "ishiki.turn-control";

  private stopRequested = false;
  private sendRequested = false;

  private stopTools = new Set(["finish", "send_message"]);

  requestStop(): void {
    this.stopRequested = true;
  }

  requestSendStop(): void {
    this.sendRequested = true;
  }

  /** core 会摘取这些 hook 单独调用，因此必须绑定在实例上（箭头属性）。 */
  onStepFinish = (info: StepFinishInfo): StepFinishDecision | undefined => {
    const blocking = info.result.messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        // 取反：`stopTools` 里的都是「说了话/收尾」这类不打断收尾工具，本步只要碰了别的实义工具就不停。
        message.content.some((part) => part.type === "tool-call" && !this.stopTools.has(part.toolName)),
    );
    const stop = this.stopRequested || (this.sendRequested && !blocking);
    this.stopRequested = false;
    this.sendRequested = false;
    return stop ? { continue: false } : undefined;
  };

  onTurnFinish = (): void => {
    this.stopRequested = false;
    this.sendRequested = false;
  };
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
  instructions: string;
  /** 上下文引擎：由所属生效单位造好后传进来，一个 agent 一份。 */
  context: ContextEngine;
  /** 收尾控制：停轮的独占决策点，由容器装配。 */
  control?: AgentPlugin;
  /** 该实例可用的工具集，由容器按 spec 与该频道装配。 */
  tools: ToolSet;
  /** 唤醒引擎：按 preset 共享，同一 preset 下各频道的冷却账本是同一本。 */
  wakeup: WakeupEngine;
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
 * core 侧的插件：上下文引擎与收尾控制在这一点收拢成 core 见的唯一入口。
 *
 * 上下文引擎只声明自己干预管线上哪几段，钩子在这一点按固定顺序转发；`TurnControl` 的停轮是
 * 唯一决策点，保持内核独占，不对外开放。
 */
export function createAgentPlugin(parts: { context: ContextEngine; control?: Pick<AgentPlugin, "onStepFinish" | "onTurnFinish"> }): AgentPlugin {
  const { context, control } = parts;
  return {
    name: "ishiki",
    // 引擎要在 agent 上挂东西（订阅、压缩水位），收尾控制没有。
    init: (agent) => context.init?.(agent),
    stop: () => context.stop?.(),
    // 事件流改写：一段段往下传。引擎缺席或返回 undefined 都表示这一步不改，原样放行。
    onAppend: (entries) => context.onAppend?.(entries) ?? entries,
    transformEntries: (entries, options) => context.transformEntries?.(entries, options) ?? entries,
    transformMessages: (messages, options) => context.transformMessages?.(messages, options) ?? messages,
    // 引擎给出的那一段提示词接在内核拼好的提示词之后。
    extendInstructions: () => context.extendInstructions?.(),
    // 收尾回执：引擎先记账，收尾控制最后清标志。两者都要跑，缺一不可。
    onTurnFinish: async (result) => {
      await context.onTurnFinish?.(result);
      await control?.onTurnFinish?.(result);
    },
    // 停轮：唯一决策点，归于收尾控制。
    onStepFinish: (info) => control?.onStepFinish?.(info),
  };
}

/** 一 Scene = 一 Channel = 一 Agent。 */
export class AgentRuntime {
  /** 实例标识，用于日志与 agent id。 */
  readonly label: string;
  readonly channelId: string;
  readonly directory: string;
  readonly storage: AgentStorage;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngine;
  private readonly agent: Agent;
  /** 唤醒引擎这次挂载的拆卸函数：场景停止时调它，取消订阅并丢掉这次挂载攒下的账。 */
  private readonly disposeWakeup?: () => void;
  /** 事件自身不带时间戳，跨度只能在这一侧相减：起点由对应的 start 事件记下。 */
  private readonly toolStartedAt = new Map<string, number>();
  private readonly stepStartedAt = new Map<string, number>();

  constructor(config: AgentRuntimeConfig) {
    this.label = config.label;
    this.channelId = config.channelId;
    this.directory = config.directory;
    this.logger = config.logger;
    this.wakeup = config.wakeup;

    mkdirSync(this.directory, { recursive: true });
    this.storage = createJsonlStorage(path.join(this.directory, "events.jsonl"));
    this.agent = createAgent({
      id: this.label,
      model: config.model,
      instructions: config.instructions,
      storage: this.storage,
      // core 只见一个插件：上下文引擎与收尾控制在这一点收拢。
      plugins: [createAgentPlugin({ context: config.context, control: config.control })],
      tools: config.tools,
    });

    // 引擎自己订阅事实流、读存储；运行时不替它转述发生了什么，也不告诉它记账归谁——
    // 账的归属由事实流里每条消息自带的频道号给出，跨频道聚合与单频道走同一份代码。
    this.disposeWakeup = config.wakeup.attach?.(this.agent);
    this.agent.channel.subscribe("agent", (event) => this.logEvent(event));
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
    await this.agent.stop();
  }
}

export interface ProfileRuntimeOptions {
  id: string;
  /** 这个 profile 的目录，`scenes/` 与 `persona.md` 都在里面。 */
  directory: string;
  /** `resolveProfile` 的展开结果：各生效单位的 spec 与按 preset 归集的引擎配置。 */
  resolved: ResolvedProfile;
  ctx: Context;
  gateway: Gateway;
  logger: Logger;
}

/**
 * 一个生效单位内共享的活物：模型（含降级重试状态）、唤醒引擎、工具调用引擎。
 * 由 Plan 在诞生时从冻结配置造出，频道实例引用它们而不是各自新建。
 */
interface PlanEngines {
  model: LanguageModel;
  /**
   * 上下文引擎。它只能是这一份：core 在 `createAgent` 时就把插件 hook 的引用绑好，
   * 引擎自己还记着 agent、压缩水位与在途压缩——跨 agent 共享会让这个频道的压缩去读另一个频道的存储。
   * 幸而这一层本就是「一生效单位」：cross 形态整个 preset 只有一块视窗、一个 agent。
   */
  context: ContextEngine;
  toolcall: ToolcallEngine;
}

/**
 * 一个生效单位的冻结配置。键是生效单位键：非 cross 是 scene 名，cross 形态是 preset 名。
 *
 * 配置与活物分层是为「一配置单位对多运行单位」：配置单位一旦定下，频道实例各建各的
 * （按需包裹的工具调用层、逐频道装配的工具集），上游配置不用因此变形。
 * 唤醒引擎不在这一层：它不带逐 agent 的状态，跨频道共用一套账才是要的，见 {@link ProfileRuntime}。
 */
interface Plan {
  /** 冻结后的配置：装配所需的全部输入，载入后不再变。 */
  readonly spec: SceneSpec;
  /** 从上面这份配置造出的共享活物。 */
  readonly engines: PlanEngines;
}

/** 一份人设的运行态：静态的工厂清单，加上按需长出来的频道实例。 */
export class ProfileRuntime {
  readonly id: string;

  private readonly ctx: Context;
  private readonly logger: Logger;
  private readonly gateway: Gateway;
  private readonly directory: string;
  private readonly scenesDir: string;
  /** preset 级的引擎配置，装配上下文引擎时按 `spec.preset` 回查。 */
  private readonly engineConfigs: Record<string, PresetEngineConfig>;
  /** 本 profile 的装配清单；加载后不变。 */
  readonly specs: SceneSpec[] = [];
  /** 每个可用生效单位一份，按生效单位键索引；模型与引擎在 profile 内共享，由实例引用。 */
  private readonly plans: Record<string, Plan | undefined> = {};
  /**
   * 唤醒引擎按 preset 索引：该 preset 下全部频道共用一套，冷却账本因此跨频道可见——
   * 同一个群里刚说过话，同 preset 的另一个频道的判定看得见。
   *
   * 引擎配置与实例在这一层对齐：spec 只留 `preset` 键，装配时回这里取。
   */
  private readonly wakeups: Record<string, WakeupEngine | undefined> = {};
  private readonly scenes: Record<string, AgentRuntime | undefined> = {};
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
    this.engineConfigs = options.resolved.engines;

    // 唤醒引擎在 preset 层诞生：认不出的引擎名在这里就报出，不必等到某个频道第一次被路由。
    for (const [name, config] of Object.entries(options.resolved.engines)) {
      try {
        if (!isSelected(config.wakeup.engine, config.extends)) {
          throw new Error(`wakeup engine "${config.wakeup.engine}" comes from an extension package not listed in "extends"`);
        }
        this.wakeups[name] = createWakeupEngine(config.wakeup, { logger: this.logger });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`[${this.id}/${name}] wakeup engine unavailable, skipped: ${reason}`);
      }
    }

    for (const spec of options.resolved.specs) {
      try {
        this.plans[spec.name] = this.createPlan(spec);
        this.specs.push(spec);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`[${this.id}/${spec.name}] spec unavailable, skipped: ${reason}`);
      }
    }
  }

  /**
   * 把一份 spec 冻成 Plan：活物在这里诞生，频道实例只引用。
   * 组名，或显式配了重试次数的引用，才包一层降级重试；其余原样交给网关，不付额外开销。
   * 造不出来的（模型名悬空、组为空）在此报出，由构造器记一条 error 并跳过这个 spec。
   */
  private createPlan(spec: SceneSpec): Plan {
    const failover = this.gateway.groups().includes(spec.model) || (spec.failover.attempts ?? 1) > 1;
    const model = failover ? new FailoverModel(this.gateway, spec.model, spec.failover, this.logger) : this.gateway.languageModel(spec.model);
    const engines = this.wakeups[spec.preset];
    if (engines === undefined) throw new Error(`preset "${spec.preset}" has no usable wakeup engine`);
    const context = this.engineConfigs[spec.preset]!;
    if (!isSelected(context.context.engine, context.extends)) {
      throw new Error(`context engine "${context.context.engine}" comes from an extension package not listed in "extends"`);
    }
    if (!isSelected(spec.toolcall.engine, spec.extends)) {
      throw new Error(`toolcall engine "${spec.toolcall.engine}" comes from an extension package not listed in "extends"`);
    }
    return {
      spec,
      engines: {
        model,
        context: createContextEngine(context.context, {
          logger: this.logger,
          gateway: this.gateway,
          directory: this.directory,
          resources: resourcePath(),
          // 聚合视窗一块视窗吃下多个频道，事实行不带坐标就分不清谁说的；缺省即无寻址头。
          ...(context.cross ? { addressing: { cross: true } } : {}),
        }),
        toolcall: createToolcallEngine(spec.toolcall),
      },
    };
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
   *
   * 实例坐标随形态分岔：非聚合形态是 `(sid, channelId)`，每个频道一块视窗；聚合形态整块视窗
   * 以 preset 名为键，claims 里的全部频道汇进同一份 `events.jsonl`——合流的范围就是声明处所写的那些行。
   */
  private ensure(spec: SceneSpec, channelId: string, address: { platform: string; selfId: string }): AgentRuntime {
    // 构造期建不出 Plan 的 spec 不在 `specs` 里，调用到这里即契约被破坏。
    const plan = this.plans[spec.name];
    if (plan === undefined) throw new Error(`spec "${spec.name}" has no usable model and must not receive deliveries`);
    // 唤醒引擎在 preset 层造好了，这里只取引用：同一 preset 下的频道共用一套冷却账本。
    const wakeup = this.wakeups[spec.preset];
    if (wakeup === undefined) throw new Error(`preset "${spec.preset}" has no usable wakeup engine and must not receive deliveries`);
    const cross = spec.cross;
    const key = cross ? `cross_${spec.name}` : channelKey(spec.sid, channelId);
    const existing = this.scenes[key];
    if (existing !== undefined) return existing;

    // 聚合视窗没有「自己所在的那个频道」：sid 取事件来源的账号，决定本实例从哪个 bot 发消息。
    const sid = cross ? `${address.platform}:${address.selfId}` : spec.sid;
    const control = new TurnControl();
    /** 聚合形态的出站寻址：可达清单与坐标解析都从 claims 现算一次，装配时冻结在工具里。非聚合形态取不到 claims。 */
    const claims = spec.claims ?? {};
    const patterns = Object.entries(claims).flatMap(([account, claim]) => (claim.whitelist ?? []).map((pattern) => ({ account, pattern })));
    const baseTools: ToolSet = {
      send_message: createSendMessage({
        ctx: this.ctx,
        logger: this.logger,
        sid,
        channelId,
        typing: spec.typing,
        onEndTurn: () => control.requestSendStop(),
        // 坐标由模型给，内核只验它落不落在本视窗认领的频道集合内。
        // 坐标两种写法都收：带 sid 的复合坐标直接取；裸 channelId 只在恰好被一个 sid 认领时才算数——
        // 多个账号都认领同名频道时它指不准，宁可报错让模型补上 sid，也不猜一个发出去。
        ...(cross
          ? {
              routing: {
                reachable: patterns.map((entry) => `${entry.account}/${entry.pattern}`),
                resolve: (target: string) => {
                  const slash = target.indexOf("/");
                  if (slash > 0) {
                    const account = target.slice(0, slash);
                    const claimed = target.slice(slash + 1);
                    return claimsChannel(claims[account] ?? {}, claimed) ? { sid: account, channelId: claimed } : undefined;
                  }
                  const owners = patterns.filter((entry) => matchesChannel([entry.pattern], target));
                  return owners.length === 1 ? { sid: owners[0].account, channelId: target } : undefined;
                },
              },
            }
          : {}),
      }),
      finish: createFinish({ onStop: () => control.requestStop() }),
    };

    const tools = spec.innerThoughts ? withInnerThoughts(baseTools, this.logger) : baseTools;

    const model = plan.engines.toolcall.wrap(plan.engines.model);
    const directory = path.join(this.scenesDir, sceneDirectoryName(key));

    const scene = new AgentRuntime({
      label: cross ? `${spec.profile}/${spec.name}` : `${spec.profile}/${spec.name}/${channelId}`,
      channelId,
      directory,
      model,
      // 聚合形态把可达地址清单拼进 instructions：坐标不进工具 schema（每个工具都挂一份会让工具目录膨胀），
      // 模型的出发点只有系统提示与事实行上的寻址头。非聚合形态照旧不带地址簿。
      instructions: cross
        ? `${this.instructions()}\n\n${[
            "本视窗合并了下列频道，每段事实行前的 [ #坐标 ] 标出它的出处，正文行自带发送者。",
            "发言时用 send_message 的 target 显式写明坐标：单值写频道号，跨账号时写 sid/频道号。",
            "可达频道：",
            // 写白名单模式而不是频道清单：认领通常写成 `group:*` 这类通配，逐个频道要等运行时才知道，
            // 模式本身才是配置者写下的那句事实。坐标校验也按同一份模式判，两边不会漂。
            ...Object.entries(claims).map(([account, claim]) => `- ${account}: ${(claim.whitelist ?? []).join(", ")}`),
          ].join("\n")}`
        : this.instructions(),
      context: plan.engines.context,
      control,
      tools,
      wakeup,
      logger: this.logger,
    });
    this.scenes[key] = scene;
    this.logger.info(`[${spec.profile}/${spec.name}] scene created: ${key}`);
    return scene;
  }

  private instructions(): string {
    if (this.persona === undefined) this.persona = readSnippet(path.join(this.directory, "persona.md")) ?? "";
    if (this.systemTemplate === undefined) this.systemTemplate = readFileSync(resourcePath("templates", "system.jinja"), "utf8");

    const rendered = new Template(this.systemTemplate).render({});
    return [rendered.trim(), this.persona].filter((part) => part.length > 0).join("\n\n");
  }
}

/** 读一段文本，文件不存在返回 undefined。 */
function readSnippet(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/** 一份装载就绪的 profile：配置已解析、已展开，尚未实例化——实例化要等它的扩展服务就位。 */
export interface ProfileLoad {
  id: string;
  directory: string;
  resolved: ResolvedProfile;
  /** 依赖的扩展服务名（`ishiki.ext.<包名>`）：各 preset `extends` 的并集，cordis 按它门控实例化。 */
  services: string[];
}

/**
 * 扫描 profile 根目录并解析出全部可装载项：每个子目录读一份 profile.yml 或 profile.yaml，
 * 解析、展开成 spec 与 preset 级引擎配置。实例化不在这里——它按 profile 各开一个 fiber，
 * 等 `extends` 选中的扩展包服务就位（见 `Ishiki.activate`）。
 *
 * 坏掉的目录只跳过它自己：读不动、preset 悬空、缺 sid，各记一条 error，其余 profile 照常加载。
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
      const profile = ProfileConfig(parse(readFileSync(file, "utf8")));
      const id = profile.id?.trim() || entry.name;
      const resolved = resolveProfile(profile, id);
      // 扩展服务名取全部生效单位 `extends` 的并集：一个 profile 一个 fiber，依赖是整体的。
      const services = [...new Set(resolved.specs.flatMap((spec) => spec.extends))].map((pkg) => `ishiki.ext.${pkg}`);
      loads.push({ id, directory: path.join(root, entry.name), resolved, services });
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
 * 装载后的第二步：一个 profile 一个 fiber——`extends` 选中的扩展包服务就位才实例化；
 * 包被停用则 fiber 复位，profile 停止并等待，包回来再重建（事实流在盘上，连续性不丢）。
 * 门控与拆卸都由 cordis 管，这里只写「建」与「停」。未被任何 profile 选中的包不参与。
 *
 * 建出的实例推进调用方给的数组，拆卸时从中移除：调用方（`Ishiki`）按同一个引用做路由。
 */
export function activateProfiles(loads: readonly ProfileLoad[], profiles: ProfileRuntime[], deps: { ctx: Context; gateway: Gateway; logger: Logger }): void {
  for (const load of loads) {
    const apply = (fiber: Context) => {
      const profile = new ProfileRuntime({ id: load.id, directory: load.directory, resolved: load.resolved, ...deps });
      profiles.push(profile);
      deps.logger.info(`profile "${profile.id}" loaded: ${profile.specs.length} scene spec(s)`);
      fiber.on("dispose", () => {
        const index = profiles.indexOf(profile);
        if (index < 0) return;
        profiles.splice(index, 1);
        void profile.stop();
      });
    };
    // cordis 拿回调名当插件名：日志与面板里要能认出是哪个 profile。
    Object.defineProperty(apply, "name", { value: `ishiki/profile:${load.id}`, configurable: true });
    if (load.services.length > 0) deps.logger.info(`profile "${load.id}" needs extensions: ${load.services.join(", ")}`);
    deps.ctx.inject(load.services, apply);
  }
}
