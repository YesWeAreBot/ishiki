import { jsonSchema, tool, type Agent, type Tool } from "@yesimagent/core";
import type Logger from "reggol";

/** 解析后的声明：condition 是本次声明的窗口，未声明则为 undefined。 */
export type WaitOutcome = { condition: { msgs?: number; secs?: number } } | undefined;

/**
 * 把模型的一次 wait 调用解析成生效结果。校验在工具层完成，这里只处理语义：
 * 给出任一可用窗口就用它，其余（空调用、`{msgs: 0}`）都是「不声明」。
 */
function resolve(input: { msgs?: number; secs?: number }): WaitOutcome {
  const msgs = input.msgs !== undefined && input.msgs > 0 ? input.msgs : undefined;
  const secs = input.secs !== undefined && input.secs > 0 ? input.secs : undefined;
  if (msgs === undefined && secs === undefined) return undefined;
  return { condition: { ...(msgs === undefined ? {} : { msgs }), ...(secs === undefined ? {} : { secs }) } };
}

/**
 * Agent 自声明的唤醒条件机：{msgs, secs} 双窗口先到先得，轮末生效、触发即清空。
 *
 * 声明权唯一属于 Agent（wait 工具）；触发与合并交给 core 的 continue，这里只决定
 * 「何时调用它」。这是一次性声明，不是定时触发器：它只描述「下一轮什么时候叫我」，
 * 触发一次即作废，没有配置兜底、没有循环。唤醒原因作为 continue 的提示正文进入这一轮；
 * runtime 重启后安静地等下一条输入或下一次外部唤醒。
 */
export class WaitConditionMachine {
  private agent?: Agent;
  private active = false;
  private condition?: { msgs?: number; secs?: number };
  private count = 0;
  private timer?: NodeJS.Timeout;
  /** 本轮进行期间经 deliver 的入站条数：轮始归零，轮末生效时结算。 */
  private duringTurn = 0;
  /** 本轮的声明；undefined 表示未声明，轮末不装任何条件。 */
  private pending?: WaitOutcome;
  /** bind 时挂上的事实流监听：订阅由本机持有，dispose 时一并摘掉。 */
  private detach?: () => void;

  constructor(private readonly logger: Logger) {}

  bind(agent: Agent): void {
    this.agent = agent;
    // 声明窗口的计数从事实流出发：message.appended 只在落库后发出，join 进当前轮的
    // 消息也走同一条路。turn.start 清掉轮内到达计数——开轮之前的消息由这一轮本身消化，
    // 不重复结算。
    this.detach = agent.channel.subscribe("agent", (event) => {
      if (event.type === "turn.start") {
        this.onTurnStart();
        return;
      }
      if (event.type !== "message.appended") return;
      const message = event.message;
      if (message.role !== "custom") return;
      if (message.type !== "ishiki.message.created" && message.type !== "ishiki.message.deleted") return;
      this.countInput();
    });
  }

  /**
   * wait 工具在轮内的声明：一轮内多次调用，最后一次生效。返回真正生效的结果，
   * 未声明返回 undefined——模型据此知道这一轮之后没有自动唤醒。
   */
  declare(input: { msgs?: number; secs?: number }): WaitOutcome {
    const outcome = resolve(input);
    this.pending = outcome;
    return outcome;
  }

  /**
   * 轮始：开轮之前的到达由这一轮本身消化，所以先停用已有条件——轮内的到达一律记进
   * duringTurn，不再走 active 分支，避免同一批消息在不同来路的轮里被计两次。
   */
  onTurnStart(): void {
    this.deactivate();
    this.duringTurn = 0;
  }

  /** 轮末生效：只有声明过的才装条件；未声明、failed、aborted 都不装。 */
  onTurnEnd(status: "done" | "failed" | "aborted"): void {
    const declaration = status === "done" ? this.pending : undefined;
    this.pending = undefined;
    if (declaration === undefined) {
      this.deactivate();
      this.duringTurn = 0;
      return;
    }
    // duringTurn 由 activate() 结算并清零：它要读这批数判断声明是否已被满足。
    this.activate(declaration.condition);
  }

