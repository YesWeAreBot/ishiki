import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResourceCenter, ResourceError, RESERVED_SCHEMES } from "../src/resource/center.js";
import { ResourceStore } from "../src/resource/store.js";

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

describe("resource registration and isolation", () => {
  it("registers an asset idempotently and materializes its actual bytes", async () => {
    const { store, center } = assemble();
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const url = await store.registerAsset(src, { mediaType: "image/*" });
    expect(await store.registerAsset(src)).toBe(url);
    const resource = await center.resolve(url);
    if (resource.type !== "file") throw new Error("expected media");
    expect([...resource.bytes]).toEqual([...Buffer.from("iVBORw0KGgo=", "base64")]);
    expect(resource.mediaType).toBe("image/png");
    expect(resource.immutable).toBe(true);
    expect((await store.getMeta("asset", "", url.slice(8)))?.byteLength).toBe(8);
  });

  it("reads metadata without downloading and keeps platform source attributes", async () => {
    const { store, center } = assemble();
    const sourceInfo = { fileSize: "169667", subtype: 0 };
    const url = await store.registerAsset("https://example.com/private.png?token=secret", { mediaType: "image/*", filename: "screen.png", sourceInfo });
    const view = await center.resolve(`${url}?view=meta`);
    if (view.type !== "text") throw new Error("expected metadata text");
    const metadata = JSON.parse(view.text);
    expect(metadata).toMatchObject({ filename: "screen.png", sourceInfo, fetched: false });
    expect(metadata.src).toBeUndefined();
    expect((await store.getMeta("asset", "", url.slice(8)))?.fetchedAt).toBeUndefined();
    await expect(fs.access(path.join(home, "resources", "assets", url.slice(8)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["report.pdf", "", "https://[invalid", "ftp://files.example/report.pdf?rkey=private-file-token"])(
    "links an unavailable source to its readable metadata: %s",
    async (src) => {
      const { store, center } = assemble();
      const sourceInfo = { fileId: "30d11e4df95b09df4de35ea1c783c368", fileSize: "406216" };
      const url = await store.registerAsset(src, { filename: "report.pdf", sourceInfo });
      const failure = center.resolve(url);
      await expect(failure).rejects.toMatchObject({
        code: "resource_unavailable",
        message: expect.stringContaining(`${url}?view=meta`),
      });
      await expect(failure).rejects.toHaveProperty("message", expect.not.stringContaining("private-file-token"));
      const view = await center.resolve(`${url}?view=meta`);
      if (view.type !== "text") throw new Error("expected metadata text");
      expect(JSON.parse(view.text)).toMatchObject({ sourceInfo, fetched: false });
    },
  );

  it("downloads signed sources and keeps their URLs out of HTTP and size errors", async () => {
    const { store, center } = assemble();
    const limit = 20 * 1024 * 1024;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/denied")) response.writeHead(403).end();
      else if (request.url?.startsWith("/oversized")) response.writeHead(200, { "content-length": limit + 1 }).end();
      else if (request.url?.startsWith("/streamed")) response.writeHead(200).end(Buffer.alloc(limit + 1));
      else response.writeHead(200, { "content-type": "text/plain" }).end("downloaded report");
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const origin = `http://127.0.0.1:${address.port}`;
      const src = `${origin}/report?rkey=private-file-token`;
      const url = await store.registerAsset(src);
      expect(await center.resolve(url)).toMatchObject({ type: "text", text: "downloaded report" });
      for (const [route, code, detail] of [
        ["denied", "resource_read_failed", "403"],
        ["oversized", "resource_too_large", String(limit)],
        ["streamed", "resource_too_large", String(limit)],
      ] as const) {
        const target = await store.registerAsset(`${origin}/${route}?rkey=private-file-token`);
        const failure = center.resolve(target);
        await expect(failure).rejects.toMatchObject({ code, message: expect.stringContaining(detail) });
        await expect(failure).rejects.toHaveProperty("message", expect.not.stringContaining("private-file-token"));
        await expect(failure).rejects.toHaveProperty("message", expect.not.stringContaining(origin));
      }
    } finally {
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });

  it("passes full URLs unchanged to their registered handler", async () => {
    const { center } = assemble();
    const input = "ExAmPlE://server/urn:document?format=xml#section:50";
    let received: string | undefined;
    const dispose = center.attach({
      scheme: "Example",
      resolve: (url) => {
        received = url;
        return { type: "text", url, text: "resolved", size: 8 };
      },
    });
    expect(await center.resolve(input)).toMatchObject({ type: "text", text: "resolved" });
    expect(received).toBe(input);
    dispose();
    await expect(center.resolve(input)).rejects.toMatchObject({ code: "resource_unavailable" });
  });

  it("rejects conflicting handlers and malformed routing prefixes", async () => {
    const { center } = assemble();
    const handler = { scheme: "custom", resolve: (url: string) => ({ type: "text" as const, url, text: "value", size: 5 }) };
    center.attach(handler);
    expect(() => center.attach(handler)).toThrow(Error);
    for (const scheme of RESERVED_SCHEMES) expect(() => center.attach({ ...handler, scheme })).toThrow(Error);
    await expect(center.resolve("not-a-url")).rejects.toBeInstanceOf(ResourceError);
    await expect(center.resolve("missing://resource")).rejects.toMatchObject({ code: "resource_unavailable" });
  });

  it("keeps identical URLs scoped to separate runtime stores", async () => {
    const { store, center } = assemble();
    const secondStore = new ResourceStore(path.join(home, "second"));
    const second = new ResourceCenter("rt2", secondStore.home, secondStore);
    const id = ResourceStore.deriveId("https://example.com/image.png");
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const secondBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 2]);
    const url = await store.putInHand("asset", "", id, firstBytes, { mediaType: "image/png" });
    await secondStore.putInHand("asset", "", id, secondBytes, { mediaType: "image/png" });
    const firstResource = await center.resolve(url);
    const secondResource = await second.resolve(url);
    if (firstResource.type !== "file" || secondResource.type !== "file") throw new Error("expected media");
    expect(firstResource.bytes).toEqual(firstBytes);
    expect(secondResource.bytes).toEqual(secondBytes);
    center.attach({ scheme: "private", resolve: (value) => ({ type: "text", url: value, text: "private", size: 7 }) });
    await expect(second.resolve("private://value")).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});

describe("stored snapshots and file schemes", () => {
  it("round-trips text and binary artifacts with their media metadata", async () => {
    const { store, center } = assemble();
    const text = "line1\nline2\n";
    const url = await store.writeArtifact("tool", Buffer.from(text), { mediaType: "text/plain" });
    expect(await center.resolve(url)).toMatchObject({ type: "text", text });
    expect(await store.writeArtifact("tool", Buffer.from(text), { mediaType: "text/plain" })).toBe(url);
    const bytes = Buffer.from([0, 1, 2, 3]);
    const binary = await store.writeArtifact("tool", bytes, { mediaType: "application/octet-stream", filename: "data.bin" });
    expect(await center.resolve(binary)).toMatchObject({ type: "file", bytes, mediaType: "application/octet-stream", filename: "data.bin", immutable: true });
  });

  it("rejects resource storage keys that can escape their runtime directory", async () => {
    const { store } = assemble();
    for (const namespace of [".", "..", "../other"]) {
      await expect(store.putInHand("artifact", namespace, "file.bin", new Uint8Array(), {})).rejects.toMatchObject({ code: "invalid_resource_uri" });
      await expect(store.names("artifact", namespace)).rejects.toMatchObject({ code: "invalid_resource_uri" });
    }
    await expect(store.putInHand("asset", "../other", "a".repeat(32), new Uint8Array(), {})).rejects.toMatchObject({ code: "invalid_resource_uri" });
    await expect(store.getMeta("artifact", "tool", "../other")).rejects.toMatchObject({ code: "invalid_resource_uri" });
  });

  it("reads host text and directories while rejecting encoded path escapes", async () => {
    const { center } = assemble();
    await fs.mkdir(path.join(home, "notes"));
    await fs.writeFile(path.join(home, "notes", "a.md"), "# hello");
    expect(await center.resolve("local://notes/a.md")).toMatchObject({ type: "text", text: "# hello" });
    expect(await center.resolve("local://notes")).toMatchObject({ type: "text", text: "a.md" });
    await expect(center.resolve("local://notes/missing.md")).rejects.toMatchObject({ code: "resource_not_found" });
    for (const url of ["local://../outside", "local://notes/%2e%2e/outside", "local://notes/a%2fb", "local://notes/a%5cb"])
      await expect(center.resolve(url)).rejects.toMatchObject({ code: "invalid_resource_uri" });
  });

  it("does not follow a host symlink outside the runtime root", async () => {
    const { center } = assemble();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-outside-"));
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "outside");
      await fs.symlink(outside, path.join(home, "link"), process.platform === "win32" ? "junction" : "dir");
      await expect(center.resolve("local://link/secret.txt")).rejects.toMatchObject({ code: "invalid_resource_uri" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("reports unsupported views without fetching lazy media", async () => {
    const { store, center } = assemble();
    const url = await store.registerAsset("https://example.com/not-fetched.png", { mediaType: "image/png" });
    await expect(center.resolve(`${url}?view=thumb`)).rejects.toMatchObject({ code: "unsupported_view" });
    expect((await store.getMeta("asset", "", url.slice(8)))?.fetchedAt).toBeUndefined();
  });

  it("evicts the least recently used bytes and falls back to disk", async () => {
    const { store, center } = assemble();
    // Three 12 MiB artifacts overflow the 32 MiB in-process ceiling, so the
    // first write is already evicted by the time the third lands.
    const size = 12 * 1024 * 1024;
    const urls: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const bytes = new Uint8Array(size);
      bytes[size - 1] = index;
      urls.push(await store.writeArtifact("cache", bytes, { mediaType: "image/png" }));
    }
    // The store's private cache is the only place a miss-then-hit transition is
    // observable, and this test exists to pin eviction rather than content.
    const cache = (store as unknown as { memory: Map<string, Uint8Array> }).memory;
    const firstKey = urls[0]!.replace("artifact://", "artifacts/");
    expect(cache.size).toBe(2);
    expect(cache.has(firstKey)).toBe(false);

    // A miss reads the evicted bytes back from disk and evicts the oldest resident.
    expect(await center.resolve(urls[0]!)).toMatchObject({ type: "file", size });
    expect(cache.has(firstKey)).toBe(true);
    expect(cache.size).toBe(2);
  }, 30000);
});
