import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResourceCenter, ResourceError, RESERVED_SCHEMES } from "../src/resources/center.js";
import { ResourceStore } from "../src/resources/store.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-res-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function assemble() {
  const store = new ResourceStore(home);
  return { store, center: new ResourceCenter("rt1", home, store) };
}

describe("ResourceStore.deriveId", () => {
  it("derives a stable 32-hex id from the source URL", () => {
    const id = ResourceStore.deriveId("https://example.com/a.png");
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(ResourceStore.deriveId("https://example.com/a.png")).toBe(id);
    expect(ResourceStore.deriveId("https://example.com/b.png")).not.toBe(id);
  });
});

describe("ResourceStore.registerAsset", () => {
  it("is idempotent per (runtime, src)", async () => {
    const { store } = assemble();
    const first = await store.registerAsset("https://example.com/a.png", { mediaType: "image/png" });
    const second = await store.registerAsset("https://example.com/a.png");
    expect(second).toBe(first);
  });

  it("exposes the asset through resolve with bytes materialized", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const payload = await center.resolve(url);
    expect(payload.bytes?.[0]).toBe(0x89);
    expect(payload.mediaType).toBe("image/png");
  });

  it("records inbound sourceInfo verbatim and surfaces it in the meta view", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("https://example.com/photo.jpg", {
      mediaType: "image/*",
      filename: "1D62BD1F.jpg",
      sourceInfo: { summary: "", file: "1D62BD1F.jpg", subType: 0, fileSize: "169667" },
    });
    const view = await center.resolve(`${url}?view=meta`);
    expect(view.content).toContain("fileSize");
    expect(view.content).toContain("1D62BD1F.jpg");
    const meta = await store.getMeta("asset", "", url.slice("asset://".length));
    expect(meta?.sourceInfo).toEqual({ summary: "", file: "1D62BD1F.jpg", subType: 0, fileSize: "169667" });
  });

  it("meta view loads no bytes", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("https://example.com/never-fetched.png", { mediaType: "image/png" });
    const view = await center.resolve(`${url}?view=meta`);
    expect(view.notes).toContain("metadata only; no bytes were loaded");
    const meta = await store.getMeta("asset", "", url.slice("asset://".length));
    expect(meta?.fetchedAt).toBeUndefined();
  });
});

describe("ResourceStore.readBytes", () => {
  it("decodes data: URLs once, caches on disk, and records content hash", async () => {
    const { store } = assemble();
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    const id = url.slice("asset://".length);
    const bytes = await store.readBytes("asset", "", id);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const again = await store.readBytes("asset", "", id);
    expect(again).toBe(bytes);
    const meta = await store.getMeta("asset", "", id);
    expect(meta?.byteLength).toBe(bytes.byteLength);
    expect(meta?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(path.join(home, "resources", "assets", id))).resolves.toBeUndefined();
  });

  it("shares one fetch across concurrent readers (single-flight)", async () => {
    const { store } = assemble();
    const url = await store.registerAsset("data:text/plain,hello");
    const id = url.slice("asset://".length);
    const [a, b] = await Promise.all([store.readBytes("asset", "", id), store.readBytes("asset", "", id)]);
    expect(a).toBe(b);
  });

  it("rejects unknown ids with resource_not_found", async () => {
    const { store } = assemble();
    await expect(store.readBytes("asset", "", "a".repeat(32))).rejects.toMatchObject({ code: "resource_not_found" });
  });
});

describe("ResourceCenter scheme registry", () => {
  it("readies the three core schemes at construction", () => {
    const { center } = assemble();
    expect(center.listSchemes()).toEqual(["asset", "artifact", "local"]);
  });

  it("rejects reserved scheme registration", () => {
    const { center } = assemble();
    for (const scheme of RESERVED_SCHEMES) {
      expect(() => center.attach({ scheme, resolve: () => ({ url: "", size: 0 }) })).toThrow(/reserved/);
    }
  });

  it("rejects duplicate registration and reports unknown schemes with the available list", async () => {
    const { center } = assemble();
    const handler = { scheme: "custom", resolve: () => ({ url: "", size: 0 }) };
    center.attach(handler);
    expect(() => center.attach(handler)).toThrow(/already registered/);
    const error = await center.resolve("mystery://x").catch((error) => error);
    expect(error).toBeInstanceOf(ResourceError);
    expect(error.code).toBe("resource_unavailable");
    expect(error.message).toContain("asset://, artifact://, local://, custom://");
  });

  it("deregisters via the returned disposer", () => {
    const { center } = assemble();
    const dispose = center.attach({ scheme: "custom", resolve: () => ({ url: "", size: 0 }) });
    dispose();
    expect(center.listSchemes()).toEqual(["asset", "artifact", "local"]);
  });
});

