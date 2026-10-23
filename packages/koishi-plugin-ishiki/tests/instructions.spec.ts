import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadInstructionFiles, renderInstructions } from "../src/instructions.js";
import { resolveProfile } from "../src/profile/config.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-instructions-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("profile instructions", () => {
  it("defaults to PERSONA.md", () => {
    const profile = resolveProfile({ model: "mock:chat", channels: { "test:bot": ["*"] } }, "test", root);
    expect(profile.settings.instructions).toEqual(["PERSONA.md"]);
  });

  it("keeps the declared file list", () => {
    const profile = resolveProfile({ model: "mock:chat", channels: { "test:bot": ["*"] }, instructions: ["b.md", "/absolute/a.md"] }, "test", root);
    expect(profile.settings.instructions).toEqual(["b.md", "/absolute/a.md"]);
  });

  it("loads files in declaration order and reports missing entries", async () => {
    await fs.writeFile(path.join(root, "a.md"), "first\n");
    await fs.writeFile(path.join(root, "b.md"), "second\n");
    const absolute = path.join(root, "c.md");
    await fs.writeFile(absolute, "third\n");

    const loaded = loadInstructionFiles(["a.md", "missing.md", absolute, "b.md"], root);

    expect(loaded.text).toBe("first\n\nthird\n\nsecond");
    expect(loaded.missing).toEqual([path.join(root, "missing.md")]);
  });

  it("appends the loaded text to the end of the system prompt", () => {
    const rendered = renderInstructions({ enableCodemode: false, enableImageInput: false, enableReadLifetime: false, instructions: "APPENDED" });
    expect(rendered.trimEnd().endsWith("APPENDED")).toBe(true);
  });
});
