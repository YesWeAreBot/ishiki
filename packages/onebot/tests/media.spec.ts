import Server from "@koishijs/plugin-server";
import { App } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaPublisher } from "../src/media.js";

let app: App;
let base: string;

beforeEach(async () => {
  app = new App();
  app.plugin(Server, { host: "127.0.0.1", port: 51410, maxPort: 51500 });
  await app.start();
  base = app.get("server").selfUrl;
});

afterEach(async () => {
  await app.stop();
});

describe("media publisher", () => {
  it("serves published bytes through the Koishi route", async () => {
    const publisher = new MediaPublisher();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const url = publisher.publish(app, bytes, "image/png");
    expect(url.startsWith(base)).toBe(true);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);
  });

  it("answers 404 for unknown ids", async () => {
    const publisher = new MediaPublisher();
    publisher.publish(app, Buffer.from("x"), "text/plain");
    const response = await fetch(`${base}/ishiki-onebot/${publisher.token}/resources/missing`);
    expect(response.status).toBe(404);
  });

  it("keeps the configured base url in front of the route path", () => {
    const publisher = new MediaPublisher();
    const url = publisher.publish(app, Buffer.from("x"), "text/plain", "http://example.test:9000/");
    expect(url.startsWith("http://example.test:9000/ishiki-onebot/")).toBe(true);
  });

  it("isolates two profiles by token", async () => {
    const first = new MediaPublisher();
    const second = new MediaPublisher();
    const url = first.publish(app, Buffer.from("first"), "text/plain");
    const response = await fetch(`${base}/ishiki-onebot/${second.token}/resources/${url.split("/").pop()}`);
    expect(response.status).toBe(404);
    expect(await (await fetch(url)).text()).toBe("first");
  });

  it("expires entries after their ttl", async () => {
    const publisher = new MediaPublisher();
    const url = publisher.publish(app, Buffer.from("x"), "text/plain");
    const id = url.split("/").pop()!;
    const entries = (publisher as unknown as { entries: Map<string, { expiresAt: number }> }).entries;
    entries.get(id)!.expiresAt = Date.now() - 1;
    const response = await fetch(url);
    expect(response.status).toBe(404);
  });
});
