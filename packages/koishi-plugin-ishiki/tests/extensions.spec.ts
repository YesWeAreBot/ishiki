import { App, Schema, Service, type Context } from "koishi";
import { afterEach, describe, expect, it } from "vitest";

import { Extension } from "../src/extension.js";
import { extensionsDirectory } from "../src/manage/catalog.js";

class DemoExtension extends Extension<{ mode: string }> {
  public readonly Schema = Schema.object({
    mode: Schema.string().default("auto").description("运行模式"),
  });

  constructor(ctx: Context) {
    super(ctx, "demo");
  }

  public [Service.invoke]() {
    return undefined;
  }
}

describe("extension directory", () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("exposes the instance schema of every registered extension", async () => {
    app = new App();
    app.plugin((ctx) => {
      new DemoExtension(ctx);
    });
    await app.start();

    const descriptor = extensionsDirectory(app as Context).extensions.find((entry) => entry.name === "demo");
    expect(descriptor?.schema?.dict?.mode.meta).toMatchObject({ default: "auto", description: "运行模式" });
    expect(descriptor !== undefined && "known" in descriptor).toBe(false);
  });
});
