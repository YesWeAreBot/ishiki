import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { App } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import Ishiki from "../src/index.js";
import { installDefaultPreset } from "../src/preset.js";
import { resolveProfile } from "../src/profile/config.js";

const temporaryRoot = path.resolve("cache", "test-presets");

describe("default preset", () => {
  let app: App | undefined;
  let dataPath: string;

  beforeEach(async () => {
    await mkdir(temporaryRoot, { recursive: true });
    dataPath = await mkdtemp(path.join(temporaryRoot, "data-"));
  });

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    await rm(dataPath, { recursive: true, force: true });
  });

  it("creates a usable profile, persona, and model configuration", async () => {
    expect(installDefaultPreset(dataPath)).toBe(true);

    const profileRoot = path.join(dataPath, "profiles", "default");
    const rawProfile = parse(await readFile(path.join(profileRoot, "profile.yaml"), "utf8"));
    const profile = resolveProfile(rawProfile, "default", profileRoot);
    expect(profile.settings.model).toBe("deepseek:deepseek-flash");
    expect(profile.mode).toBe("channel");
    expect(profile.settings.instructions).toEqual(["PERSONA.md"]);
    expect(profile.settings.context.engine).toBe("chat");
    expect(profile.settings.wakeup.engine).toBe("standard");
    expect(profile.settings.toolcall.engine).toBe("native");
    expect(profile.settings.codemode.enable).toBe(true);
    expect([...profile.channels.keys()]).toEqual(["onebot:BOT_ID"]);

    const models = parse(await readFile(path.join(dataPath, "models.yaml"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string; toolCall?: boolean }> }>;
    };
    expect(models.providers.deepseek.models.map((model) => model.id)).toEqual(["deepseek-flash"]);
    expect(models.providers.deepseek.models[0].toolCall).toBe(true);

    const persona = await readFile(path.join(profileRoot, "PERSONA.md"), "utf8");
    expect(persona).toContain("清晰、耐心、可靠");
  });

  it("keeps existing data and never overwrites released files", async () => {
    const modelsFile = path.join(dataPath, "models.yaml");
    const existing = "providers: {}\n";
    await writeFile(modelsFile, existing);
    expect(installDefaultPreset(dataPath)).toBe(false);
    expect(await readFile(modelsFile, "utf8")).toBe(existing);

    await rm(modelsFile);
    expect(installDefaultPreset(dataPath)).toBe(true);
    const personaFile = path.join(dataPath, "profiles", "default", "PERSONA.md");
    await writeFile(personaFile, "自定义人格\n");
    expect(installDefaultPreset(dataPath)).toBe(false);
    expect(await readFile(personaFile, "utf8")).toBe("自定义人格\n");
  });

  it("initializes a fresh data directory during plugin startup", async () => {
    app = new App();
    app.plugin(Ishiki, { dataPath, dumpRequests: false, debugStream: false, logLevel: 0 });
    await app.start();

    const service = app.get("ishiki") as Ishiki;
    expect(service.gateway.providers()).toContain("deepseek");
    expect(await readFile(path.join(dataPath, "models.yaml"), "utf8")).toContain("YOUR_API_KEY");
    expect(service.profiles.has("default")).toBe(true);
  });
});
