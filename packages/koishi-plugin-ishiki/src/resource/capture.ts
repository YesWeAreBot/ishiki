import h from "@satorijs/element";

import type { AttachmentItem } from "../types/messages.js";
import type { ResourceCenter } from "./center.js";

/** Inbound media element types the platform layer registers as lazy resources. */
const MEDIA_KINDS: Record<string, "image" | "audio" | "video" | "file"> = { img: "image", audio: "audio", video: "video", file: "file" };

/** Wildcard media-type hint stored on the asset sidecar; the bytes decide the concrete type on read. */
const MEDIA_TYPE_HINT: Record<string, string> = { image: "image/*", audio: "audio/*", video: "video/*" };

export interface CapturedContent {
  /** Inbound content with every media `src` rewritten to its resource URL. */
  content: string;
  /** One item per media element, in document order. */
  items: AttachmentItem[];
}

/**
 * Register each media element of an inbound message as a lazy asset and
 * rewrite its `src` to the resource URL. Nothing is downloaded here: the
 * registered reference is materialized on demand, and one request's media
 * quota decides whether the bytes ever reach the model.
 */
export async function captureResources(center: ResourceCenter, content: string): Promise<CapturedContent> {
  const items: AttachmentItem[] = [];
  let nextIndex = 0;
  const rewritten = await h.transformAsync(content, async (element) => {
    const kind = MEDIA_KINDS[element.type];
    const { src, ...rest } = element.attrs;
    if (kind === undefined || typeof src !== "string") return true;
    const filename = typeof rest.file === "string" ? rest.file : typeof rest.filename === "string" ? rest.filename : undefined;
    const mediaType = kind === "file" ? undefined : MEDIA_TYPE_HINT[kind];
    const index = nextIndex++;
    const url = await center.store.registerAsset(src, {
      mediaType,
      filename,
      sourceInfo: Object.keys(rest).length > 0 ? { ...rest } : undefined,
    });
    items[index] = { url, mediaType: mediaType ?? "application/octet-stream", ...(filename === undefined ? {} : { filename }) };
    return h(element.type, { ...element.attrs, src: url }, ...element.children);
  });
  return { content: rewritten, items };
}
