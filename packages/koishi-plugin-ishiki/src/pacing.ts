import type { StepOptions } from "@yesimagent/core";

import { SEND_MESSAGE_TOOL } from "./builtin-tools/send-message.js";
import type { PacingConfig } from "./profile/config.js";

/**
 * 一轮之内跨步保留的事实：本轮是否已经尝试或成功发送、进度提醒是否已经给过，
 * 以及普通文本结束后的终止校验是否已经请求或注入。
 * 按 turnId 惰性重置，所以运行时不需在轮次边界上挂钩子。
 */
export class PacingState {
  private turnId: string | undefined;
  private spoke = false;
  private visible = false;
  private progressSent = false;
  private terminalPending = false;
  private terminalUsed = false;

  /** 每个 step 结束时喂一次本步调用的工具名，用来知道「已经说过话」。 */
  observe(turnId: string, toolNames: readonly string[], visible = false): void {
    this.reset(turnId);
    if (toolNames.includes(SEND_MESSAGE_TOOL)) this.spoke = true;
    if (visible) this.visible = true;
  }

  /** 普通文本已经结束一步且用户看不到它时，安排一次只作用于下一请求的终止校验。 */
  requestTerminalGuard(turnId: string, enabled: boolean): boolean {
    this.reset(turnId);
    if (!enabled || this.terminalUsed || this.visible) return false;
    this.terminalPending = true;
    return true;
  }

  /**
   * 取一条给下一步的提醒。收尾优先于进度：步数不够时，先说话比继续干活重要。
   * 一步最多一条，进度提醒一轮最多一次。
   */
  take(turnId: string, stepNumber: number, budget: PacingConfig): string | undefined {
    this.reset(turnId);
    if (this.terminalPending) {
      this.terminalPending = false;
      if (budget.terminalGuard === true && !this.terminalUsed && !this.visible) {
        this.terminalUsed = true;
        return terminalReminder();
      }
    }
    const remaining = budget.maxSteps - stepNumber;
    if (budget.wrapUpSteps > 0 && remaining <= budget.wrapUpSteps) return wrapUpReminder(remaining);
    if (budget.progressAt === 0 || this.progressSent || this.spoke || stepNumber < budget.progressAt) return undefined;
    this.progressSent = true;
    return progressReminder(remaining);
  }

  private reset(turnId: string): void {
    if (this.turnId === turnId) return;
    this.turnId = turnId;
    this.spoke = false;
    this.visible = false;
    this.progressSent = false;
    this.terminalPending = false;
    this.terminalUsed = false;
  }
}

/** 收尾提醒：报出剩余步数，要求把成果落在一条消息上，并把下一个唤醒条件一起声明。 */
function wrapUpReminder(remaining: number): string {
  const left = remaining === 1 ? "1 step" : `${remaining} steps`;
  return [
    `Step budget: ${left} left in this waking, and this waking ends without a reply if none of them sends a message.`,
    `Stop starting new work. Send what you have now with ${SEND_MESSAGE_TOOL} — describe what is finished, what is not, and what the next waking should pick up.`,
    "Call wait in the same step if you intend to come back; a message on its own leaves you silent until someone signals you.",
  ].join(" ");
}

/** 进度提醒：一条短消息加 continue，把这一轮留在打开状态。 */
function progressReminder(remaining: number): string {
  return [
    `Step budget: ${remaining} steps left in this waking.`,
    `This task is taking a while, so send one short bubble now with ${SEND_MESSAGE_TOOL} plus continue: true to say what you are doing, then keep working in the same waking.`,
  ].join(" ");
}

/** 终止校验：普通 assistant 文本不会发给用户，必须用工具明确收尾。 */
function terminalReminder(): string {
  return [
    "Your previous step ended with plain assistant text, and the user received nothing.",
    `Send the result with ${SEND_MESSAGE_TOOL}, schedule another waking with wait, or finish this waking with finish.`,
    "Do not end another step with plain assistant text alone.",
  ].join(" ");
}

/** 提醒只是一次性的上下文：追加到本次请求的副本上，不写进事实流。 */
export function appendReminder(options: StepOptions, text: string): StepOptions {
  return { ...options, messages: [...options.messages, { role: "user", content: text }] };
}
