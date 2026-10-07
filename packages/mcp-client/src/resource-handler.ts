import { ResourceError, type ResourcePayload, type ResourceUrl, type SchemeHandler } from "koishi-plugin-ishiki";

import type { ProfilePool } from "./pool.js";

/**
 * `mcp://<server>/<resource-uri>` — remote resources from the connected MCP
 * servers. The wrapped URI is arbitrary and may carry colons, slashes, or
 * query strings of its own, so the scheme is opaque: the tail is taken
 * verbatim from `rawTail`, with no view or selector parsing.
 */
export class McpResourceHandler implements SchemeHandler {
  readonly scheme = "mcp";
  readonly opaque = true;

  public constructor(private readonly pool: ProfilePool) {}

  async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const serverName = url.authority;
    const resourceUri = url.rawTail.replace(/^\//, "");
    if (!serverName || resourceUri.length === 0) {
      throw new ResourceError("invalid_resource_uri", `mcp URL requires server and resource URI: mcp://<server>/<resource-uri>`);
    }
    const content = await this.pool.readResource(serverName, resourceUri);
    if (content.blob !== undefined) {
      const bytes = Buffer.from(content.blob, "base64");
      return { url: url.href, bytes: new Uint8Array(bytes), mediaType: content.mimeType, size: bytes.byteLength };
    }
    const text = content.text ?? `[${content.mimeType ?? "unknown"} resource: ${resourceUri}]`;
    return { url: url.href, content: text, mediaType: content.mimeType ?? "text/plain", size: Buffer.byteLength(text) };
  }
}
