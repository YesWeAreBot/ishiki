import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceConfig } from "../src/config.js";
import { workspaceInstructions } from "../src/prompt.js";
import { createSandbox } from "../src/sandbox.js";
import { resolveLayout, type ShellOptions } from "../src/shell.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

let base: string;
let home: string;
let root: string;
let dataPath: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-workspace-prompt-"));
  home = path.join(base, "home");
  root = path.join(base, "profiles", "neko");
  dataPath = path.join(base, "data");
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(root, { recursive: true }), fs.mkdir(dataPath, { recursive: true })]);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("sandbox prompt", () => {
  it("describes the actual runtimes and points to the environment skill", async () => {
    const config: WorkspaceConfig = {
      backend: "sandbox",
      shell: "",
      cwd: "/home/workspace",
      timeoutMs: 30_000,
      maxExecutionOutputBytes: 32 * 1024 * 1024,
      network: false,
      javascript: true,
      python: true,
      skills: [],
      mounts: [],
    };
    const options: ShellOptions = { config, home, root, dataPath, logger: silent };
    const shell = await createSandbox(resolveLayout(options), options);
    const instructions = workspaceInstructions(shell);

    expect(instructions).toContain("commands run in just-bash");
    expect(instructions).toContain("sandbox-environment skill");
    expect(instructions).toContain("partial Node.js module surface");
    expect(instructions).toContain("subprocess and the sqlite3 module are absent");
    expect(instructions).toContain("/tmp belongs to this sandbox lifetime");
    expect(instructions).not.toContain("commands are interpreted by JavaScript");
    expect(instructions).not.toContain("full standard library");
  });
});
