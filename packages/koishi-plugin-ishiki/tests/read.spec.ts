import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import path from "node:path";

import { asSchema } from "@yesimagent/core";
import { createGateway } from "@yesimagent/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReadTool, type ReadTool } from "../src/builtin-tools/read.js";
import { createVisionModel } from "../src/index.js";
import { ResourceCenter } from "../src/resource/center.js";
import { processOutput } from "../src/resource/output.js";
import { ResourceStore } from "../src/resource/store.js";
import { TEXT_BUDGET } from "../src/resource/text.js";

let home: string;
let center: ResourceCenter;
let store: ResourceStore;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-read-"));
  store = new ResourceStore(home);
  center = new ResourceCenter("rt1", home, store);
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function read(url: string): Promise<ReadTool.Output> {
  return (await createReadTool({ center }).execute!({ url }, { toolCallId: "read-1", messages: [] })) as ReadTool.Output;
}

async function visibleRead(url: string) {
  const tool = createReadTool({ center });
  const raw = (await tool.execute!({ url }, { toolCallId: "read-1", messages: [] })) as ReadTool.Output;
  const converted = await tool.toModelOutput!({ toolCallId: "read-1", input: { url }, output: raw });
  const { output } = await processOutput(center, "read", converted, raw);
  if (raw.type !== "text" || output.type !== "text") throw new Error("expected a text read page");
  expect(output.value.length).toBeLessThanOrEqual(TEXT_BUDGET.maxChars);
  expect(output.value.split("\n").length).toBeLessThanOrEqual(TEXT_BUDGET.maxLines);
  const call = /read\((\{"url":.*\})\)$/.exec(output.value);
  let next: string | undefined;
  if (call !== null) {
    const decoded: unknown = JSON.parse(call[1]!);
    if (decoded === null || typeof decoded !== "object" || !("url" in decoded) || typeof decoded.url !== "string") throw new Error("invalid continuation call");
    next = decoded.url;
  }
  return { raw, shown: output.value, next };
}

async function reconstruct(url: string): Promise<string> {
  const pieces: string[] = [];
  let current: string | undefined = url;
  let previousOffset = -1;
  while (current !== undefined) {
    const page = await visibleRead(current);
    const offset = page.raw.source?.offset ?? 0;
    const nextOffset = page.next === undefined ? offset + page.raw.text.length : Number(new URL(page.next).searchParams.get("offset"));
    expect(nextOffset).toBeGreaterThanOrEqual(offset);
    expect(nextOffset).toBeGreaterThan(previousOffset);
    const body = page.raw.text.slice(0, nextOffset - offset);
    expect(page.shown.startsWith(body)).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
    pieces.push(body);
    previousOffset = nextOffset;
    current = page.next;
  }
  return pieces.join("");
}

