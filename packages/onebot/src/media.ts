import type { Context } from "koishi";

/** 路由处理函数用到的那一小块 koa 上下文。 */
interface RouteContext {
  params: Record<string, string | undefined>;
  status: number;
  body: unknown;
  set(field: string, value: string): void;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 8;
const MAX_BYTES = 32 * 1024 * 1024;

interface Entry {
  bytes: Uint8Array;
  mediaType: string;
  expiresAt: number;
}

/**
 * 协议端需要自己拉取媒体时的临时 URL 存放处。
 *
 * 路由注册在 Koishi 的 HTTP 服务上，一个 profile 一条；条目十分钟过期，
 * 每个 profile 最多 8 条、总计 32 MiB，超出时淘汰最旧的。
 */
export class MediaPublisher {
  readonly token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);

  private readonly entries = new Map<string, Entry>();
  private registered = false;

  /** 发布一份字节，返回协议端可访问的 URL。`baseUrl` 为空时用 Koishi 的 selfUrl。 */
  public publish(ctx: Context, bytes: Uint8Array, mediaType: string, baseUrl?: string): string {
    const server = ctx.get("server");
    if (server === undefined) throw new Error("Koishi HTTP 服务不可用：启用 @koishijs/plugin-server 后才能向协议端发布媒体 URL");

    if (!this.registered) {
      server.get(`/ishiki-onebot/${this.token}/resources/:id`, (koa: RouteContext) => {
        const id = koa.params.id;
        const entry = id === undefined ? undefined : this.entries.get(id);
        if (id === undefined || entry === undefined || entry.expiresAt <= Date.now()) {
          if (id !== undefined) this.entries.delete(id);
          koa.status = 404;
          koa.body = "not found";
          return;
        }
        koa.set("Content-Type", entry.mediaType);
        koa.set("Content-Length", String(entry.bytes.byteLength));
        koa.set("Cache-Control", "no-store");
        koa.set("X-Content-Type-Options", "nosniff");
        koa.body = Buffer.from(entry.bytes);
      });
      this.registered = true;
    }

    this.evict();
    const id = crypto.randomUUID().replaceAll("-", "");
    this.entries.set(id, { bytes, mediaType, expiresAt: Date.now() + TTL_MS });
    const base = (baseUrl ?? server.selfUrl).replace(/\/+$/, "");
    return `${base}/ishiki-onebot/${this.token}/resources/${id}`;
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes.byteLength;
    for (const [id, entry] of this.entries) {
      if (total <= MAX_BYTES) break;
      total -= entry.bytes.byteLength;
      this.entries.delete(id);
    }
  }
}
