import { jsonSchema, tool, type Tool } from "@yesimagent/core";
import { Context, h, Logger, sleep } from "koishi";

import { matchesChannel, type InstanceDomain, type TypingConfig } from "../profile/index.js";
import type { ResourceCenter } from "../resources/center.js";
import { ResourceError } from "../resources/center.js";
import { concreteMediaType } from "../resources/media.js";

export const SEND_MESSAGE_TOOL = "send_message";

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
    target?: { sid: string; channelId: string };
  }
  export type Output = { ok: true; ids: string[] } | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
}

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
  const dataUri = `data:${payload.mediaType};base64,${Buffer.from(payload.bytes).toString("base64")}`;
  return h(element.type, { ...element.attrs, src: dataUri }).toString();
}

async function readForSend(src: string, resources: ResourceCenter, dropped: string[]): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  try {
    const payload = await resources.resolve(src);
    if (payload.bytes === undefined) {
      dropped.push(`${src}: 不是可发送的媒体`);
      return undefined;
    }
    return { bytes: payload.bytes, mediaType: concreteMediaType(payload.mediaType, payload.bytes) ?? "application/octet-stream" };
  } catch (error) {
    const code = error instanceof ResourceError ? error.code : "resource_read_failed";
    dropped.push(`${src}: ${code}`);
    return undefined;
  }
}

export function createSendMessage(options: SendMessageTool.Options): Tool<SendMessageTool.Input, SendMessageTool.Output> {
  const { ctx, logger, domain, typing } = options;

  const cross = domain.mode === "cross";
  if (cross && domain.channels.size === 0) throw new Error("cross-mode domain has no channels");

  return tool({
    description: cross
      ? "Send visible messages to a channel. Copy target from its [channel target=...] header."
      : "Send visible messages to the current channel.",
    inputSchema: jsonSchema<SendMessageTool.Input>({
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "string" }, minItems: 1, description: "messages to send" },
        mode: { type: "string", enum: ["element", "raw"], description: "message mode" },
        continue: { type: "boolean", description: "whether to continue sending messages after a failure" },
        ...(cross
          ? {
              target: {
                type: "object" as const,
                description: "Destination target, copied unchanged from the channel header.",
                properties: {
                  sid: { type: "string" as const, minLength: 1, description: "Bot account SID (platform:selfId)." },
                  channelId: { type: "string" as const, minLength: 1, description: "Channel ID (group or private), not sender ID." },
                },
                required: ["sid", "channelId"],
                additionalProperties: false,
              },
            }
          : {}),
      },
      required: cross ? ["messages", "target"] : ["messages"],
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

async function sendToChannel(ctx: Context, domain: InstanceDomain, target: SendMessageTool.Input["target"], fragment: h.Fragment): Promise<string[]> {
  if (domain.mode === "channel") {
    const bot = ctx.bots[`${domain.platform}:${domain.selfId}`];
    if (!bot) throw new Error(`bot ${domain.platform}:${domain.selfId} not available`);
    return bot.sendMessage(domain.channelId, fragment);
  }
  if (!target || typeof target.sid !== "string" || target.sid.length === 0 || typeof target.channelId !== "string" || target.channelId.length === 0) {
    throw new Error("cross-mode send_message requires target: { sid, channelId }; copy it from the destination channel's header");
  }
  const { sid, channelId } = target;
  const filter = domain.channels.get(sid);
  if (!filter || !matchesChannel(filter, channelId)) throw new Error(`target ${JSON.stringify(target)} is outside this cross-mode domain`);
  const bot = ctx.bots[sid];
  if (!bot) throw new Error(`bot ${sid} not available`);
  return bot.sendMessage(channelId, fragment);
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
