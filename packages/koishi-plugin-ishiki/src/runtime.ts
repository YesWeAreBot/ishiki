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
  type ToolCallers,
  type ToolSet,
} from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type { Context, Logger } from "koishi";
import { parse } from "yaml";

import { createContextEngine, type ContextEngine } from "./context/index.js";
import type { InstanceDomain } from "./domain.js";
import type { ExtensionCoords, ExtensionProvider } from "./extension.js";
import { FailoverModel } from "./failover.js";
import { claimsChannel, matchSceneSpec, ProfileConfig, resolveProfile, sceneDirectoryName, type ResolvedProfile, type SceneSpec } from "./profile.js";
import { createToolcallEngine } from "./toolcall/index.js";
import { CODE_MODE, createCodemode } from "./tools/codemode.js";
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
  /** 该实例可用的工具集，由容器按 spec 与该频道装配。 */
  tools: ToolSet;
  /**
   * 哪些工具可以被谁调用，代码模式用：`{ search: ['code_mode'] }` 让沙箱里的程序能调 search，
   * 而模型的工具目录里没有它。表里没点名的工具既留在目录也不进沙箱，所以直调不必写进来。
   */
  toolCallers?: ToolCallers;
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
 * core 侧的插件：上下文引擎与停轮判定在这一点收拢成 core 见的唯一入口。
 *
 * 上下文引擎只声明自己干预管线上哪几段，钩子在这一点按固定顺序转发；停轮判定读本步消息流，
 * 不设跨步标志：嵌套调用（code mode 沙箱内）的结果不落 step messages，扫描天然看不见它们，
 * 于是程序内说过的、做过的都不结束轮次，轮次的收尾只由直调产生。
 */
export function createAgentPlugin(parts: { context: ContextEngine }): AgentPlugin {
  const { context } = parts;
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
    // 收尾回执：引擎记账。判定无跨步状态，无需清理。
    onTurnFinish: async (result) => {
      await context.onTurnFinish?.(result);
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
      // core 只见一个插件：上下文引擎与停轮判定在这一点收拢。
      plugins: [createAgentPlugin({ context: config.context })],
      tools: config.tools,
      // core 的配置字段叫 toolCallers；它转发给 streamText 时才改名为 experimental_toolCallers。
      ...(config.toolCallers === undefined ? {} : { toolCallers: config.toolCallers }),
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

/** 一份人设的运行态：静态的工厂清单，加上按需长出来的频道实例。 */
export class ProfileRuntime {
  readonly id: string;

  private readonly ctx: Context;
  private readonly logger: Logger;
  private readonly gateway: Gateway;
  private readonly directory: string;
  private readonly scenesDir: string;
  /** 本 profile 的装配清单；加载后不变。 */
  readonly specs: SceneSpec[] = [];
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
    // 展开失败的 spec 不进清单（准入校验在 resolveProfile），装载期报错到此为止。
    this.specs.push(...options.resolved.specs);
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

    // 扩展包的加法：一个包对这一个实例叫一次。只在装配点问，实例活着期间不再问——包的判断是
    // 实例级的，没有按调用变化的输入，所以它拿到的坐标是常量，工具也不需要上下文参数。
    const addedTexts: string[] = [];
    const domain: InstanceDomain = cross
      ? { form: "cross", accounts: Object.entries(claims).map(([sid, claim]) => ({ sid, claim })) }
      : { form: "channel", platform: address.platform, selfId: address.selfId, channelId };
    const coords: ExtensionCoords = { ctx: this.ctx, domain, directory };
    for (const pkg of spec.extends) {
      const service = this.ctx.get(`ishiki.ext.${pkg}`) as { extend?: ExtensionProvider } | undefined;
      if (service === undefined || service.extend === undefined) {
        // 只登记引擎变体的包没有这个成员。记一条，好把「包选错了」与「成员名拼错了」分开。
        this.logger.debug(`[${spec.profile}/${spec.name}] extension "${pkg}" exposes no extend()`);
        continue;
      }
      const added = service.extend(coords);
      // 返回 undefined 是包的正常回答（这个实例用不上我），不是失败：每频道的过滤归包自己。
      if (added === undefined) continue;
      for (const [name, value] of Object.entries(added.tools ?? {})) {
        if (name in baseTools) throw new Error(`tool "${name}" from extension "${pkg}" is already provided`);
        baseTools[name] = value;
      }
      if (added.instructions !== undefined && added.instructions.length > 0) addedTexts.push(added.instructions);
    }

    const base = spec.innerThoughts ? withInnerThoughts(baseTools, this.logger) : baseTools;
    // 代码模式只改工具面：宿主工具一件不动，模型目录收窄成只剩沙箱那一件。
    // 收窄与沙箱工具是同一次装配的两半——表里点名的进沙箱，没点名的留在目录。
    const sandbox = spec.codemode.enable ? createCodemode(spec.codemode, base) : undefined;
    const tools: ToolSet = sandbox === undefined ? base : { ...base, [CODE_MODE]: sandbox.tool };

    // 模型与引擎在这里诞生，随本实例同生共死：上下文引擎记着本实例的 agent 与压缩水位，
    // 唤醒引擎的账本只看本视窗的事实流，跨实例状态经 deps.shared（见 WakeupEngineDeps）。
    const failover = this.gateway.groups().includes(spec.model) || (spec.failover.attempts ?? 1) > 1;
    const raw = failover ? new FailoverModel(this.gateway, spec.model, spec.failover, this.logger) : this.gateway.languageModel(spec.model);
    const model = createToolcallEngine(spec.toolcall).wrap(raw);

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
    instructionTexts.push(...addedTexts);

    const scene = new AgentRuntime({
      label: cross ? `${spec.profile}/${spec.name}` : `${spec.profile}/${spec.name}/${channelId}`,
      channelId,
      directory,
      model,
      // 聚合形态把可达地址清单拼进 instructions：坐标不进工具 schema（每个工具都挂一份会让工具目录膨胀），
      // 模型的出发点只有系统提示与事实行上的寻址头。非聚合形态照旧不带地址簿。
      instructions: instructionTexts.filter((text) => text.length > 0).join("\n\n"),
      context: createContextEngine(spec.context, {
        logger: this.logger,
        gateway: this.gateway,
        directory: this.directory,
        resources: resourcePath(),
        // 多频道视窗一块吃下多个频道，事实行不带坐标就分不清谁说的；单频道即无寻址头。
        domain,
      }),
      tools,
      ...(sandbox === undefined ? {} : { toolCallers: sandbox.callers }),
      wakeup: createWakeupEngine(spec.wakeup, { logger: this.logger }),
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
