import { Awaitable, ToolSet } from "@yesimagent/core";

import { MemoryEngine } from "./engine.js";

declare module "./engine.js" {
  interface MemoryEngines {
    standard: StandardMemoryEngineConfig;
  }
}

export interface StandardMemoryEngineConfig {}

export class StandardMemoryEngine extends MemoryEngine<"standard"> {
  constructor(config: StandardMemoryEngineConfig) {
    super("standard", config);
  }

  extendTools = (): Awaitable<ToolSet | void> => {
    return {};
  };
}