  /** 入站事件计数：轮内到达的先记待结算数，轮末生效时一并结算；生效后达标即触发。 */
  countInput(): void {
    if (!this.active) {
      this.duringTurn += 1;
      return;
    }
    const msgs = this.condition?.msgs;
    if (msgs === undefined) return;
    this.count += 1;
    if (this.count >= msgs) this.trigger(`${msgs} new input${msgs === 1 ? "" : "s"}`);
  }

  /** 停表：runtime 停止时调用。条件不持久化，没有需要留给下一次的状态。 */
  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    this.deactivate();
  }

  /** 让一次性声明生效：先清空，保证任何时刻最多只有一个待触发条件。 */
  private activate(condition: { msgs?: number; secs?: number }): void {
    this.deactivate();
    this.active = true;
    this.condition = condition;
    // 轮内到达的消息已随本轮进入上下文：它们不占新条件的名额（模型已经见过），
    // 只有声明的 msgs 窗口已被这批消息满足时才立即结算——避免「消息已够却再等
    // 下一条」把输入晾在那里。
    const arrived = this.duringTurn;
    this.duringTurn = 0;
    if (condition.secs !== undefined) {
      this.timer = setTimeout(() => this.trigger(`timer ${condition.secs}s expired`), condition.secs * 1000);
    }
    if (condition.msgs !== undefined && arrived >= condition.msgs) {
      this.trigger(`${arrived} new input${arrived === 1 ? "" : "s"}`);
    }
  }

  private trigger(reason: string): void {
    if (!this.active) return;
    this.deactivate();
    this.wake(reason);
  }

  private deactivate(): void {
    this.clearTimer();
    this.active = false;
    this.condition = undefined;
    this.count = 0;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private wake(reason: string): void {
    this.logger.debug(`wake: ${reason}`);
    this.agent?.continue(reason);
  }
}

export const WAIT_TOOL = "wait";

export namespace WaitTool {
  export interface Input {
    /** Wake after this many new inbound messages. */
    msgs?: number;
    /** Wake after this many seconds, regardless of new input. */
    secs?: number;
  }
  export interface Output {
    ok: boolean;
    /** The declared windows; absent together with none means nothing was declared. */
    declared?: { msgs?: number; secs?: number };
    /** Set when nothing was declared: only signals and external wakes can open the next turn. */
    none?: boolean;
    error?: string;
  }
}

const MAX_MSGS = 1000;
const MAX_SECS = 86_400;

export function createWaitTool(machine: WaitConditionMachine): Tool<WaitTool.Input, WaitTool.Output> {
  return tool({
    description:
      "declare when to be woken next; last call in a waking wins, effective when it ends. " +
      "{msgs: N} = after N new inputs, {secs: T} = after T seconds, whichever comes first. " +
      "It is a one-off, not a recurring timer: one declaration wakes you once and is then spent. " +
      "See the Pacing section of your instructions for how to choose.",
    inputSchema: jsonSchema<WaitTool.Input>({
      type: "object",
      properties: {
        msgs: { type: "integer", minimum: 0, maximum: MAX_MSGS, description: "new inbound messages before the next waking" },
        secs: { type: "integer", minimum: 1, maximum: MAX_SECS, description: "seconds until the next waking regardless of input" },
      },
      required: [],
    }),
    execute: async (input): Promise<WaitTool.Output> => {
      if (input.msgs !== undefined && (!Number.isInteger(input.msgs) || input.msgs < 0 || input.msgs > MAX_MSGS)) {
        return { ok: false, error: `msgs must be an integer between 0 and ${MAX_MSGS}` };
      }
      if (input.secs !== undefined && (!Number.isInteger(input.secs) || input.secs < 1 || input.secs > MAX_SECS)) {
        return { ok: false, error: `secs must be an integer between 1 and ${MAX_SECS}` };
      }
      // 回显真正生效的条件：未声明时明确告诉模型这一轮之后没有自动唤醒。
      const outcome = machine.declare(input);
      return outcome === undefined ? { ok: true, none: true } : { ok: true, declared: outcome.condition };
    },
  });
}
