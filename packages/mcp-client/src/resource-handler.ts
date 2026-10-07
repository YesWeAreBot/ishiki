import { ResourceError, type ResourcePayload, type ResourceUrl, type SchemeHandler, type SchemeSpec } from "koishi-plugin-ishiki";

import type { ProfilePool } from "./pool.js";

/** Text extracted from a resource read, ready to inline as a resource payload. */
interface ResourceContent {
  uri: string;
  text?: string;
  blob?: string;
  mimeType?: string;
}

/**
 * `mcp://<server>/<resource-uri>` and the fallback for any unregistered
 * custom scheme: MCP resource URIs may use arbitrary or opaque forms
 * (`urn:example:doc`), so this handler owns everything not otherwise routed.
 * Pool is shared with the tool connections — resources resolve against the
 * same client sessions.
 */
export class McpResourceHandler implements SchemeHandler {
  readonly scheme = "mcp";
  readonly spec: SchemeSpec = { backing: "remote", immutable: true, scope: "runtime" };

  public constructor(private readonly pool: ProfilePool) {}

  async resolve(url: ResourceUrl): Promise<ResourcePayload> {
    const [serverName, ...rest] = url.segments;
    if (!serverName || rest.length === 0) {
      throw new ResourceError("invalid_resource_uri", `mcp URL requires server and resource URI: mcp://<server>/<resource-uri>`);
    }
    const resourceUri = rest.join("/");
    const content = await this.pool.readResource(serverName, resourceUri);
    if (content.blob !== undefined) {
      const bytes = Buffer.from(content.blob, "base64");
      return { url: url.href, bytes: new Uint8Array(bytes), mediaType: content.mimeType, size: bytes.byteLength };
    }
    const text = content.text ?? `[${content.mimeType ?? "unknown"} resource: ${resourceUri}]`;
    return { url: url.href, content: text, mediaType: content.mimeType ?? "text/plain", size: Buffer.byteLength(text) };
  }
}

export type { ResourceContent };
