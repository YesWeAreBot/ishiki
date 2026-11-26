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
  | "vision_question_empty"
  | "vision_model_not_configured"
  | "vision_model_unsupported"
  | "vision_media_unsupported"
  | "vision_request_failed"
  | "image_format_unsupported"
  | "image_decode_failed"
  | "image_operation_invalid";

export interface ResourceErrorOptions {
  status?: number;
  /** Explicit retryability override for attachment projection (`true` retires, `false` keeps retrying). */
  terminal?: boolean;
}

export class ResourceError extends Error {
  public readonly status?: number;
  public readonly terminal?: boolean;

  public constructor(
    public readonly code: ResourceErrorCode,
    message?: string,
    options?: ResourceErrorOptions,
  ) {
    super(message ?? code);
    this.name = "ResourceError";
    this.status = options?.status;
    this.terminal = options?.terminal;
  }
}
