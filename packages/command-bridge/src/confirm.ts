import { randomBytes } from "node:crypto";

import { h, type Context, type Session } from "koishi";

interface Pending {
  source: Session;
  deadline: number;
  perform: () => Promise<void>;
  timer: NodeJS.Timeout;
}

// Only a new inbound message can confirm. The model never receives the nonce in a tool result.
export class Confirmations {
  private pending = new Map<string, Pending>();

  constructor(ctx: Context) {
    ctx.middleware(async (session, next) => {
      const match = /^确认执行 ([a-f0-9]{16})$/u.exec(session.content ?? "");
      if (!match || !this.pending.has(match[1])) return next();
      const request = this.pending.get(match[1])!;
      const source = request.source;
      if (
        session.type !== "message-created" ||
        !session.messageId ||
        session.messageId === source.messageId ||
        session.platform !== source.platform ||
        session.selfId !== source.selfId ||
        session.userId !== source.userId ||
        session.userId === session.selfId ||
        session.event.user?.isBot ||
        session.guildId !== source.guildId ||
        session.channelId !== source.channelId
      )
        return next();

      this.discard(match[1]);
      if (Date.now() >= request.deadline) return "确认已过期。";
      try {
        await request.perform();
      } catch {
        return "未能确认命令执行结果。请先查看频道记录。";
      }
    }, true);
    ctx.on("internal/session", (session) => {
      if (session.type !== "message-deleted") return;
      for (const [key, { source }] of this.pending) {
        if (
          session.platform === source.platform &&
          session.selfId === source.selfId &&
          session.channelId === source.channelId &&
          session.messageId === source.messageId
        )
          this.discard(key);
      }
    });
    ctx.on("dispose", () => {
      for (const key of this.pending.keys()) this.discard(key);
    });
  }

  private discard(key: string): void {
    const pending = this.pending.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(key);
  }

  async request(source: Session, name: string, args: readonly string[], perform: () => Promise<void>): Promise<void> {
    const now = Date.now();
    if (this.pending.size >= 256) throw new Error("confirmation queue full");
    const nonce = randomBytes(8).toString("hex");
    const timer = setTimeout(() => this.discard(nonce), 60_000).unref();
    const request = { source, deadline: now + 60_000, perform, timer };
    this.pending.set(nonce, request);
    try {
      const display = [name, ...args.map((arg) => JSON.stringify(arg))].join(" ");
      const ids = await source.send(h.text(`即将以请求者的账号执行「${display}」，可能扣费或改变账号状态。请请求者在 60 秒内单独发送：确认执行 ${nonce}`));
      if (!ids?.length) throw new Error("confirmation delivery unverified");
    } catch (error) {
      this.discard(nonce);
      throw error;
    }
  }
}
