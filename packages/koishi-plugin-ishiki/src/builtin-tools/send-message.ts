import { jsonSchema, tool, type Tool } from "@yesimagent/core";
import { Context, h, Logger, sleep } from "koishi";

import type { InstanceDomain, TypingConfig } from "../profile/index.js";
import type { ResourceCenter } from "../resources/center.js";
import { ResourceError } from "../resources/center.js";

export namespace SendMessageTool {
  export interface Options {
    ctx: Context;
    logger: Logger;
    domain: InstanceDomain;
    typing: TypingConfig;
    /** Resolves resource URLs in outbound elements; omit to disable media sending. */
    resources?: ResourceCenter;
  }
  export interface Input {
    messages: string[];
    mode?: "element" | "raw";
    continue?: boolean;
    target?: string;
  }
  export type Output = { ok: true; ids: string[] } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
}

const MEDIA_SNIFF: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  "image/webp": (b) => b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45,
};

/**
 * Outbound media resolver. `src` may be an asset://, artifact://,
 * local:// or workspace:// URL (per the send whitelist) — it becomes a data:
 * URI element. A URL that fails to resolve is dropped from the message
 * (reported in the tool output), never blocks the send.
 */
export async function resolveOutboundMedia(content: string, resources: ResourceCenter | undefined): Promise<{ content: string; dropped: string[] }> {
  if (resources === undefined) return { content, dropped: [] };
  const dropped: string[] = [];
  const rewritten = await rewriteElements(content, resources, dropped);
  return { content: rewritten, dropped };
}

async function rewriteElements(content: string, resources: ResourceCenter, dropped: string[]): Promise<string> {
  const elements = h.parse(content);
  const out: string[] = [];
  for (const element of elements) {
    out.push(await resolveElement(element, resources, dropped));
  }
  return out.join("");
}

async function resolveElement(element: h, resources: ResourceCenter, dropped: string[]): Promise<string> {
  const children =
    element.children.length > 0
      ? (await Promise.all(element.children.map((child) => (typeof child === "object" ? resolveElement(child, resources, dropped) : String(child))))).join("")
      : "";
  const rendered = children.length > 0 ? h(element.type, element.attrs, children).toString() : h(element.type, element.attrs).toString();
  const src = element.attrs.src;
  if (typeof src !== "string" || !/^(asset|artifact|local|workspace):\/\//.test(src)) return rendered;

  const payload = await readForSend(src, resources, dropped);
  if (!payload) return "";
  const mediaType = payload.mediaType ?? sniffMedia(payload.bytes!) ?? "application/octet-stream";
  const dataUri = `data:${mediaType};base64,${Buffer.from(payload.bytes!).toString("base64")}`;
  return h(element.type, { ...element.attrs, src: dataUri }).toString();
}

async function readForSend(src: string, resources: ResourceCenter, dropped: string[]): Promise<{ bytes: Uint8Array; mediaType?: string } | undefined> {
  try {
    // asset:// 的 resolve 是元数据卡片；发送需要真字节，走 AssetHandlerView。
    if (src.startsWith("asset://")) {
      const id = src.slice("asset://".length);
      const view = resources.assetView();
      if (!view) {
        dropped.push(`${src}: resource_unavailable`);
        return undefined;
      }
      const record = await view.getRecord(id);
      if (!record) {
        dropped.push(`${src}: resource_not_found`);
        return undefined;
      }
      const bytes = await view.readBytes(id);
      return { bytes, mediaType: record.mediaType };
    }
    const payload = await resources.resolve(src);
    if (payload.bytes === undefined) {
      dropped.push(`${src}: 不是可发送的媒体（${payload.content?.slice(0, 40) ?? "无字节"}）`);
      return undefined;
    }
    return { bytes: payload.bytes, mediaType: payload.mediaType };
  } catch (error) {
    const code = error instanceof ResourceError ? error.code : "resource_read_failed";
    dropped.push(`${src}: ${code}`);
    return undefined;
  }
}

function sniffMedia(bytes: Uint8Array): string | undefined {
  for (const [mediaType, matches] of Object.entries(MEDIA_SNIFF)) {
    if (matches(bytes)) return mediaType;
  }
  return undefined;
}

export function createSendMessage(options: SendMessageTool.Options): Tool<SendMessageTool.Input, SendMessageTool.Output> {
  const { ctx, logger, domain, typing } = options;

  return tool({
    description: "send message to the channel",
    inputSchema: jsonSchema<SendMessageTool.Input>({
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "string" }, minItems: 1, description: "messages to send" },
        mode: { type: "string", enum: ["element", "raw"], description: "message mode" },
        continue: { type: "boolean", description: "whether to continue sending messages after a failure" },
        target: { type: "string", description: "target user id for private message" },
      },
      required: ["messages"],
    }),
    execute: async (input) => {
      const ids: string[] = [];
      const allDropped: string[] = [];
      for (const message of input.messages) {
        try {
          const { content, dropped } = await resolveOutboundMedia(message, options.resources);
          allDropped.push(...dropped);
          const fragment = input.mode === "element" ? h.parse(content) : h.text(content);
          const sent = await sendToChannel(ctx, domain, input.target, fragment);
          ids.push(...sent);
          await sleep(calculateTypingDelay(message, typing));
        } catch (error) {
          logger.warn("Failed to send message: %o", error);
          if (input.continue === true) continue;
          return {
            ok: false,
            error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
            sent: ids,
            failedAt: ids.length,
          };
        }
      }
      if (allDropped.length > 0) ids.push(`[dropped media: ${allDropped.join("; ")}]`);
      return { ok: true, ids };
    },
  });
}

async function sendToChannel(ctx: Context, domain: InstanceDomain, target: string | undefined, fragment: h.Fragment): Promise<string[]> {
  if (domain.mode === "channel") {
    const bot = ctx.bots.find((entry) => entry.platform === domain.platform && entry.selfId === domain.selfId);
    if (!bot) throw new Error(`bot ${domain.platform}:${domain.selfId} not available`);
    if (target) return bot.sendMessage(target, fragment);
    return bot.sendMessage(domain.channelId, fragment);
  }
  const sent: string[] = [];
  for (const channelId of domain.channels.keys()) {
    const [platform, selfId] = channelId.split(":");
    const bot = ctx.bots.find((entry) => entry.platform === platform && entry.selfId === selfId);
    if (!bot) continue;
    sent.push(...(await bot.sendMessage(channelId, fragment)));
  }
  return sent;
}

function calculateTypingDelay(content: string, typing: TypingConfig): number {
  const { baseDelay, charPerSecond, minDelay, maxDelay } = typing;
  if (charPerSecond <= 0) return minDelay;

  const plain = h
    .parse(content)
    .filter((element) => element.type === "text")
    .map((element) => element.attrs?.content ?? String(element))
    .join("");
  if (plain.length === 0) return minDelay;

  const cjk = (plain.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = plain.length - cjk;

  const typed = (cjk / charPerSecond + latin / (charPerSecond * 1.5)) * 1000;

  const spread = (cjk * 0.5 + latin * 0.3) / plain.length;
  const delay = baseDelay + typed * (1 + (Math.random() - 0.5) * 2 * spread);
  return Math.max(minDelay, Math.min(delay, maxDelay));
}
