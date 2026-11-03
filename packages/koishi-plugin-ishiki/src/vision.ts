import type { LanguageModelV4 } from "@yesimagent/core";
import type { Gateway } from "@yesimagent/gateway";
import type Logger from "reggol";

import { FailoverModel } from "./failover.js";
import type { FailoverConfig } from "./profile/config.js";
import { supportsImageInput } from "./resource/capabilities.js";
import { ResourceError } from "./resource/errors.js";

export function createVisionModel(
  gateway: Gateway,
  configured: string | undefined,
  failoverConfig: FailoverConfig,
  logger: Logger,
): LanguageModelV4 | undefined {
  const reference = configured?.trim();
  if (!reference) return undefined;
  if (!supportsImageInput(gateway, reference)) {
    throw new ResourceError("vision_model_unsupported", `vision model "${reference}" must declare image input on every candidate`);
  }
  return gateway.groups().includes(reference) || (failoverConfig.attempts ?? 1) > 1
    ? new FailoverModel(gateway, reference, failoverConfig, logger)
    : gateway.languageModel(reference);
}
