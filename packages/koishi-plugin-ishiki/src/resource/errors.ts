/**
 * Typed error codes for resource access failures. The model-facing reader turns
 * these into precise error text; callers may also branch on them programmatically.
 */
export type ResourceErrorCode =
  | "invalid_resource_uri"
  | "unsupported_view"
  | "resource_unavailable"
  | "resource_not_found"
  | "resource_too_large"
  | "resource_read_failed";

export class ResourceError extends Error {
  public constructor(
    public readonly code: ResourceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ResourceError";
  }
}