describe("structured resource reads", () => {
  it("returns the complete selected text and composes ranges without widening them", async () => {
    const url = await store.writeArtifact("seed", Buffer.from("alpha\nbeta\ngamma\ndelta\n"), { mediaType: "text/plain" });
    expect(await read(`${url}:2-3`)).toMatchObject({ type: "text", text: "beta\ngamma\n" });
    expect(await read(`${url}:2-3:2-2`)).toMatchObject({ type: "text", text: "gamma\n" });
    expect(await read(`${url}:2-3:1-100`)).toMatchObject({ type: "text", text: "beta\ngamma\n" });
  });

  it("keeps raw text larger than the old read limit available to code", async () => {
    const text = "x".repeat(9 * 1024 * 1024);
    await fs.writeFile(path.join(home, "large.txt"), text);
    const result = await read("local://large.txt");
    if (result.type !== "text") throw new Error("expected raw text");
    expect(result.text).toBe(text);
    expect(JSON.parse(JSON.stringify(result)).source).toEqual(result.source);
  });

  it("returns JSON-safe media data and the original immutable reference", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    const url = await store.writeArtifact("image", bytes, { mediaType: "image/png", filename: "screen.png" });
    const result = await read(url);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      type: "file",
      url,
      data: bytes.toString("base64"),
      mediaType: "image/png",
      byteLength: bytes.length,
      filename: "screen.png",
      immutable: true,
    });
  });

  it("reconstructs a long Unicode line without skips or duplicate artifacts", async () => {
    const text = "猫😀".repeat(28000);
    const url = await store.writeArtifact("seed", Buffer.from(text), { mediaType: "text/plain" });
    expect(await reconstruct(url)).toBe(text);
    expect(await store.namespaces("artifact")).toEqual(["seed"]);
    expect(await store.names("artifact", "seed")).toHaveLength(1);
  });

  it("paginates the line budget while preserving a finite selection", async () => {
    const lines = Array.from({ length: 6500 }, (_, i) => `line-${i + 1}\r\n`);
    const url = await store.writeArtifact("seed", Buffer.from(lines.join("")), { mediaType: "text/plain" });
    expect(await reconstruct(`${url}:501-5500`)).toBe(lines.slice(500, 5500).join(""));
    expect(await store.namespaces("artifact")).toEqual(["seed"]);
  });

  it("does not mistake a UTF-8 probe ending inside a character for binary data", async () => {
    const text = "a".repeat(8191) + "😀\nnext\nlast";
    await fs.writeFile(path.join(home, "unicode.txt"), text);
    expect(await read("local://unicode.txt:2-2")).toMatchObject({ type: "text", text: "next\n", source: { line: 2, column: 1 } });
  });

  it("rejects invalid ranges, queries, and an offset inside a surrogate pair", async () => {
    await fs.writeFile(path.join(home, "text.txt"), "😀abc");
    for (const suffix of [":0", ":2-1", ":1+0", ":raw", "?offset=-1", "?offset=1", "?view=meta&view=meta", "?unknown=1"]) {
      await expect(read(`local://text.txt${suffix}`)).rejects.toMatchObject({ code: "invalid_resource_uri" });
    }
  });

  it("snapshots an ordinary dynamic source once and continues without refetching it", async () => {
    const original = "response😀\n".repeat(6000);
    let calls = 0;
    center.attach({
      scheme: "example",
      resolve: (url) => {
        calls += 1;
        const text = calls === 1 ? original : "changed";
        return { type: "text", url, text, size: Buffer.byteLength(text) };
      },
    });
    expect(await reconstruct("example://large.text")).toBe(original);
    expect(calls).toBe(1);
    expect(await store.names("artifact", "read")).toHaveLength(1);
  });

  it("reports missing resources and unavailable schemes", async () => {
    await expect(read("local://missing.txt")).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(read("unknown://value")).rejects.toMatchObject({ code: "resource_unavailable" });
  });
});

