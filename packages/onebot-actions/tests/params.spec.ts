import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import type { Logger } from "koishi";
import { ResourceCenter, ResourceError } from "koishi-plugin-ishiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findAction } from "../src/catalog/index.js";
import type { CatalogAction } from "../src/catalog/types.js";
import { MediaPublisher } from "../src/media.js";
import { resolveParams } from "../src/params.js";

const silent = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

let home: string;
let resources: ResourceCenter;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-onebot-"));
  resources = new ResourceCenter("rt", home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function options(overrides: Partial<{ maxInlineBytes: number; baseUrl: string; action: CatalogAction }> = {}) {
  const action = overrides.action ?? findAction("send_msg")!;
  return {
    action,
    media: {
      resources,
      publisher: new MediaPublisher(),
      maxInlineBytes: overrides.maxInlineBytes ?? 8 * 1024 * 1024,
      baseUrl: overrides.baseUrl,
      ctx: { get: () => undefined } as never,
      logger: silent,
    },
  };
}

describe("resource scheme conversion", () => {
  it("inlines local resources as base64", async () => {
    const file = path.join(home, "pixel.png");
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { action, media } = options();
    const resolved = await resolveParams({ message: [{ type: "image", data: { file: "local://pixel.png" } }] }, action, media);
    expect(resolved.message).toEqual([{ type: "image", data: { file: "base64://iVBORw==" } }]);
  });

  it("leaves protocol-native sources untouched", async () => {
    const { action, media } = options();
    const input = {
      message: [
        { type: "image", data: { file: "https://example.test/a.png" } },
        { type: "image", data: { file: "base64://AAAA" } },
        { type: "image", data: { file: "data:image/png;base64,AAAA" } },
        { type: "image", data: { file: "C:/tmp/a.png" } },
      ],
    };
    expect(await resolveParams(input, action, media)).toEqual(input);
  });

  it("rejects text resources and oversized files", async () => {
    await fs.writeFile(path.join(home, "notes.txt"), "正文");
    const text = options();
    await expect(resolveParams({ message: [{ type: "image", data: { file: "local://notes.txt" } }] }, text.action, text.media)).rejects.toThrow(/二进制媒体/);

    await fs.writeFile(path.join(home, "big.png"), Buffer.alloc(64));
    const small = options({ maxInlineBytes: 8 });
    await expect(resolveParams({ message: [{ type: "image", data: { file: "local://big.png" } }] }, small.action, small.media)).rejects.toThrow(
      /maxInlineBytes/,
    );
  });

  it("leaves unregistered schemes for the protocol backend", async () => {
    const { action, media } = options();
    expect(await resolveParams({ message: [{ type: "image", data: { file: "nope://x" } }] }, action, media)).toEqual({
      message: [{ type: "image", data: { file: "nope://x" } }],
    });
  });

  it("surfaces a missing local resource as a resource error", async () => {
    const { action, media } = options();
    await expect(resolveParams({ message: [{ type: "image", data: { file: "local://absent.png" } }] }, action, media)).rejects.toBeInstanceOf(ResourceError);
  });
});

describe("media transport", () => {
  it("publishes declared http parameters instead of inlining them", async () => {
    const action = findAction("ocr_image")!;
    await fs.writeFile(path.join(home, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { media } = options({ action });
    let published: { bytes: Uint8Array; mediaType: string; baseUrl?: string } | undefined;
    media.publisher.publish = (_ctx, bytes, mediaType, baseUrl) => {
      published = { bytes, mediaType, baseUrl };
      return "http://host.test/published";
    };
    const resolved = await resolveParams({ image: "local://shot.png" }, action, { ...media, baseUrl: "http://host.test" });
    expect(resolved.image).toBe("http://host.test/published");
    expect(published?.mediaType).toBe("image/png");
    expect(published?.baseUrl).toBe("http://host.test");
  });
});
