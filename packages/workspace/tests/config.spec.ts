import { describe, expect, it } from "vitest";

import { WorkspaceConfig } from "../src/config.js";

describe("workspace config", () => {
  it("fills sandbox defaults when the backend is omitted", () => {
    const config = WorkspaceConfig({});
    expect(config).toMatchObject({
      backend: "sandbox",
      cwd: "/home/workspace",
      network: false,
      javascript: false,
      python: false,
      mounts: [],
    });
    expect("shell" in config).toBe(false);
  });

  it("keeps native settings without sandbox defaults", () => {
    const config = WorkspaceConfig({ backend: "native", shell: "bash" });
    expect(config).toMatchObject({ backend: "native", shell: "bash" });
    expect("cwd" in config).toBe(false);
    expect("mounts" in config).toBe(false);
  });
});
