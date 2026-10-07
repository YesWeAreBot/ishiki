import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import {
  AssetRegistry,
  ResourceCenter,
  ArtifactStore,
  AssetHandler,
  ArtifactHandler,
  LocalHandler,
  type AssetDatabase,
  type AssetRecord,
} from "koishi-plugin-ishiki";
import { describe, expect, it } from "vitest";

import { createSandbox, resolveLayout, WorkspaceConfig, type SandboxOptions } from "../src/index.js";

class MemoryAssetDb implements AssetDatabase {
  readonly rows = new Map<string, AssetRecord>();

  async get(runtimeId: string, id: string) {
    return this.rows.get(`${runtimeId}/${id}`);
  }

  async prefixSearch() {
    return [];
  }

  async listIds(runtimeId: string) {
    return [...this.rows.values()].filter((row) => row.runtimeId === runtimeId).map((row) => row.id);
  }

  async create(row: AssetRecord) {
    this.rows.set(`${row.runtimeId}/${row.id}`, row);
  }

  async markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }) {
    const row = this.rows.get(`${runtimeId}/${id}`);
    if (row) Object.assign(row, data, { fetchedAt: Date.now() });
  }
}

describe("truncation spill", () => {
  it("spills oversized bash output to an artifact and returns both references", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-spill-"));
    try {
      const center = new ResourceCenter("rt1", home);
      const store = new ArtifactStore(home);
      center.useCore(new AssetHandler(new AssetRegistry("rt1", home, new MemoryAssetDb())));
      center.useCore(new ArtifactHandler(store));
      center.useCore(new LocalHandler(center));
      center.useArtifactStore(store);

      const spiller = {
        spill: async (tool: string, content: string) => {
          const url = await center.artifactSpill(tool, content);
          return { url, sandboxPath: `/artifacts/${url.slice("artifact://".length)}` };
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
      expect(result.stdout).toMatch(/在沙箱里访问 \/artifacts\/bash-stdout\//);

      // 引用可解析，且内容与 bash 看到的沙箱路径一致
      const urlMatch = /artifact:\/\/bash-stdout\/\S+?\.log/.exec(result.stdout)!;
      const payload = await center.resolve(urlMatch[0]);
      expect(payload.content).toContain("hello");

      const name = urlMatch[0].slice("artifact://bash-stdout/".length);
      const viaSandbox = await (await import("node:fs/promises")).readFile(path.join(home, "resources", "artifacts", "bash-stdout", name), "utf8");
      expect(viaSandbox).toBe(payload.content);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
