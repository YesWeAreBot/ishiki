import type { InboundMedia } from "../types.js";
import type { AssetRegistry } from "./asset.js";

/**
 * Inbound media pipeline, runtime side: register each media element's source
 * URL as an asset and rewrite the message content so the model sees
 * `<img src="asset://<id>"/>` instead of an expiring CDN link. Bytes fetch
 * lazily on first `read` (or sandbox mount access).
 */
export async function rewriteInboundMedia(content: string, media: readonly InboundMedia[], assets: AssetRegistry): Promise<string> {
  if (media.length === 0) return content;
  let rewritten = content;
  for (const item of media) {
    const url = await assets.register(item.src, { filename: item.filename });
    rewritten = rewritten.split(item.src).join(url);
  }
  return rewritten;
}
