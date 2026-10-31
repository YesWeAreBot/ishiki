import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCustomMessage } from "@yesimagent/core";
import { App } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

import Ishiki from "../src/index.js";
import { resolveProfile } from "../src/profile/config.js";
import { JEV_TRACE_SERVICE } from "../src/wakeup/jev.engine.js";

describe("Ishiki profile and runtime lifecycle", () => {
  let app: App | undefined;
  let dataPath: string | undefined;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    if (dataPath !== undefined) await rm(dataPath, { recursive: true, force: true });
    dataPath = undefined;
  });

  it("activates, looks up, delivers, restarts, and deactivates profiles and runtimes", async () => {
    dataPath = await mkdtemp(path.join(tmpdir(), "ishiki-lifecycle-"));
    await mkdir(path.join(dataPath, "profiles"), { recursive: true });
    await writeFile(
      path.join(dataPath, "models.yaml"),
      [
        "providers:",
        "  mock:",
        "    api: openai-completions",
        "    baseUrl: https://fixture.invalid/v1",
        "    apiKey: test-only",
        "    models:",
        "      - id: vision",
        "        type: language",
        "        input: [text]",
        "",
      ].join("\n"),
    );

    app = new App();
    app.plugin(Ishiki, { dataPath, dumpRequests: false, debugStream: false, logLevel: 0 });
    await app.start();
    const service = app.get("ishiki");
    expect(app.get("ishiki.engine.wakeup.jev")).toBeDefined();
    expect(app.get(JEV_TRACE_SERVICE)).toBeDefined();
    const profileRoot = path.join(dataPath, "profiles", "test-profile");
    await mkdir(profileRoot, { recursive: true });
    const profile = resolveProfile({ model: "mock:vision", mode: "channel", channels: { "test:bot": ["*"] } }, "test-profile", profileRoot);
    const domain = { mode: "channel" as const, platform: "test", selfId: "bot", channelId: "room" };

    await service.activate(profile);
    expect(service.findProfile(profile.id)).toBe(profile);
    await expect(service.activate(profile)).rejects.toThrow('profile "test-profile" is already active');

    const runtime = service.ensureRuntime(profile.id, domain);
    expect(service.findRuntime(runtime.id)).toBe(runtime);
    await service.deliver(
      runtime.id,
      createCustomMessage("ishiki.message.deleted", {
        timestamp: 1,
        platform: "test",
        selfId: "bot",
        channelId: "room",
        messageId: "deleted-1",
      }),
    );

    await vi.waitFor(async () => {
      const delivered = await runtime.storage.read();
      expect(delivered.some((entry) => entry.type === "message" && entry.data.role === "custom" && entry.data.type === "ishiki.message.deleted")).toBe(true);
    });

    const restartedRuntime = await service.restartRuntime(runtime.id);
    expect(restartedRuntime).not.toBe(runtime);
    expect(restartedRuntime.id).toBe(runtime.id);
    expect(service.findRuntime(runtime.id)).toBe(restartedRuntime);

    await service.restart(profile.id);
    expect(service.findProfile(profile.id)).toBe(profile);
    expect(service.findRuntime(runtime.id)).toBeUndefined();
    const afterProfileRestart = service.ensureRuntime(profile.id, domain);
    expect(afterProfileRestart).not.toBe(restartedRuntime);

    await service.deactivateRuntime(afterProfileRestart.id);
    expect(service.findRuntime(afterProfileRestart.id)).toBeUndefined();
    await service.deactivate(profile.id);
    expect(service.findProfile(profile.id)).toBeUndefined();
    expect(() => service.ensureRuntime(profile.id, domain)).toThrow('profile "test-profile" is not active');
  });
});
