import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { ResourceCenter, ResourceStore } from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

import { createSandbox, resolveLayout, WorkspaceConfig, type SandboxOptions } from "../src/index.js";

describe("truncation spill", () => {
  it("returns complete bash output without internal model-output archival", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-spill-"));
    try {
      const center = new ResourceCenter("rt1", home);

      const config = WorkspaceConfig({});
      const options: SandboxOptions = { config, home, root: home, dataPath: home, logger: { warn() {}, info() {}, level: 1 } as never, resources: center };
      const sandbox = await createSandbox(resolveLayout(options), options);
      const result = await sandbox.exec("yes hello | head -200");

      expect(result.stdout).toBe("hello\n".repeat(200));
      expect(await center.store.namespaces("artifact")).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("mounts the resource center under /home/.ishiki with matching bytes", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-mount-"));
    try {
      const store = new ResourceStore(home);
      const center = new ResourceCenter("rt1", home, store);
      const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
      await store.putInHand("artifact", "bash", "demo.log", new TextEncoder().encode("hello from artifact"), {});

      const config = WorkspaceConfig({});
      const options: SandboxOptions = { config, home, root: home, dataPath: home, logger: { warn() {}, info() {}, level: 1 } as never, resources: center };
      const sandbox = await createSandbox(resolveLayout(options), options);

      const id = url.slice("asset://".length);
      const viaRead = await store.readBytes("asset", "", id);
      const b64 = await sandbox.exec(`base64 /home/.ishiki/assets/${id}`);
      expect(b64.stdout.replace(/\s+/g, "")).toBe(Buffer.from(viaRead).toString("base64"));

      // stat 不触发 fetch：meta 未物化时 size 为 0，但路径存在
      const listed = await sandbox.exec("ls /home/.ishiki/artifacts/bash");
      expect(listed.stdout.trim()).toBe("demo.log");
      const viaBash = await sandbox.exec("cat /home/.ishiki/artifacts/bash/demo.log");
      expect(viaBash.stdout).toBe("hello from artifact");
      const root = await sandbox.exec("ls /home/.ishiki");
      expect(root.stdout.split(/\s+/).filter(Boolean).sort()).toEqual(["artifacts", "assets"]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
