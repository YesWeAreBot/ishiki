import { MemoryEngine, registerMemoryEngine, createMemoryEngine } from "./engine.js";

export interface BlockMemoryEngineConfig {}

declare module "./engine.js" {
  interface MemoryEngines {
    block: BlockMemoryEngineConfig;
  }
}

export class BlockMemoryEngine extends MemoryEngine<"block"> {}

registerMemoryEngine("block", (config, options) => new BlockMemoryEngine("block", config));
