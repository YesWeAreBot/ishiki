import type { JevDecisionView, JevSnapshot } from "./management/types.js";

const CAPACITY = 200;

/**
 * JEV 决策环形缓冲：只保留最近若干次判定供控制台读取。
 * 这里不参与决策本身，写入失败也不应影响唤醒链路。
 */
export class JevTraceStore {
  private readonly records: JevDecisionView[] = [];
  private readonly listeners = new Set<(record: JevDecisionView) => void>();

  public record(record: JevDecisionView): void {
    this.records.push(record);
    if (this.records.length > CAPACITY) this.records.splice(0, this.records.length - CAPACITY);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // 观测端异常不影响判定链路。
      }
    }
  }

  /** 最新在前，控制台按时间倒序展示。 */
  public snapshot(): JevSnapshot {
    return { decisions: [...this.records].reverse(), collectedAt: Date.now() };
  }

  public subscribe(listener: (record: JevDecisionView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
