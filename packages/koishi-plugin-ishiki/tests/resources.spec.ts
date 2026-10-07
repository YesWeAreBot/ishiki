import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/resources/artifact.js";
import type { AssetDatabase, AssetRecord } from "../src/resources/asset.js";
import { AssetRegistry } from "../src/resources/asset.js";
import { ResourceCenter, ResourceError, RESERVED_SCHEMES } from "../src/resources/center.js";
import { AssetHandler, ArtifactHandler, LocalHandler } from "../src/resources/handlers.js";

/** In-memory asset row store; production wires minato behind the same shape. */
class MemoryAssetDb implements AssetDatabase {
  readonly rows = new Map<string, AssetRecord>();

  async get(runtimeId: string, id: string) {
    return this.rows.get(`${runtimeId}/${id}`);
  }

  async prefixSearch(runtimeId: string, prefix: string) {
    return [...this.rows.values()].filter((row) => row.runtimeId === runtimeId && row.id.startsWith(prefix));
  }

  async create(row: AssetRecord) {
    this.rows.set(`${row.runtimeId}/${row.id}`, row);
  }

  async markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }) {
    const row = this.rows.get(`${runtimeId}/${id}`);
    if (row) Object.assign(row, data, { fetchedAt: Date.now() });
  }
}

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-res-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function assemble(db: MemoryAssetDb) {
  const center = new ResourceCenter("rt1", home);
  const assets = new AssetRegistry("rt1", home, db);
  const artifacts = new ArtifactStore(home);
  center.useCore(new AssetHandler(assets));
  center.useCore(new ArtifactHandler(artifacts));
  center.useCore(new LocalHandler(center));
  return { center, assets, artifacts };
}

describe("AssetRegistry.deriveId", () => {
  it("derives a stable 32-hex id from the source URL", () => {
    const id = AssetRegistry.deriveId("https://example.com/a.png");
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(AssetRegistry.deriveId("https://example.com/a.png")).toBe(id);
    expect(AssetRegistry.deriveId("https://example.com/b.png")).not.toBe(id);
  });
});

describe("AssetRegistry.register", () => {
  it("is idempotent per (runtime, src)", async () => {
    const { assets } = assemble(new MemoryAssetDb());
    const first = await assets.register("https://example.com/a.png", { mediaType: "image/png" });
    const second = await assets.register("https://example.com/a.png");
    expect(second).toBe(first);
  });

  it("keeps rows scoped by runtime id", async () => {
    const db = new MemoryAssetDb();
    const { assets } = assemble(db);
    await assets.register("https://example.com/a.png");
    const other = new AssetRegistry("rt2", home, db);
    const url = await other.register("https://example.com/a.png");
    expect(url).toBe(`asset://${AssetRegistry.deriveId("https://example.com/a.png")}`);
    expect(db.rows.size).toBe(2);
  });
});

describe("AssetRegistry.readBytes", () => {
  it("decodes data: URLs once, caches on disk, and records content hash", async () => {
    const db = new MemoryAssetDb();
    const { assets } = assemble(db);
    const url = await assets.register("data:image/png;base64,iVBORw0KGgo=");
    const id = AssetRegistry.deriveId("data:image/png;base64,iVBORw0KGgo=");
    const bytes = await assets.readBytes(url);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const again = await assets.readBytes(id);
    expect(again).toBe(bytes);
    const row = db.rows.get(`rt1/${id}`)!;
    expect(row.byteLength).toBe(bytes.byteLength);
    expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(path.join(home, "resources", "assets", id))).resolves.toBeUndefined();
  });

  it("shares one fetch across concurrent readers (single-flight)", async () => {
    const db = new MemoryAssetDb();
    const { assets } = assemble(db);
    const src = "data:text/plain,hello";
    const url = await assets.register(src);
    const [a, b] = await Promise.all([assets.readBytes(url), assets.readBytes(url)]);
    expect(a).toBe(b);
  });

  it("rejects unknown ids with resource_not_found", async () => {
    const { assets } = assemble(new MemoryAssetDb());
    await expect(assets.readBytes("a".repeat(32))).rejects.toMatchObject({ code: "resource_not_found" });
  });
});

describe("ResourceCenter scheme registry", () => {
  it("rejects reserved scheme registration", () => {
    const { center } = assemble(new MemoryAssetDb());
    for (const scheme of RESERVED_SCHEMES) {
      expect(() => center.use({ scheme, spec: { backing: "file", immutable: true, scope: "runtime" }, resolve: () => ({ url: "", size: 0 }) })).toThrow(
        /reserved/,
      );
    }
  });

  it("rejects duplicate registration and reports unknown schemes with the available list", async () => {
    const { center } = assemble(new MemoryAssetDb());
    expect(() => center.use(new AssetHandler(new AssetRegistry("rt1", home, new MemoryAssetDb())))).toThrow(/reserved/);
    const err = await center.resolve("mystery://x").catch((error) => error);
    expect(err).toBeInstanceOf(ResourceError);
    expect(err.code).toBe("resource_unavailable");
    expect(err.message).toContain("asset://, artifact://, local://");
  });

  it("removes handlers on demand", () => {
    const { center } = assemble(new MemoryAssetDb());
    expect(center.remove("asset")).toBe(true);
    expect(center.remove("asset")).toBe(false);
  });
});

