import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import path from "node:path";

import { validate as validateUuid, version as uuidVersion, v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResourceCenter, ResourceError, RESERVED_SCHEMES } from "../src/resource/center.js";
import { ResourceStore } from "../src/resource/store.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
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
    const src = `data:image/png;base64,${PNG.toString("base64")}`;
    const url = await store.registerAsset(src, { mediaType: "image/*" });
    expect(await store.registerAsset(src)).toBe(url);
    const id = url.slice("asset://".length);
    expect(validateUuid(id)).toBe(true);
    expect(uuidVersion(id)).toBe(7);
    const resource = await center.resolve(url);
    if (resource.type !== "file") throw new Error("expected media");
    expect([...resource.bytes]).toEqual([...PNG]);
    expect(resource.mediaType).toBe("image/png");
    expect(resource.immutable).toBe(true);
    expect(await store.getMeta("asset", "", id)).toMatchObject({
      id,
      name: `${id}.png`,
      mediaType: "image/png",
      byteLength: PNG.byteLength,
    });
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
    const id = url.slice("asset://".length);
    expect((await store.getMeta("asset", "", id))?.fetchedAt).toBeUndefined();
    await expect(fs.access(path.join(home, "resources", "assets", `${id}.metadata.json`))).resolves.toBeUndefined();
  });

  it("reads materialized assets from disk after a runtime restart", async () => {
    const { store } = assemble();
    const id = uuidv7();
    const url = await store.putInHand("asset", "", id, PNG, { mediaType: "image/*" });
    const reloadedStore = new ResourceStore(home);
    const reloadedCenter = new ResourceCenter("rt2", home, reloadedStore);
    expect(await reloadedCenter.resolve(url)).toMatchObject({
      type: "file",
      mediaType: "image/png",
      bytes: PNG,
    });
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
    const id = uuidv7();
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

describe("automatic download policy", () => {
  it("uses HEAD before GET and permits a resource exactly at the configured limit", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(request.method ?? "");
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
        response.end(PNG);
      }
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const store = new ResourceStore(home, {
        autoDownloadMaxBytes: PNG.byteLength,
        cleanup: { enabled: false, retentionDays: 30, intervalMinutes: 60 },
      });
      const center = new ResourceCenter("rt1", home, store);
      const url = await store.registerAsset(`http://127.0.0.1:${address.port}/image.png`, { mediaType: "image/*" });
      const id = url.slice("asset://".length);
      expect(await store.autoDownload(id, "image/*")).toEqual({ status: "downloaded" });
      expect(calls).toEqual(["HEAD", "GET"]);
      expect(await store.getMeta("asset", "", id)).toMatchObject({
        id,
        name: `${id}.png`,
        mediaType: "image/png",
        byteLength: PNG.byteLength,
        autoDownload: { status: "downloaded" },
      });
      expect(Buffer.from(await fs.readFile(path.join(home, "resources", "assets", `${id}.png`))).equals(PNG)).toBe(true);
      expect(await center.resolve(url)).toMatchObject({ type: "file", mediaType: "image/png" });
    } finally {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });

  it("skips automatic download when HEAD is unsupported or type or length is unavailable", async () => {
    const gets: string[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "HEAD") gets.push(request.url ?? "");
      if (request.url === "/head-unsupported") response.writeHead(405).end();
      else if (request.url === "/missing-type") response.writeHead(200, { "content-length": PNG.byteLength }).end();
      else if (request.url === "/missing-length") response.writeHead(200, { "content-type": "image/png" }).end();
      else response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength }).end();
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const store = new ResourceStore(home);
      const origin = `http://127.0.0.1:${address.port}`;
      for (const route of ["/head-unsupported", "/missing-type", "/missing-length"]) {
        const url = await store.registerAsset(`${origin}${route}`, { mediaType: "image/*" });
        const id = url.slice("asset://".length);
        const decision = await store.autoDownload(id, "image/*");
        expect(decision.status).toBe("skipped");
        expect(decision.reason).toBeTruthy();
        expect((await store.getMeta("asset", "", id))?.fetchedAt).toBeUndefined();
      }
      expect(gets).toEqual([]);
    } finally {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });

  it("checks the downloaded byte count instead of trusting HEAD Content-Length", async () => {
    const bytes = Buffer.alloc(8, 1);
    const server = createServer((request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": 4 });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(bytes);
      }
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const store = new ResourceStore(home, {
        autoDownloadMaxBytes: 4,
        cleanup: { enabled: false, retentionDays: 30, intervalMinutes: 60 },
      });
      const url = await store.registerAsset(`http://127.0.0.1:${address.port}/actual-size.bin`);
      const id = url.slice("asset://".length);
      const decision = await store.autoDownload(id);
      expect(decision).toMatchObject({ status: "skipped", reason: expect.stringContaining("exceeds 4 bytes") });
      expect((await store.getMeta("asset", "", id))?.fetchedAt).toBeUndefined();
    } finally {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });

  it("keeps explicit read independent from the smaller automatic download ceiling", async () => {
    const server = createServer((request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
        response.end(PNG);
      }
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const store = new ResourceStore(home, {
        autoDownloadMaxBytes: PNG.byteLength - 1,
        cleanup: { enabled: false, retentionDays: 30, intervalMinutes: 60 },
      });
      const center = new ResourceCenter("rt1", home, store);
      const url = await store.registerAsset(`http://127.0.0.1:${address.port}/image.png`, { mediaType: "image/*" });
      const id = url.slice("asset://".length);
      expect((await store.autoDownload(id, "image/*")).status).toBe("skipped");
      expect(await center.resolve(url)).toMatchObject({ type: "file", mediaType: "image/png", size: PNG.byteLength });
      expect((await store.getMeta("asset", "", id))?.fetchedAt).toBeDefined();
    } finally {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });
});

