import type { InboundMedia } from "../types.js";
import type { ResourceStore } from "./store.js";

/**
 * Inbound media pipeline, runtime side: register each media element's source
 * URL as an asset and rewrite the message content so the model sees
 * `<img src="asset://<id>"/>` instead of an expiring CDN link. Bytes fetch
 * lazily on first `read` (or sandbox mount access); the element's remaining
 * attributes stay in place, so the model still sees whatever the platform
 * provided.
 */
export async function rewriteInboundMedia(content: string, media: readonly InboundMedia[], store: ResourceStore): Promise<string> {
  if (media.length === 0) return content;
  let rewritten = content;
  for (const item of media) {
    const url = await store.registerAsset(item.src, { mediaType: item.mediaType, filename: item.filename, sourceInfo: item.sourceInfo });
    rewritten = rewritten.split(item.src).join(url);
  }
  return rewritten;
}
