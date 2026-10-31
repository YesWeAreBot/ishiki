/**
 * Typed error codes for resource access failures. The model-facing reader turns
 * these into precise error text; callers may also branch on them programmatically.
 */
export type ResourceErrorCode =
  | "invalid_resource_uri"
  | "invalid_attachment_lifetime"
  | "unsupported_view"
  | "resource_unavailable"
  | "resource_not_found"
  | "resource_too_large"
  | "resource_read_failed"
  | "image_format_unsupported"
  | "image_decode_failed"
  | "image_operation_invalid";

export class ResourceError extends Error {
  public constructor(
    public readonly code: ResourceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ResourceError";
  }
}