describe("ResourceCenter.parse", () => {
  it("parses scheme, authority, and path segments", () => {
    const url = ResourceCenter.parse("artifact://bash/018f/output.log");
    expect(url.scheme).toBe("artifact");
    expect(url.authority).toBe("bash");
    expect(url.segments).toEqual(["018f", "output.log"]);
  });

  it("rejects traversal, backslashes, and non-URLs", () => {
    for (const bad of ["asset://../etc/passwd", "local://a/../../etc", "local://a/..\\b", "not-a-url"]) {
      expect(() => ResourceCenter.parse(bad)).toThrow(ResourceError);
    }
  });
});

describe("ResourceCenter.locate", () => {
  it("locates assets, artifacts, and local paths inside home", () => {
    const { center } = assemble(new MemoryAssetDb());
    const id = "a".repeat(32);
    expect(center.locate(`asset://${id}`)).toBe(path.join(home, "resources", "assets", id));
    expect(center.locate("artifact://bash/abc.log")).toBe(path.join(home, "resources", "artifacts", "bash", "abc.log"));
    expect(center.locate("local://workspace/notes.md")).toBe(path.join(home, "workspace", "notes.md"));
  });

  it("refuses short asset ids and home escapes", () => {
    const { center } = assemble(new MemoryAssetDb());
    expect(() => center.locate("asset://abc123")).toThrow(/full 32-hex/);
    expect(() => center.locate("local://../outside")).toThrow(/escapes|invalid/);
  });
});

describe("ArtifactStore", () => {
  it("round-trips bytes and metadata", async () => {
    const { artifacts } = assemble(new MemoryAssetDb());
    const url = await artifacts.put("bash", "018f3a.log", new TextEncoder().encode("line1\nline2\n"), { mediaType: "text/plain" });
    expect(url).toBe("artifact://bash/018f3a.log");
    const bytes = await artifacts.read("bash", "018f3a.log");
    expect(new TextDecoder().decode(bytes)).toBe("line1\nline2\n");
    const info = await artifacts.info("bash", "018f3a.log");
    expect(info?.meta.byteLength).toBe(12);
    expect(info?.meta.createdAt).toBeTypeOf("number");
  });

  it("lists artifact names sorted and clears a namespace", async () => {
    const { artifacts } = assemble(new MemoryAssetDb());
    await artifacts.put("bash", "b.log", new Uint8Array([1]));
    await artifacts.put("bash", "a.log", new Uint8Array([2]));
    expect(await artifacts.list("bash")).toEqual(["a.log", "b.log"]);
    await artifacts.clearTool("bash");
    expect(await artifacts.list("bash")).toEqual([]);
    await expect(artifacts.read("bash", "a.log")).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("rejects unsafe tool namespaces and names", async () => {
    const { artifacts } = assemble(new MemoryAssetDb());
    await expect(artifacts.put("../evil", "x", new Uint8Array())).rejects.toMatchObject({ code: "invalid_resource_uri" });
    await expect(artifacts.put("bash", ".hidden", new Uint8Array())).rejects.toMatchObject({ code: "invalid_resource_uri" });
  });
});

describe("handlers", () => {
  it("asset resolve returns a metadata card, not bytes", async () => {
    const db = new MemoryAssetDb();
    const { center, assets } = assemble(db);
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const url = await assets.register(src, { mediaType: "image/png" });
    await assets.readBytes(url);
    const payload = await center.resolve(url);
    expect(payload.content).toContain("image/png");
    expect(payload.bytes).toBeUndefined();
    await expect(center.resolve(`asset://${"f".repeat(32)}`)).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("artifact resolve inlines utf-8 text and flags binaries", async () => {
    const { center, artifacts } = assemble(new MemoryAssetDb());
    await artifacts.put("bash", "x.log", new TextEncoder().encode("hello"));
    const payload = await center.resolve("artifact://bash/x.log");
    expect(payload.content).toBe("hello");
    await artifacts.put("bash", "pic.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const binary = await center.resolve("artifact://bash/pic.bin");
    expect(binary.mediaType).toBe("image/png");
    expect(binary.bytes?.[0]).toBe(0x89);
  });

  it("local resolve reads text, lists directories, and refuses missing files", async () => {
    const { center } = assemble(new MemoryAssetDb());
    await fs.mkdir(path.join(home, "notes"));
    await fs.writeFile(path.join(home, "notes", "a.md"), "# hi");
    const text = await center.resolve("local://notes/a.md");
    expect(text.content).toBe("# hi");
    const listing = await center.resolve("local://notes");
    expect(listing.content).toBe("a.md");
    await expect(center.resolve("local://notes/missing.md")).rejects.toMatchObject({ code: "resource_not_found" });
  });
});
