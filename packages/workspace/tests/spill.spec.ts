import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { ResourceCenter, ResourceStore } from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

import { createSandbox, resolveLayout, WorkspaceConfig, type SandboxOptions } from "../src/index.js";

describe("truncation spill", () => {
  it("spills oversized bash output to an artifact and returns both references", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-spill-"));
    try {
      const center = new ResourceCenter("rt1", home);

      const spiller = {
        spill: async (tool: string, content: string) => {
          const url = await center.store.spillArtifact(tool, content);
          return { url, sandboxPath: `/home/.ishiki/artifacts/${url.slice("artifact://".length)}` };
        },
      };

      // 很小的上限，确保触发截断
      const config = WorkspaceConfig({ maxOutputLength: 50 });
      const options: SandboxOptions = {
        config,
        home,
        root: home,
        dataPath: home,
        logger: { warn() {}, info() {}, level: 1 } as never,
        resources: center,
        spiller,
      };
      const sandbox = await createSandbox(resolveLayout(options), options);
      const result = await sandbox.exec("yes hello | head -200");

      expect(result.stdout).toContain("已截断");
      expect(result.stdout).toMatch(/完整输出：artifact:\/\/bash-stdout\//);
      expect(result.stdout).toMatch(/在沙箱里访问 \/home\/\.ishiki\/artifacts\/bash-stdout\//);

      // 引用可解析，且内容与 bash 看到的沙箱路径一致
      const urlMatch = /artifact:\/\/bash-stdout\/\S+?\.log/.exec(result.stdout)!;
      const payload = await center.resolve(urlMatch[0]);
      expect(payload.content).toContain("hello");

      const name = urlMatch[0].slice("artifact://bash-stdout/".length);
      const viaSandbox = await fs.readFile(path.join(home, "resources", "artifacts", "bash-stdout", name), "utf8");
      expect(viaSandbox).toBe(payload.content);
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
      await store.putArtifact("bash", "demo.log", new TextEncoder().encode("hello from artifact"));

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
