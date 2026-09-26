import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Template } from "@huggingface/jinja";
import {
  createAgent,
  createCustomMessage,
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

import { createContextEngine, renderLine } from "./context/index.js";
import { FootprintIndex, HOT_TRANSFER_LINES } from "./footprint.js";
import { matchSceneSpec, ProfileConfig, resolveProfile, sceneDirectoryName, type SceneSpec } from "./profile.js";
import { createToolcallEngine, type ToolcallEngine } from "./toolcall/index.js";
import { createDispatchStimulus } from "./tools/dispatch-stimulus.js";
import { createFinish } from "./tools/finish.js";
import { createPeekChannelHistory } from "./tools/peek-channel-history.js";
import { createReportToolIssue } from "./tools/report-tool-issue.js";
import { createSendMessage } from "./tools/send-message.js";
import { createThink } from "./tools/think.js";
import type { IshikiEvent, IshikiInnerStimulus } from "./types.js";
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

/** 只表达「说完了」、不构成实义动作的工具名；其余工具都算这一轮的实义动作。 */
const SPEAKING_TOOLS = new Set(["send_message", "think"]);

/**
 * 一轮的收尾控制：工具只置标志，收尾在步边界决定。
 * `finish` 直接请求结束；`send_message` 的请求要等本步没有别的实义工具才生效，
 * 免得同一批调用里的失败被静默地当成「说完了」。
 */
class TurnControl implements AgentPlugin {
  readonly name = "ishiki.turn-control";

  private stopRequested = false;
  private sendRequested = false;

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
        message.content.some((part) => part.type === "tool-call" && !SPEAKING_TOOLS.has(part.toolName)),
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

/** 一个频道实例的完整运行配置：身份、地址、目录，以及已就绪的构造件。 */
export interface SceneRuntimeConfig {
  /** 实例标识，用于日志与 agent id。 */
  label: string;
  /** 该频道所属账号；跨频道投递的默认目标。 */
  sid: string;
  channelId: string;
  /** 该账号的平台身份。 */
  address: { platform: string; selfId: string };
  /** 该频道的独立目录，存放 `events.jsonl` 及后续的附件。 */
  directory: string;
  model: LanguageModel;
  instructions: string;
  /** 该实例要装的插件：上下文引擎、收尾控制等，由容器装配。 */
  plugins: readonly AgentPlugin[];
  /** 该实例可用的工具集，由容器按 spec 与该频道装配。 */
  tools: ToolSet;
  /** 按 spec 共享。 */
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

/** 一 Scene = 一 Channel = 一 Agent。 */
export class SceneRuntime {
  /** 实例标识，用于日志与 agent id。 */
  readonly label: string;
  /** 该频道所属账号。 */
  readonly sid: string;
  readonly channelId: string;
  /** 该账号的平台身份；sid 始终不解析。 */
  readonly address: { platform: string; selfId: string };
  readonly directory: string;
  readonly storage: AgentStorage;

  private readonly logger: Logger;
  private readonly wakeup: WakeupEngine;
  private readonly agent: Agent;
  /** 事件自身不带时间戳，跨度只能在这一侧相减：起点由对应的 start 事件记下。 */
  private readonly toolStartedAt = new Map<string, number>();
  private readonly stepStartedAt = new Map<string, number>();
  /** 待挂载的跨场景前情；下一次装配时被引擎取走并清空。 */
  private pendingCross?: { channelId: string; elapsedMs: number; lines: readonly string[] };

  constructor(config: SceneRuntimeConfig) {
    this.label = config.label;
    this.sid = config.sid;
    this.channelId = config.channelId;
    this.address = config.address;
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
      plugins: config.plugins,
      tools: config.tools,
    });

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

  /** 向该频道投递一条事件：仅写入事件流，或按唤醒结果触发一轮。 */
  deliver(event: IshikiEvent, force = false): void {
    const trigger = force || this.wakeup.decide(event) === "trigger";
    this.agent.send(event, { trigger, ifBusy: "join" });
  }

  /** 只判定不投递：这条事件投下去会不会触发一轮。 */
  wouldTrigger(event: IshikiEvent): boolean {
    return this.wakeup.decide(event) === "trigger";
  }

  /** 挂一次性的跨场景前情；引擎在下一次装配时取走并清空。重复挂载以最后一次为准。 */
  setCrossContext(context: { channelId: string; elapsedMs: number; lines: readonly string[] }): void {
    this.pendingCross = context;
  }

  /** 引擎装配时取走易失前情；取走即清空，保证只挂载一轮。供装配回调调用。 */
  takeCrossContext(): { channelId: string; elapsedMs: number; lines: readonly string[] } | undefined {
    const pending = this.pendingCross;
    this.pendingCross = undefined;
    return pending;
  }

  /** 等待当前轮次结束。 */
  async idle(): Promise<void> {
    await this.agent.wait();
  }

  async stop(): Promise<void> {
    await this.agent.stop();
  }
}

/** 投递目标；`sid` 省略时取来源频道的账号。 */
export interface StimulusTarget {
  sid?: string;
  channelId: string;
}

/**
 * 投递的迫近程度。`idle` 只写进目标的事件流，目标按自己的节奏在下次醒来时读到；
 * `urgent` 强制打断目标并立刻起一轮，是代价最高的一种。
 */
export type StimulusUrgency = "idle" | "urgent";

export interface StimulusRefusal {
  target: string;
  error: string;
}

export interface StimulusReport {
  delivered: number;
  refused: StimulusRefusal[];
}

export interface ProfileRuntimeOptions {
  id: string;
  /** 这个 profile 的目录，`scenes/` 与 `persona.md` 都在里面。 */
  directory: string;
  specs: SceneSpec[];
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
  /** 每个可用 spec 一份：模型、唤醒引擎与工具调用引擎在 profile 内共享，由实例引用。 */
  private readonly plans: Record<string, { model: LanguageModel; wakeup: WakeupEngine; toolcall: ToolcallEngine } | undefined> = {};
  private readonly scenes: Record<string, SceneRuntime | undefined> = {};
  /** 跨场景用户足迹：纯内存的瞬时工作记忆，见 footprint.ts。 */
  private readonly footprints = new FootprintIndex();
  /** 提示词源码按 profile 缓存一次；当前频道在渲染时注入。 */
  private persona?: string;
  private thinkPrompt?: string;
  private systemTemplate?: string;

  constructor(options: ProfileRuntimeOptions) {
    this.id = options.id;
    this.ctx = options.ctx;
    this.logger = options.logger;
    this.gateway = options.gateway;
    this.directory = options.directory;
    this.scenesDir = path.join(options.directory, "scenes");

    for (const spec of options.specs) {
      try {
        this.plans[spec.name] = {
          model: options.gateway.languageModel(spec.model),
          wakeup: createWakeupEngine(spec.wakeup),
          toolcall: createToolcallEngine(spec.toolcall),
        };
        this.specs.push(spec);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`[${this.id}/${spec.name}] spec unavailable, skipped: ${reason}`);
      }
    }
  }

  /** 按事件定位其归属频道实例，未创建时按需创建。 */
  route(event: IshikiEvent): SceneRuntime | undefined {
    const { platform, selfId, channelId } = event.data;
    const spec = matchSceneSpec(this.specs, { sid: `${platform}:${selfId}`, channelId });
    if (spec === undefined) return undefined;
    const scene = this.ensure(spec, channelId, { platform, selfId });

    // 足迹与热迁移只看用户消息：别的类型没有"某个人在哪里活跃"的语义。
    if (event.type === "ishiki.message.created") {
      const data = event.data;
      // 先查热迁移再记录：record 会覆盖足迹，之后查到的永远是本条消息自己。
      // 群聊 → 私聊的热迁移：私聊事件到达时，足迹里若刚有群聊互动，就挂上易失前情。
      // 反方向（私聊 → 群聊）永不挂载：私聊内容不进公开视窗。
      const from = data.isDirect ? this.footprints.hotTransfer(data.user.id, data.timestamp) : undefined;
      const interacted = scene.wouldTrigger(event);
      this.footprints.record(data.user.id, { sid: `${platform}:${selfId}`, channelId, timestamp: data.timestamp }, interacted);
      if (from !== undefined && from.channelId !== channelId) void this.prepareCrossContext(scene, from);
    }
    return scene;
  }

  /** 为热迁移拉取源频道最近几行，挂到目标实例上；拉取失败静默降级为无前情。 */
  private async prepareCrossContext(scene: SceneRuntime, from: { sid: string; channelId: string; timestamp: number }): Promise<void> {
    try {
      const lines = await this.peek(from.sid, from.channelId, HOT_TRANSFER_LINES);
      if (lines === undefined || lines.length === 0) return;
      scene.setCrossContext({ channelId: from.channelId, elapsedMs: Date.now() - from.timestamp, lines });
    } catch (error) {
      this.logger.warn(`cross context peek failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 读取指定频道最近的记录行：只读，不创建实例、不触发轮次。
   * 该频道不属于本 profile 时返回 undefined，与本 profile 下的空记录区分开。
   */
  async peek(sid: string, channelId: string, limit: number): Promise<string[] | undefined> {
    if (matchSceneSpec(this.specs, { sid, channelId }) === undefined) return undefined;

    const file = path.join(this.scenesDir, sceneDirectoryName(channelKey(sid, channelId)), "events.jsonl");
    const lines: string[] = [];
    for (const entry of await createJsonlStorage(file).read()) {
      if (entry.type !== "message") continue;
      const line = renderLine(entry.data);
      if (line !== undefined && line.length > 0) lines.push(line);
    }
    return lines.slice(-limit);
  }

  /**
   * 向本 profile 内其他频道投递 stimulus；目标实例不存在时按需创建。
   * `from` 只需给出投递方的地址与账号：来源身份按值取，不必持有实例。
   * 只有 `urgency` 为 `urgent` 才叫醒目标，其余情况只写入事件流。
   */
  dispatch(
    from: Pick<SceneRuntime, "sid" | "channelId" | "address">,
    targets: readonly StimulusTarget[],
    body: { reason: string; content: string; urgency?: StimulusUrgency },
  ): StimulusReport {
    const refused: StimulusRefusal[] = [];
    let delivered = 0;

    for (const target of targets) {
      const sid = target.sid ?? from.sid;
      const key = channelKey(sid, target.channelId);
      if (key === channelKey(from.sid, from.channelId)) {
        refused.push({ target: key, error: "target channel is the source channel" });
        continue;
      }

      // 目标账号的平台身份：同一账号复用来源实例，否则从在线 bot 读取。
      const bot = this.ctx.bots[sid];
      const address = sid === from.sid ? from.address : bot?.platform === undefined ? undefined : { platform: bot.platform, selfId: bot.selfId };
      if (address === undefined) {
        refused.push({ target: key, error: `cannot resolve address: account "${sid}" is not connected` });
        continue;
      }

      // 已存在的实例直接投递；没见过的频道按配置匹配，首条命中的 spec 就是它的归属。
      let scene = this.scenes[key];
      if (scene === undefined) {
        const spec = matchSceneSpec(this.specs, { sid, channelId: target.channelId });
        if (spec === undefined) {
          refused.push({ target: key, error: "channel is not configured in this profile" });
          continue;
        }
        scene = this.ensure(spec, target.channelId, address);
      }

      const payload: IshikiInnerStimulus = {
        timestamp: Date.now(),
        platform: address.platform,
        selfId: address.selfId,
        channelId: target.channelId,
        source: { platform: from.address.platform, selfId: from.address.selfId, channelId: from.channelId },
        reason: body.reason,
        content: body.content,
      };
      scene.deliver(createCustomMessage("ishiki.inner_stimulus", payload), body.urgency === "urgent");
      delivered += 1;
    }

    return { delivered, refused };
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.scenes).map((scene) => scene?.stop()));
  }

  /** 按需创建频道实例：首次投递时创建，同时初始化目录、引擎与存储。 */
  private ensure(spec: SceneSpec, channelId: string, address: { platform: string; selfId: string }): SceneRuntime {
    const key = channelKey(spec.sid, channelId);
    const existing = this.scenes[key];
    if (existing !== undefined) return existing;

    const plan = this.plans[spec.name];
    if (plan === undefined) throw new Error(`spec "${spec.name}" has no usable model and must not receive deliveries`);

    const self = { sid: spec.sid, channelId, address };
    const control = new TurnControl();
    // 引擎构造在 scene 之前，用闭包变量桥接：装配时回调已能拿到最终实例。
    let sceneRef: SceneRuntime;
    // 协议引擎接管工具调用：幕后流由输出契约保证，think 工具退出工具集。
    // 撤 think 是 thoughts 协议的性质，挂在「是否协议引擎」上是本轮的行为等价改写，策略归属待定。
    const jsonMode = spec.toolcall.engine !== "native";
    const tools: ToolSet = {
      send_message: createSendMessage({
        ctx: this.ctx,
        logger: this.logger,
        sid: spec.sid,
        channelId,
        typing: spec.typing,
        onEndTurn: () => control.requestSendStop(),
      }),
      finish: createFinish({ onStop: () => control.requestStop() }),
      peek_channel_history: createPeekChannelHistory({ self, peek: (target) => this.peek(target.sid, target.channelId, target.limit) }),
      dispatch_stimulus: createDispatchStimulus({ self, dispatch: (targets, body) => this.dispatch(self, targets, body) }),
      report_tool_issue: createReportToolIssue({ logPath: path.join(this.directory, "tool_issues.log") }),
    };
    if (!jsonMode) tools.think = createThink({ logger: this.logger });

    // 模型侧：协议引擎把原生 function call 换成文本解析，native 与不适用的模型原样返回。
    const model = plan.toolcall.wrap(plan.model);

    const scene = new SceneRuntime({
      label: `${spec.profile}/${spec.name}/${channelId}`,
      sid: spec.sid,
      channelId,
      address,
      directory: path.join(this.scenesDir, sceneDirectoryName(key)),
      model,
      instructions: this.instructions(spec, channelId),
      // 上下文引擎每实例一个：压缩水位与后台压缩任务都是实例状态。
      // pullCrossContext 回调指向本实例，装配时取走易失前情；hint 由 profile 级足迹索引驱动。
      plugins: [
        createContextEngine(spec.context, {
          logger: this.logger,
          gateway: this.gateway,
          pullCrossContext: () => sceneRef?.takeCrossContext(),
          hint: (userId, currentChannelId) => {
            const hit = this.footprints.lookup(userId);
            if (hit === undefined || hit.channelId === currentChannelId) return undefined;
            const minutes = Math.max(1, Math.round((Date.now() - hit.timestamp) / 60_000));
            return `${minutes}分钟前在频道 ${hit.channelId} 活跃过，需要前情可用 peek_channel_history 查询`;
          },
        }),
        control,
      ],
      tools,
      wakeup: plan.wakeup,
      logger: this.logger,
    });
    this.scenes[key] = scene;
    sceneRef = scene;
    this.logger.info(`[${spec.profile}/${spec.name}] scene created: ${key}`);
    return scene;
  }

  /**
   * 系统提示词：人设文件，加上渲染后的 `resources/templates/system.jinja`。
   * 人设取自 profile 目录的 `persona.md`；think 指南取自 profile 目录的 `think.md`，
   * 没有就退回包内默认。协议引擎下 think 工具不存在，thinkPrompt 不进 system。
   * 源码按 profile 缓存，当前频道每次渲染时注入。
   */
  private instructions(spec: SceneSpec, channelId: string): string {
    const jsonMode = spec.toolcall.engine !== "native";
    if (this.persona === undefined) this.persona = readSnippet(path.join(this.directory, "persona.md")) ?? "";
    if (!jsonMode && this.thinkPrompt === undefined) {
      this.thinkPrompt = readSnippet(path.join(this.directory, "think.md")) ?? readSnippet(resourcePath("templates", "think.md")) ?? "";
    }
    if (this.systemTemplate === undefined) this.systemTemplate = readFileSync(resourcePath("templates", "system.jinja"), "utf8");

    // 地址簿按账号合并：没有认领频道的 spec 既不会被唤醒，也投递不进去，不列。
    const bySid = new Map<string, string[]>();
    for (const other of this.specs) {
      if (other.whitelist.length === 0) continue;
      bySid.set(other.sid, [...(bySid.get(other.sid) ?? []), ...other.whitelist]);
    }
    const bodies = [...bySid].map(([sid, channels]) => ({ sid, channels }));
    const rendered = new Template(this.systemTemplate).render({ thinkPrompt: this.thinkPrompt, self: { sid: spec.sid, channelId }, bodies });
    return [rendered.trim(), this.persona].filter((part) => part.length > 0).join("\n\n");
  }
}

/** 读一段文本，文件不存在返回 undefined。 */
function readSnippet(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

/**
 * 扫描 profile 根目录并建出全部 ProfileRuntime：每个子目录读一份 profile.yml 或 profile.yaml，
 * 解析、展开成 spec，再交给对应的实例容器。
 *
 * 坏掉的目录只跳过它自己：读不动、preset 悬空、缺 sid，各记一条 error，其余 profile 照常加载。
 */
export function loadProfiles(root: string, deps: { ctx: Context; gateway: Gateway; logger: Logger }): ProfileRuntime[] {
  const profiles: ProfileRuntime[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = ["profile.yml", "profile.yaml"].map((name) => path.join(root, entry.name, name)).find((candidate) => existsSync(candidate));
    if (file === undefined) {
      deps.logger.warn(`no profile.yml under "${entry.name}", directory skipped`);
      continue;
    }
    try {
      const profile = ProfileConfig(parse(readFileSync(file, "utf8")));
      const id = profile.id?.trim() || entry.name;
      profiles.push(new ProfileRuntime({ id, directory: path.join(root, entry.name), specs: resolveProfile(profile, id), ...deps }));
    } catch (error) {
      deps.logger.error(`[${entry.name}] profile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (profiles.length === 0) {
    deps.logger.warn(`No profile to load under ${root}`);
  }

  return profiles;
}
