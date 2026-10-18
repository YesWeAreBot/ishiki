import { ResourceError, concreteMediaType, type ResourcePayload, type SchemeHandler } from "koishi-plugin-ishiki";

import type { ProfilePool } from "./pool.js";

/**
 * `mcp://<server>/<resource-uri>` — remote resources from the connected MCP
 * servers. The wrapped URI is arbitrary and may carry colons, slashes, query
 * strings or fragments of its own, so the tail after the server name is taken
 * verbatim: no view or selector parsing, no re-encoding.
 */
export class McpResourceHandler implements SchemeHandler {
  readonly scheme = "mcp";

  public constructor(private readonly pool: ProfilePool) {}

  async resolve(fullUrl: string): Promise<ResourcePayload> {
    const rest = fullUrl.replace(/^mcp:\/\//i, "");
    const split = rest.indexOf("/");
    const serverName = split === -1 ? rest : rest.slice(0, split);
    const resourceUri = split === -1 ? "" : rest.slice(split + 1);
    if (serverName.length === 0 || resourceUri.length === 0) {
      throw new ResourceError("invalid_resource_uri", `mcp URL requires server and resource URI: mcp://<server>/<resource-uri>`);
    }
    const content = await this.pool.readResource(serverName, resourceUri);
    if (content.blob !== undefined) {
      const bytes = Buffer.from(content.blob, "base64");
      return {
        type: "file",
        url: fullUrl,
        bytes,
        mediaType: concreteMediaType(content.mimeType, bytes) ?? "application/octet-stream",
        size: bytes.byteLength,
        // A remote resource is live: the server may serve different bytes later.
        immutable: false,
      };
    }
    const text = content.text ?? `[${content.mimeType ?? "unknown"} resource: ${resourceUri}]`;
    return { type: "text", url: fullUrl, text, mediaType: content.mimeType ?? "text/plain", size: Buffer.byteLength(text) };
  }
}
