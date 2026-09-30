export interface MemoryEngines {}
export interface MemoryEngineOptions {}

export abstract class MemoryEngine<K extends keyof MemoryEngines = keyof MemoryEngines> {
  public readonly name: K;
  public readonly config: MemoryEngines[K];

  constructor(name: K, config: MemoryEngines[K]) {
    this.name = name;
    this.config = config;
  }
}

const memoryEngines: Record<string, (config: never, options: MemoryEngineOptions) => MemoryEngine> = {};

export function registerMemoryEngine<K extends keyof MemoryEngines>(
  name: K,
  create: (config: MemoryEngines[K], options: MemoryEngineOptions) => MemoryEngine<K>,
): void {
  if (name in memoryEngines) throw new Error(`memory engine "${String(name)}" already registered`);
  memoryEngines[name] = create;
}

export function createMemoryEngine(config: { engine: string; [k: string]: unknown }, options: MemoryEngineOptions): MemoryEngine {
  const create = memoryEngines[config.engine];
  if (create === undefined) {
    throw new Error(`unknown memory engine "${config.engine}", available: ${Object.keys(memoryEngines).join(", ")}`);
  }
  return create((config[config.engine] ?? {}) as never, options);
}
