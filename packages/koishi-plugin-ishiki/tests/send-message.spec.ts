import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Bot, type Fragment } from "@satorijs/core";
import { Context } from "koishi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSendMessage } from "../src/builtin-tools/send-message.js";
import { TypingConfig } from "../src/profile/config.js";
import { ResourceCenter } from "../src/resource/center.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY7sAAAAASUVORK5CYII=";
const SENTINEL = "private-message-sentinel";

class RecordingBot extends Bot {
  public readonly attempts: string[] = [];
  public failNext = false;

  constructor(ctx: Context) {
    super(ctx as never, {}, "test");
    this.platform = "test";
    this.selfId = "bot";
  }

  async start(): Promise<void> {}

  async dispose(): Promise<void> {}

  async sendMessage(_channelId: string, content: Fragment): Promise<string[]> {
    const text = Array.isArray(content) ? content.join("") : String(content ?? "");
    this.attempts.push(text);
    if (this.failNext) {
      this.failNext = false;
      const error = new Error(`${SENTINEL}: ${text}`);
      error.name = "PlatformRejected";
      Object.assign(error, { code: "platform_rejected" });
      throw error;
    }
    return [`message-${this.attempts.length}`];
  }
}

let home: string;
let center: ResourceCenter;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ishiki-send-"));
  center = new ResourceCenter("send-test", home);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function setup() {
  const ctx = new Context();
  const bot = new RecordingBot(ctx);
  const warnings: unknown[][] = [];
  const logger = {
    level: 1,
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  } as never;
  const send = createSendMessage({
    ctx,
    logger,
    domain: { mode: "channel", platform: "test", selfId: "bot", channelId: "room" },
    typing: TypingConfig({ baseDelay: 0, charPerSecond: 0, minDelay: 0, maxDelay: 0 }),
    resources: center,
  });
  return { bot, send, warnings };
}

describe("send_message failures", () => {
  it("returns error-json without leaking message text or resolved data URIs", async () => {
    const url = await center.store.writeArtifact("source", Buffer.from(PNG, "base64"), { mediaType: "image/png" });
    const { bot, send, warnings } = setup();
    bot.failNext = true;

    const output = await send.execute!({ mode: "element", messages: [`<img src="${url}"/>${SENTINEL}`] }, { toolCallId: "failed", messages: [] });
    const converted = send.toModelOutput!({ toolCallId: "failed", input: { messages: [] }, output });
    const exposed = JSON.stringify({ output, converted, warnings });

    expect(converted.type).toBe("error-json");
    expect(output).toEqual({
      ok: false,
      error: { name: "PlatformRejected", code: "platform_rejected", message: "send_message failed" },
      sent: [],
      failedAt: 0,
    });
    expect(exposed).not.toContain(SENTINEL);
    expect(exposed).not.toContain("data:image/png");
    expect(exposed).not.toContain(PNG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("image/png");
  });

  it("keeps one bubble per messages item and continues after a failure", async () => {
    const { bot, send } = setup();
    bot.failNext = true;

    const output = await send.execute!({ messages: ["first bubble", "second bubble"], continue: true }, { toolCallId: "continue", messages: [] });

    expect(bot.attempts).toHaveLength(2);
    expect(bot.attempts[0]).toContain("first bubble");
    expect(bot.attempts[1]).toContain("second bubble");
    expect(output).toMatchObject({
      ok: false,
      sent: ["message-2"],
      failedAt: 0,
      error: { name: "PlatformRejected", code: "platform_rejected" },
    });
    expect(send.toModelOutput!({ toolCallId: "continue", input: { messages: [] }, output }).type).toBe("error-json");
  });

  it("returns json on success and sends each messages item as its own bubble", async () => {
    const { bot, send } = setup();

    const output = await send.execute!({ messages: ["one", "two"] }, { toolCallId: "success", messages: [] });

    expect(bot.attempts.map((text) => text.trim())).toEqual(["one", "two"]);
    expect(output).toEqual({ ok: true, ids: ["message-1", "message-2"] });
    expect(send.toModelOutput!({ toolCallId: "success", input: { messages: [] }, output }).type).toBe("json");
  });
});