describe("image recognition reads", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const logger = { warn() {}, error() {}, info() {}, debug() {}, level: 1 } as never;

  it("decodes the question, preserves other query parameters and returns vision text", async () => {
    const provider = await startVisionProvider(200, "图片里是一只白色的小猫");
    try {
      let resourceUrl: string | undefined;
      center.attach({
        scheme: "visual",
        resolve: (url) => {
          resourceUrl = url;
          return { type: "file", url, bytes: png, mediaType: "image/png", size: png.byteLength, immutable: true };
        },
      });
      const question = '找出图中的 "猫" & 说明颜色?';
      const input = `visual://screen?lang=${encodeURIComponent("中&x?")}&question=${encodeURIComponent(question)}`;
      const tool = createReadTool({ center, visionModel: provider.model });
      const output = (await tool.execute!({ url: input }, { toolCallId: "vision-1", messages: [] })) as ReadTool.Output;
      expect(output).toEqual({
        type: "text",
        url: `visual://screen?lang=${encodeURIComponent("中&x?")}`,
        text: "图片里是一只白色的小猫",
        size: Buffer.byteLength("图片里是一只白色的小猫"),
        mediaType: "text/plain",
      });
      expect(resourceUrl).toBe(`visual://screen?lang=${encodeURIComponent("中&x?")}`);
      const request = JSON.stringify(provider.bodies[0]);
      expect(request).toContain("找出图中的");
      expect(request).toContain("& 说明颜色?");
      expect(request).toContain(`data:image/png;base64,${png.toString("base64")}`);
      expect(request).not.toContain("question");
      const converted = await tool.toModelOutput!({ toolCallId: "vision-1", input: { url: input }, output });
      const visible = await processOutput(center, "read", converted, output);
      expect(visible).toMatchObject({ output: { type: "text", value: "图片里是一只白色的小猫" }, items: [] });
    } finally {
      await provider.close();
    }
  });

  it("reports empty questions, missing configuration, non-image resources and provider failure", async () => {
    const configuredProvider = await startVisionProvider(200, "unused");
    try {
      const configured = createReadTool({ center, visionModel: configuredProvider.model });
      const image = await store.writeArtifact("image", png, { mediaType: "image/png" });
      await expect(configured.execute!({ url: `${image}?question=%20` }, { toolCallId: "vision-empty", messages: [] })).rejects.toMatchObject({
        code: "vision_question_empty",
      });
      await fs.writeFile(path.join(home, "plain.txt"), "plain");
      await expect(configured.execute!({ url: `local://plain.txt?question=read` }, { toolCallId: "vision-text", messages: [] })).rejects.toMatchObject({
        code: "vision_media_unsupported",
      });
    } finally {
      await configuredProvider.close();
    }

    await expect(read(`${await store.writeArtifact("image", png, { mediaType: "image/png" })}?question=read`)).rejects.toMatchObject({
      code: "vision_model_not_configured",
    });

    const failingProvider = await startVisionProvider(400, "unused");
    try {
      const failing = createReadTool({ center, visionModel: failingProvider.model });
      const image = await store.writeArtifact("image", png, { mediaType: "image/png" });
      await expect(failing.execute!({ url: `${image}?question=read` }, { toolCallId: "vision-fail", messages: [] })).rejects.toMatchObject({
        code: "vision_request_failed",
      });
    } finally {
      await failingProvider.close();
    }
  });

  it("rejects a configured model that does not declare image input", async () => {
    const provider = await startVisionProvider(200, "unused", ["text"]);
    try {
      expect(() => createVisionModel(provider.gateway, "vision:recognizer", { backoffMs: 0, attempts: 1, failoverOn: "unavailable" }, logger)).toThrowError(
        expect.objectContaining({ code: "vision_model_unsupported" }),
      );
    } finally {
      await provider.close();
    }
  });
});

async function startVisionProvider(status: number, text: string, input = ["text", "image"]) {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length > 0) bodies.push(JSON.parse(raw));
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "provider failed" } }));
        return;
      }
      const body = JSON.stringify({
        id: "response",
        object: "chat.completion",
        created: 1,
        model: "recognizer",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  const gateway = createGateway({
    config: {
      providers: {
        vision: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-only",
          models: [{ id: "recognizer", type: "language", input }],
        },
      },
      groups: {},
    },
  });
  return {
    gateway,
    model: gateway.languageModel("vision:recognizer"),
    bodies,
    close: async () => {
      server.closeAllConnections();
      const closing = Promise.withResolvers<void>();
      server.close((error) => (error ? closing.reject(error) : closing.resolve()));
      await closing.promise;
    },
  };
}

describe("attachment lifetime", () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const call = { toolCallId: "read-1", messages: [], context: undefined };

  it("exposes lifetime only when the call site allows choosing one", () => {
    const disabled = asSchema(createReadTool({ center }).inputSchema).jsonSchema as unknown as { properties: Record<string, unknown> };
    const enabled = asSchema(createReadTool({ center, lifetime: true }).inputSchema).jsonSchema as unknown as { properties: Record<string, unknown> };
    expect(disabled.properties).not.toHaveProperty("lifetime");
    expect(enabled.properties.lifetime).toMatchObject({ enum: ["once", "recent", "retain"] });
    const output = asSchema(createReadTool({ center, lifetime: true }).outputSchema!).jsonSchema as unknown as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    expect(output.oneOf[1]!.properties).toHaveProperty("lifetime");
  });

  it("rejects an unknown lifetime and the choice when the call site disables it", async () => {
    const url = await store.writeArtifact("image", bytes, { mediaType: "image/png", filename: "screen.png" });
    await expect(createReadTool({ center, lifetime: true }).execute!({ url, lifetime: "forever" as never }, call)).rejects.toMatchObject({
      code: "invalid_attachment_lifetime",
    });
    await expect(createReadTool({ center }).execute!({ url, lifetime: "recent" }, call)).rejects.toMatchObject({ code: "invalid_attachment_lifetime" });
  });
});
