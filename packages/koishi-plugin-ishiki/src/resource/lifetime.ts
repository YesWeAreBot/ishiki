import type { ImageLifetime } from "../types/messages.js";
import { ResourceError } from "./errors.js";

/** Attachment lifetimes, most transient first. */
export const IMAGE_LIFETIMES = ["once", "recent", "retain"] as const satisfies readonly ImageLifetime[];

/** Validate a requested lifetime; absent means the default `once`. */
export function parseImageLifetime(value: unknown): ImageLifetime | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (IMAGE_LIFETIMES as readonly string[]).includes(value)) return value as ImageLifetime;
  throw new ResourceError("invalid_attachment_lifetime", `unknown attachment lifetime ${JSON.stringify(value)}; expected ${IMAGE_LIFETIMES.join(", ")}`);
}
