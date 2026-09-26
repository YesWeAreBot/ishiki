import { AgentPlugin } from "@yesimagent/core";

export interface MemoryEngines {}

export abstract class MemoryEngine<K extends keyof MemoryEngines = keyof MemoryEngines> implements AgentPlugin {
  public readonly name: K;
  public readonly config: MemoryEngines[K];

  constructor(name: K, config: MemoryEngines[K]) {
    this.name = name;
    this.config = config;
  }
}
