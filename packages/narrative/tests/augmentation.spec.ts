import { resolveProfile, type ContextConfig, type ProfileConfig, type ToolcallConfig, type ToolcallEngines } from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

// The package exports only its plugin entry. Loading the engine sources brings
// the engine-name augmentation into this program, the same way the build does.
import "../src/index.js";

// These annotations only type-check because the narrative package augments the
// core engine maps; without the augmentation "narrative" is not a known engine.
const engineName: ContextConfig["engine"] = "narrative";
const config: ProfileConfig = {
  model: "local:narrator",
  mode: "channel",
  context: { engine: "narrative", narrative: { maxTokens: 32000, refillRatio: 0.8 } },
  toolcall: { engine: "narrative", narrative: { decoderModel: "local:agent", replyModel: "local:writer" } },
};
const toolcallEngineName: ToolcallEngines["narrative"]["replyModel"] = "local:writer";
const toolcallConfig: ToolcallConfig = { engine: "narrative", narrative: { replyModel: "local:writer" } };

describe("engine type augmentation", () => {
  it("accepts narrative engine config through the core profile types", () => {
    expect(engineName).toBe("narrative");
    expect(config.context?.engine).toBe("narrative");
    expect(toolcallEngineName).toBe("local:writer");
    expect(toolcallConfig.engine).toBe("narrative");
  });

  it("parses a narrative profile at runtime", () => {
    const profile = resolveProfile(
      { model: "local:narrator", mode: "channel", channels: { "test:self": ["channel"] }, context: config.context, toolcall: config.toolcall },
      "augmented",
      ".",
    );
    expect(profile.settings.context).toEqual({ engine: "narrative", narrative: { maxTokens: 32000, refillRatio: 0.8 } });
    expect(profile.settings.toolcall).toEqual({ engine: "narrative", narrative: { decoderModel: "local:agent", replyModel: "local:writer" } });
  });
});