describe("ResourceCenter.parse", () => {
  it("parses scheme, authority, path segments, and view", () => {
    const url = ResourceCenter.parse("artifact://bash/018f/output.log");
    expect(url.scheme).toBe("artifact");
    expect(url.authority).toBe("bash");
    expect(url.segments).toEqual(["018f", "output.log"]);
    expect(ResourceCenter.parse("asset://abc?view=meta").view).toBe("meta");
  });

  it("rejects traversal, backslashes, and non-URLs", () => {
    for (const bad of ["asset://../etc/passwd", "local://a/../../etc", "local://a/..\\b", "not-a-url"]) {
      expect(() => ResourceCenter.parse(bad)).toThrow(ResourceError);
    }
  });

  it("keeps opaque tails verbatim and refuses unknown queries on structured schemes", async () => {
    const { center } = assemble();
    const opaque = ResourceCenter.parse("mcp://server/urn:example:doc?a=b");
    expect(opaque.rawTail).toBe("/urn:example:doc?a=b");
    await expect(center.resolve("asset://" + "a".repeat(32) + "?format=json")).rejects.toMatchObject({ code: "invalid_resource_uri" });
  });
});

describe("ResourceCenter.locate", () => {
  it("delegates to the handler's own locate", () => {
    const { center } = assemble();
    const id = "a".repeat(32);
    expect(center.locate(`asset://${id}`)).toBe(path.join(home, "resources", "assets", id));
    expect(center.locate("artifact://bash/abc.log")).toBe(path.join(home, "resources", "artifacts", "bash", "abc.log"));
    expect(center.locate("local://workspace/notes.md")).toBe(path.join(home, "workspace", "notes.md"));
  });

  it("refuses short asset ids and home escapes", () => {
    const { center } = assemble();
    expect(() => center.locate("asset://abc123")).toThrow(/full 32-hex/);
    expect(() => center.locate("local://../outside")).toThrow(/escapes|invalid/);
  });
});

describe("ResourceStore artifacts", () => {
  it("round-trips bytes and metadata", async () => {
    const { store } = assemble();
    const url = await store.putInHand("artifact", "bash", "018f3a.log", new TextEncoder().encode("line1\nline2\n"), { mediaType: "text/plain" });
    expect(url).toBe("artifact://bash/018f3a.log");
    const bytes = await store.readBytes("artifact", "bash", "018f3a.log");
    expect(new TextDecoder().decode(bytes)).toBe("line1\nline2\n");
    const meta = await store.getMeta("artifact", "bash", "018f3a.log");
    expect(meta?.byteLength).toBe(12);
    expect(meta?.createdAt).toBeTypeOf("number");
  });

  it("lists artifact names sorted and tool namespaces", async () => {
    const { store } = assemble();
    await store.putInHand("artifact", "bash", "b.log", new Uint8Array([1]), {});
    await store.putInHand("artifact", "bash", "a.log", new Uint8Array([2]), {});
    await store.putInHand("artifact", "other", "x.log", new Uint8Array([3]), {});
    expect(await store.names("artifact", "bash")).toEqual(["a.log", "b.log"]);
    expect(await store.namespaces("artifact")).toEqual(["bash", "other"]);
  });

  it("rejects unsafe namespaces and names", async () => {
    const { store } = assemble();
    await expect(store.putInHand("artifact", "../evil", "x", new Uint8Array(), {})).rejects.toMatchObject({ code: "invalid_resource_uri" });
    await expect(store.putInHand("artifact", "bash", ".hidden", new Uint8Array(), {})).rejects.toMatchObject({ code: "invalid_resource_uri" });
  });

  it("spills truncated output as a text artifact", async () => {
    const { store, center } = assemble();
    const url = await store.writeArtifact("bash-stdout", Buffer.from("line\n".repeat(1000)), { mediaType: "text/plain" });
    expect(url).toMatch(/^artifact:\/\/bash-stdout\/.*\.blob$/);
    const payload = await center.resolve(url);
    expect(payload.content?.split("\n").length).toBe(1001);
  });
});

describe("handlers", () => {
  it("asset resolve returns bytes; meta view returns a summary", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=", { mediaType: "image/png" });
    const payload = await center.resolve(url);
    expect(payload.bytes).toBeDefined();
    const view = await center.resolve(`${url}?view=meta`);
    expect(view.content).toContain("image/png");
    expect(view.bytes).toBeUndefined();
    await expect(center.resolve(`asset://${"f".repeat(32)}`)).rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("reports unsupported views", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("data:image/png;base64,iVBORw0KGgo=");
    await expect(center.resolve(`${url}?view=thumb`)).rejects.toMatchObject({ code: "unsupported_view" });
  });

  it("artifact resolve inlines utf-8 text and flags binaries", async () => {
    const { store, center } = assemble();
    await store.putInHand("artifact", "bash", "x.log", new TextEncoder().encode("hello"), {});
    const payload = await center.resolve("artifact://bash/x.log");
    expect(payload.content).toBe("hello");
    await store.putInHand("artifact", "bash", "pic.bin", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), {});
    const binary = await center.resolve("artifact://bash/pic.bin");
    expect(binary.mediaType).toBe("image/png");
    expect(binary.bytes?.[0]).toBe(0x89);
  });

  it("local resolve reads text, lists directories, and refuses missing files", async () => {
    const { center } = assemble();
    await fs.mkdir(path.join(home, "notes"));
    await fs.writeFile(path.join(home, "notes", "a.md"), "# hi");
    const text = await center.resolve("local://notes/a.md");
    expect(text.content).toBe("# hi");
    const listing = await center.resolve("local://notes");
    expect(listing.content).toBe("a.md");
    await expect(center.resolve("local://notes/missing.md")).rejects.toMatchObject({ code: "resource_not_found" });
  });
});
