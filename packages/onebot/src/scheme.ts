import { ResourceError, type ResourcePayload, type SchemeHandler } from "koishi-plugin-ishiki";

import { findAction } from "./catalog/index.js";
import { renderAction, renderIndex } from "./catalog/render.js";
import type { Backend } from "./catalog/types.js";

/**
 * `onebot://actions` 与 `onebot://actions/<name>`：动作目录本身也是资源，
 * 模型可以用 read 工具翻，和工具调用读的是同一份数据。
 */
export class CatalogScheme implements SchemeHandler {
  readonly scheme = "onebot";

  public constructor(private readonly backend: Backend) {}

  resolve(fullUrl: string): ResourcePayload {
    const rest = fullUrl.replace(/^onebot:\/\//i, "");
    const [authority, ...segments] = rest.split("/");
    if (authority !== "actions") {
      throw new ResourceError("invalid_resource_uri", `unknown onebot resource "${fullUrl}"; use onebot://actions or onebot://actions/<name>`);
    }
    if (segments.length === 0) {
      const text = renderIndex(this.backend);
      return { type: "text", url: fullUrl, text, size: Buffer.byteLength(text), mediaType: "text/markdown" };
    }
    if (segments.length > 1) {
      throw new ResourceError("invalid_resource_uri", `onebot action URL takes a single name: onebot://actions/<name>, got ${fullUrl}`);
    }
    const action = findAction(segments[0]!);
    if (action === undefined || !action.backends.includes(this.backend)) {
      throw new ResourceError("resource_not_found", `no action "${segments[0]}" in the ${this.backend} catalog; see onebot://actions`);
    }
    const text = renderAction(action, this.backend);
    return { type: "text", url: fullUrl, text, size: Buffer.byteLength(text), mediaType: "text/markdown" };
  }
}
