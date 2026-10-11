import { createCustomMessage, type AgentMessage, type Tool, type ToolResultOutput, type ToolSet, type TurnOptions } from "@yesimagent/core";
import { h } from "koishi";

import type { ResourceCenter } from "../resources/center.js";
import type { AgentRuntime } from "../runtime.js";
import type { AttachmentItem } from "../types.js";
import { type AttachmentConfig } from "./config.js";
import { processOutput } from "./output.js";
import { attachmentMessages, projectAttachments } from "./projection.js";

const MEDIA_KINDS = { img: "image", audio: "audio", video: "video", file: "file" } as const;

const MEDIA_TYPE_HINT = { image: "image/*", audio: "audio/*", video: "video/*" } as const;

/**
 * One runtime's attachment handling. It owns the policy and the resource
 * center, and lives exactly as long as the runtime: created in the
 * constructor, stopped with it.
 */
export class Attachment {
  public constructor(
    private readonly config: AttachmentConfig,
    private readonly resources: ResourceCenter,
    private readonly runtime: AgentRuntime,
  ) {}

  /**
   * Register each media element of an inbound message as an asset and emit
   * one attachment message for it. History replay never re-parses the body;
   * projection drops the message when the source message is retracted.
   */
  public async capture(content: string, origin: { platform: string; selfId: string; channelId: string; messageId: string }): Promise<string> {
    const items: AttachmentItem[] = [];
    const rewritten = await h.transformAsync(content, async (element) => {
      const kind = MEDIA_KINDS[element.type as keyof typeof MEDIA_KINDS];
      const { src, ...rest } = element.attrs;
      if (!kind || typeof src !== "string") return true;
      const filename = typeof rest.file === "string" ? rest.file : typeof rest.filename === "string" ? rest.filename : undefined;
      const url = await this.resources.store.registerAsset(src, {
        mediaType: kind === "file" ? undefined : MEDIA_TYPE_HINT[kind],
        filename,
        sourceInfo: Object.keys(rest).length > 0 ? { ...rest } : undefined,
      });
      items.push({ url, mediaType: kind === "file" ? "application/octet-stream" : MEDIA_TYPE_HINT[kind]!, ...(filename === undefined ? {} : { filename }) });
      return h(element.type, { ...element.attrs, src: url }, ...element.children);
    });
    if (items.length > 0) {
      this.runtime.agent.send(createCustomMessage("ishiki.attachment", { source: "platform", ...origin, items }), { ifBusy: "join", trigger: false });
    }
    return rewritten;
  }

  /**
   * Project history for one model request: drop orphaned attachments, let the
   * context engine render, then apply this request's quota. The runtime's
   * plugin calls it from `transformMessages`.
   */
  public async project(messages: AgentMessage[], options: TurnOptions): Promise<AgentMessage[]> {
    const associated = attachmentMessages(messages);
    const rendered = (await this.runtime.context.renderMessages?.(associated, options)) ?? associated;
    return projectAttachments(rendered, this.resources, this.config);
  }

  /**
   * Wrap the tools for one step. The runtime merges its own tools, extensions
   * and codemode first, then hands them here. Each tool still converts its
   * own output; the wrapper externalizes media, truncates past the shared
   * budget, and emits one attachment message per result that carried media.
   */
  public wrap(tools: ToolSet): ToolSet {
    const wrapped: ToolSet = {};
    for (const [name, original] of Object.entries(tools)) {
      const descriptors = Object.getOwnPropertyDescriptors(original);
      descriptors.toModelOutput = {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async (options: Parameters<NonNullable<typeof original.toModelOutput>>[0]) => {
          const converted = await this.convert(original, options);
          const { output, items } = await processOutput(this.resources, name, converted);
          if (items.length > 0) {
            this.runtime.agent.send(createCustomMessage("ishiki.attachment", { source: "tool", toolName: name, toolCallId: options.toolCallId, items }), {
              ifBusy: "join",
              trigger: false,
            });
          }
          return output;
        },
      };
      wrapped[name] = Object.defineProperties({}, descriptors) as Tool;
    }
    return wrapped;
  }

  /** The tool's own conversion, or the SDK default when it has none. */
  private async convert(original: Tool, options: Parameters<NonNullable<Tool["toModelOutput"]>>[0]): Promise<ToolResultOutput> {
    if (original.toModelOutput) return original.toModelOutput.call(original, options);
    return typeof options.output === "string" ? { type: "text", value: options.output } : { type: "json", value: options.output as never };
  }
}

export { AttachmentConfig } from "./config.js";