describe("asset cleanup", () => {
  it("deletes expired asset and metadata pairs while leaving artifacts alone", async () => {
    const store = new ResourceStore(home, {
      autoDownloadMaxBytes: 20 * 1024 * 1024,
      cleanup: { enabled: false, retentionDays: 1, intervalMinutes: 60 },
    });
    const id = uuidv7();
    const url = await store.putInHand("asset", "", id, PNG, { mediaType: "image/*" });
    const artifact = await store.writeArtifact("keep", Buffer.from("keep"), { mediaType: "text/plain" });
    const meta = await store.getMeta("asset", "", id);
    if (meta === undefined) throw new Error("expected asset metadata");
    await fs.writeFile(
      path.join(home, "resources", "assets", `${id}.metadata.json`),
      JSON.stringify({ ...meta, createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
    );
    expect(await store.cleanupExpired()).toBe(1);
    await expect(fs.access(path.join(home, "resources", "assets", meta.name))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(home, "resources", "assets", `${id}.metadata.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.getMeta("asset", "", id)).toBeUndefined();
    expect(url).toMatch(/^asset:\/\//);
    expect(await centerResolveArtifact(store, artifact)).toBe("keep");
  });

  it("skips an asset with an active read and deletes it on the next pass", async () => {
    const responded = Promise.withResolvers<void>();
    const requestStarted = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      requestStarted.resolve();
      void responded.promise.then(() => {
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
        response.end(PNG);
      });
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a TCP address");
      const store = new ResourceStore(home, {
        autoDownloadMaxBytes: 20 * 1024 * 1024,
        cleanup: { enabled: false, retentionDays: 1, intervalMinutes: 60 },
      });
      const center = new ResourceCenter("rt1", home, store);
      const url = await store.registerAsset(`http://127.0.0.1:${address.port}/slow.png`, { mediaType: "image/*" });
      const id = url.slice("asset://".length);
      const reading = center.resolve(url);
      await requestStarted.promise;
      const meta = await store.getMeta("asset", "", id);
      if (meta === undefined) throw new Error("expected asset metadata");
      await fs.writeFile(
        path.join(home, "resources", "assets", `${id}.metadata.json`),
        JSON.stringify({ ...meta, createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
      );
      expect(await store.cleanupExpired()).toBe(0);
      responded.resolve();
      expect(await reading).toMatchObject({ type: "file", mediaType: "image/png" });
      expect(await store.cleanupExpired()).toBe(1);
      expect(await store.getMeta("asset", "", id)).toBeUndefined();
    } finally {
      responded.resolve();
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    }
  });

  it("registers one cleanup timer and clears it on stop", () => {
    const store = new ResourceStore(home, {
      autoDownloadMaxBytes: 20 * 1024 * 1024,
      cleanup: { enabled: true, retentionDays: 0, intervalMinutes: 1 },
    });
    const timer = (store as unknown as { cleanupTimer?: unknown }).cleanupTimer;
    expect(timer).toBeUndefined();
    store.startCleanup(() => undefined);
    const firstTimer = (store as unknown as { cleanupTimer?: unknown }).cleanupTimer;
    expect(firstTimer).toBeDefined();
    store.startCleanup(() => undefined);
    expect((store as unknown as { cleanupTimer?: unknown }).cleanupTimer).toBe(firstTimer);
    store.stopCleanup();
    expect((store as unknown as { cleanupTimer?: unknown }).cleanupTimer).toBeUndefined();
  });
});

async function centerResolveArtifact(store: ResourceStore, url: string): Promise<string> {
  const center = new ResourceCenter("artifact-check", store.home, store);
  const payload = await center.resolve(url);
  if (payload.type !== "text") throw new Error("expected text artifact");
  return payload.text;
}

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
    await expect(store.putInHand("asset", "../other", uuidv7(), new Uint8Array(), {})).rejects.toMatchObject({ code: "invalid_resource_uri" });
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

  it("reports unsupported views without fetching media bytes", async () => {
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
