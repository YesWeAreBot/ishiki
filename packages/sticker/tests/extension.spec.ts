import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Console from "@koishijs/console";
import memory from "@koishijs/plugin-database-memory";
import Server from "@koishijs/plugin-server";
import { App, Bot, type Context, type Session } from "koishi";
import Ishiki from "koishi-plugin-ishiki";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startApp, writeProfile, type TestSetup } from "../../koishi-plugin-ishiki/tests/harness.js";
import { importFromDirectory } from "../src/importer.js";
import StickerExtension from "../src/index.js";
import { sha256Hex } from "../src/media.js";
import { ReviewQueue, REVIEW_PARSE_FAILURE_REASON } from "../src/reviewer.js";
import type { BlacklistRecord, PluginConfig, StickerListResult, StickerOverview, StickerRecord } from "../src/types.js";

function makePng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

interface Call {
  name: string;
  args?: Record<string, unknown>;
}

function streamToolCalls(calls: Call[]): Response {
  const tool_calls = calls.map((call, index) => ({
    index,
    id: `call-${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify({ i: "test operation", ...call.args }) },
  }));
  const parts = [
    { delta: { role: "assistant", tool_calls }, finish_reason: null },
    { delta: {}, finish_reason: "tool_calls" },
  ];
  const sse = parts
    .map((part) => `data: ${JSON.stringify({ id: "ans", object: "chat.completion.chunk", model: "vision", created: 1, choices: [{ index: 0, ...part }] })}\n\n`)
    .join("");
  return new Response(`${sse}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

class StickerTestPlugin {
  public constructor(ctx: Context) {
    ctx.plugin(StickerExtension, {
      dataDir: "",
      importRoots: [],
      defaultVisionModel: "mock:vision",
      defaultEmbeddingModel: "",
      requireApproval: false,
      maxFileBytes: 8 * 1024 * 1024,
      maxAspectRatio: 2.6,
      maxTotalStickers: 500,
      reviewConcurrency: 2,
      reviewRpm: 60,
      commands: { enable: true, authority: 3, readAuthority: 2, allowedPacks: [] },
      logLevel: 0,
    });
  }
}

let setup: TestSetup;
let queuedTurns: Call[][];
let vlmDecisions: Array<Record<string, unknown>>;
let sentMessages: Array<{ platform: string; channelId: string; content: string }>;
let receipts: Array<{ name: string; value: unknown }>;
let serial = 0;
const tempDirs: string[] = [];

beforeEach(async () => {
  queuedTurns = [];
  vlmDecisions = [];
  sentMessages = [];
  receipts = [];
  serial = 0;

  const memeBytes = makePng(96, 96, [250, 120, 160]);
  const meme2Bytes = makePng(96, 96, [90, 190, 250]);

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://fixture.invalid/meme1.png") {
      return new Response(Buffer.from(memeBytes), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url === "https://fixture.invalid/meme2.png") {
      return new Response(Buffer.from(meme2Bytes), { status: 200, headers: { "content-type": "image/png" } });
    }

    const bodyText = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (body.stream !== true && !Array.isArray(body.tools)) {
      // VLM review call (generateText uses non-streaming without tools)
      const payload = vlmDecisions.shift() ?? {
        isSticker: true,
        safe: true,
        rejectReason: "",
        category: "开心",
        tags: ["可爱", "贴贴"],
        description: "开心地招手",
        ocrText: "贴贴",
        characterName: "小桃",
        workName: "示例作品",
        emotions: ["开心"],
        scenes: ["打招呼"],
      };
      return new Response(
        JSON.stringify({
          id: "vlm-1",
          object: "chat.completion",
          created: 1,
          model: "vision",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
    return streamToolCalls(queuedTurns.shift() ?? [{ name: "finish" }]);
  });

  setup = await startApp({
    plugins: [StickerTestPlugin],
    users: [
      { id: "alice", authority: 1 },
      { id: "admin", authority: 4 },
    ],
  });

  // Replace models.yaml to declare image input on mock:vision
  fs.writeFileSync(
    path.join(setup.dataPath, "models.yaml"),
    [
      "providers:",
      "  mock:",
      "    api: openai-completions",
      "    baseUrl: https://fixture.invalid/v1",
      "    apiKey: test-only-secret",
      "    models:",
      "      - id: vision",
      "        type: language",
      "        input: [text, image]",
      "",
    ].join("\n"),
  );
  await setup.host.management.models.reload?.().catch(() => undefined);
  setup.host.gateway.reconfigure({
    providers: {
      mock: {
        api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
        apiKey: "test-only-secret",
        models: [{ id: "vision", type: "language", input: ["text", "image"] }],
      },
    },
  });

  vi.spyOn(setup.bot, "sendMessage").mockImplementation(async (channelId, content) => {
    sentMessages.push({ platform: setup.bot.platform, channelId, content: String(content) });
    return [`sent-${sentMessages.length}`];
  });
});

afterEach(async () => {
  try {
    await setup?.stop();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  }
});

function createSession(userId: string, content: string, channelId = "room1", bot: Bot = setup.bot): Session {
  const created = setup.app.reflect.trace(
    bot.session({
      type: "message-created",
      platform: bot.platform,
      selfId: bot.selfId,
      channelId,
      userId,
      user: { id: userId, name: userId },
      channel: { id: channelId, type: 1 },
      message: { id: `in-${++serial}`, content },
      timestamp: Date.now(),
    } as never),
  ) as unknown as Session;
  created.content = content;
  return created;
}

async function runTurn(userId: string, content: string, steps: Call[][], channelId = "room1", bot: Bot = setup.bot): Promise<string[]> {
  const s = createSession(userId, content, channelId, bot);
  const rt = setup.host.ensureRuntime("demo", { mode: "channel", platform: bot.platform, selfId: bot.selfId, channelId });
  const observedTools: string[] = [];
  const done = Promise.withResolvers<string>();

  const unsub = rt.agent.channel.subscribe("agent", (event) => {
    if (event.type === "tool.done") receipts.push({ name: event.toolName, value: event.result });
    if (event.type === "tool.failed") receipts.push({ name: `${event.toolName}:failed`, value: event.error });
    if (event.type === "tool.blocked") receipts.push({ name: `${event.toolName}:blocked`, value: event.reason });
    if (event.type === "turn.done" || event.type === "turn.failed") {
      done.resolve(event.type === "turn.failed" ? (event.error?.message ?? event.type) : event.type);
    }
  });

  try {
    for (const step of steps) queuedTurns.push(step);
    s.bot.dispatch(s);
    const outcome = await done.promise;
    expect(outcome).toBe("turn.done");
    await rt.agent.wait();
    return observedTools;
  } finally {
    unsub();
  }
}

describe("StickerExtension end-to-end", () => {
  it("supports direct tool workflow (save -> search with artifact -> send with platform awareness)", async () => {
    // Also create an OneBot bot to verify OneBot sticker attributes vs standard Satori img
    class OneBotStub extends Bot {
      public constructor(ctx: Context) {
        super(ctx as never, {}, "onebot");
        this.platform = "onebot";
        this.selfId = "10002";
      }
      public async start(): Promise<void> {}
      public async dispose(): Promise<void> {}
      public async sendMessage(channelId: string, content: unknown): Promise<string[]> {
        sentMessages.push({ platform: "onebot", channelId, content: String(content) });
        return [`ob-${sentMessages.length}`];
      }
    }
    const obBot = new OneBotStub(setup.app as unknown as Context);

    await writeProfile(setup.dataPath, "demo", {
      model: "mock:vision",
      mode: "channel",
      channels: { "test:10001": ["*"], "onebot:10002": ["*"] },
      codemode: { enable: false },
      wakeup: { engine: "willingness", willingness: { directForce: true } },
      extends: {
        sticker: {
          enable: true,
          config: {
            readPacks: ["memes"],
            writePack: "memes",
            sendChance: 1,
            sendCooldownSeconds: 0,
            maxSendPerTurn: 1,
            onebotAsSticker: true,
            autonomousDailyLimit: 2,
            autonomousCooldownMinutes: 0,
          },
        },
      },
    });
    await setup.host.management.profiles.apply("demo");

    // Step 1: Inbound image in OneBot -> model saves it -> searches with includeArtifact -> sends on OneBot
    const rtOb = setup.host.ensureRuntime("demo", { mode: "channel", platform: "onebot", selfId: "10002", channelId: "group-1" });
    await runTurn(
      "alice",
      '<img src="https://fixture.invalid/meme1.png"/> 把这个表情存一下',
      [[{ name: "sticker_save", args: { url: "", character: "小桃", work: "示例作品" } }]],
      "group-1",
      obBot,
    ).catch(() => undefined);

    // Inspect captured asset URL from storage and execute real tool calls directly via runtime
    const entries = await rtOb.storage.read();
    const lastCustom = entries.findLast((e) => e.type === "message" && e.data.role === "custom");
    const content =
      lastCustom && lastCustom.type === "message" && lastCustom.data.role === "custom" ? String((lastCustom.data.data as { content: string }).content) : "";
    const match = /asset:\/\/[a-zA-Z0-9-]+/.exec(content);
    expect(match).not.toBeNull();
    const assetUrl = match![0]!;

    receipts = [];
    sentMessages = [];
    await runTurn(
      "alice",
      "发个开心的表情包",
      [
        [{ name: "sticker_save", args: { url: assetUrl, character: "小桃", work: "示例作品" } }],
        [{ name: "sticker_search", args: { query: "开心", includeArtifact: true } }],
        [{ name: "sticker_send", args: { query: "开心" } }],
        [{ name: "finish" }],
      ],
      "group-1",
      obBot,
    );

    const saveReceipt = receipts.find((r) => r.name === "sticker_save")?.value as Record<string, unknown>;
    expect(saveReceipt, `receipts=${JSON.stringify(receipts)}`).toBeDefined();
    expect(saveReceipt.ok).toBe(true);
    expect(saveReceipt.approvalStatus).toBe("active");

    const searchReceipt = receipts.find((r) => r.name === "sticker_search")?.value as { ok: boolean; items: Array<{ id: string; artifactUrl?: string }> };
    expect(searchReceipt.ok).toBe(true);
    expect(searchReceipt.items[0]?.artifactUrl).toMatch(/^artifact:\/\//);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.platform).toBe("onebot");
    expect(sentMessages[0]!.content).toContain('sub-type="1"');
    expect(sentMessages[0]!.content).toContain('summary="[动画表情]"');

    // Now test standard non-OneBot platform (test:10001) sends clean <img> without sub-type
    sentMessages = [];
    await runTurn("alice", "来张表情", [[{ name: "sticker_send", args: { query: "开心" } }], [{ name: "finish" }]], "room1", setup.bot);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.platform).toBe("test");
    expect(sentMessages[0]!.content).toContain('<img src="data:image/png;base64,');
    expect(sentMessages[0]!.content).not.toContain("sub-type");
  });

  it("works inside QuickJS codemode sandbox and enforces dual-control pacing & save intent gate", async () => {
    await writeProfile(setup.dataPath, "demo", {
      model: "mock:vision",
      mode: "channel",
      channels: { "test:10001": ["*"] },
      codemode: { enable: true },
      wakeup: { engine: "willingness", willingness: { directForce: true } },
      extends: {
        sticker: {
          enable: true,
          config: {
            readPacks: ["default"],
            writePack: "default",
            sendChance: 0, // closed on plain text turns
            exemptStickerReply: true, // open on <img> or 斗图
            sendCooldownSeconds: 300,
            maxSendPerTurn: 1,
            autonomousDailyLimit: 1,
            autonomousCooldownMinutes: 0,
          },
        },
      },
    });
    await setup.host.management.profiles.apply("demo");

    // Seed one sticker into default pack
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-seed-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "可爱"));
    fs.writeFileSync(path.join(dir, "可爱", "wave.png"), makePng(64, 64, [255, 220, 100]));

    const ext = setup.app.get("ishiki.ext.sticker") as unknown as {
      store: { overview: (a: null, q: { pending: number; running: number; completed: number; failed: number }) => StickerOverview };
      pluginConfig: PluginConfig;
    };
    const imported = await importFromDirectory(ext.store as never, ext.pluginConfig, undefined, undefined, { dirPath: dir, pack: "default" });
    expect(imported.imported).toBe(1);

    // 1. Plain text turn with sendChance=0 -> sticker_send is NOT available in codemode
    await runTurn("alice", "今天天气不错", [
      [{ name: "codemode", args: { i: "check tools", js: "return ALL_TOOLS.some(t => t.name === 'sticker_send');" } }],
      [{ name: "finish" }],
    ]);
    const plainReceipt = receipts.find((r) => r.name === "codemode")?.value as { result: { ok: boolean; value: unknown; error?: unknown }; text?: string };
    expect(plainReceipt.result.value, `plainReceipt=${JSON.stringify(plainReceipt)}`).toBe(false);

    // 2. Sticker reply ("来斗图") triggers exemptStickerReply -> tools available & maxSendPerTurn=1 enforced
    receipts = [];
    sentMessages = [];
    await runTurn("alice", "来斗图！", [
      [
        {
          name: "codemode",
          args: {
            i: "search and send twice",
            js: 'const hasSend = ALL_TOOLS.some(t => t.name === "sticker_send"); const s = await tools.sticker_search({ category: "可爱" }); const r1 = await tools.sticker_send({ id: s.items[0].id }); const r2 = await tools.sticker_send({ id: s.items[0].id }); return { hasSend, s, r1, r2 };',
          },
        },
      ],
      [{ name: "finish" }],
    ]);
    const cmReceipt = receipts.find((r) => r.name === "codemode")?.value as {
      result: { ok: boolean; value: { hasSend: boolean; r1: { ok: boolean }; r2: { ok: boolean; error: string } } };
    };
    expect(cmReceipt.result.ok).toBe(true);
    expect(cmReceipt.result.value.hasSend).toBe(true);
    expect(cmReceipt.result.value.r1.ok).toBe(true);
    expect(cmReceipt.result.value.r2.ok).toBe(false);
    expect(cmReceipt.result.value.r2.error).toBe("rate_limited");
    expect(sentMessages).toHaveLength(1);

    // 3. Immediate next turn is blocked by sendCooldownSeconds = 300
    receipts = [];
    await runTurn("alice", "再来斗图！", [
      [{ name: "codemode", args: { i: "check cooldown", js: "return ALL_TOOLS.some(t => t.name === 'sticker_send');" } }],
      [{ name: "finish" }],
    ]);
    const cdReceipt = receipts.find((r) => r.name === "codemode")?.value as { result: { value: unknown } };
    expect(cdReceipt.result.value).toBe(false);

    // 4. Sliding recentInbounds window: 6 plain-text messages clear the old image from save gate visibility
    const rt = setup.host.ensureRuntime("demo", { mode: "channel", platform: "test", selfId: "10001", channelId: "room2" });
    await runTurn("alice", '<img src="https://fixture.invalid/meme1.png"/>', [[{ name: "finish" }]], "room2");
    await runTurn(
      "alice",
      "随便聊聊",
      [[{ name: "codemode", args: { i: "check save", js: "return ALL_TOOLS.some(t => t.name === 'sticker_save');" } }], [{ name: "finish" }]],
      "room2",
    );
    const saveAvailable = (receipts.at(-2)?.value as { result?: { value?: unknown } })?.result?.value;
    expect(saveAvailable).toBe(true);

    for (let i = 0; i < 6; i++) {
      await runTurn("alice", `纯文字消息 ${i}`, [[{ name: "finish" }]], "room2");
    }
    receipts = [];
    await runTurn(
      "alice",
      "现在没图了",
      [[{ name: "codemode", args: { i: "check save gone", js: "return ALL_TOOLS.some(t => t.name === 'sticker_save');" } }], [{ name: "finish" }]],
      "room2",
    );
    const goneReceipt = receipts.find((r) => r.name === "codemode")!.value as { result: { value: unknown } };
    expect(goneReceipt.result.value).toBe(false);

    // 5. Save Intent Gate: autonomousDailyLimit=1 allows 1st autonomous steal, blocks 2nd, explicit request still passes
    void rt;
    const rt3 = setup.host.ensureRuntime("demo", { mode: "channel", platform: "test", selfId: "10001", channelId: "room3" });
    await runTurn("alice", '<img src="https://fixture.invalid/meme1.png"/>', [[{ name: "finish" }]], "room3");
    const e3 = await rt3.storage.read();
    const asset1 = /asset:\/\/[a-zA-Z0-9-]+/.exec(JSON.stringify(e3))![0]!;
    receipts = [];
    await runTurn(
      "alice",
      "哈哈",
      [[{ name: "codemode", args: { i: "auto steal 1", js: `return await tools.sticker_save({ url: ${JSON.stringify(asset1)} });` } }], [{ name: "finish" }]],
      "room3",
    );
    const auto1Receipt = receipts.find((r) => r.name === "codemode")!.value as { result: { value: { ok: boolean } } };
    expect(auto1Receipt.result.value.ok).toBe(true);

    await runTurn("alice", '<img src="https://fixture.invalid/meme2.png"/>', [[{ name: "finish" }]], "room3");
    const e3b = await rt3.storage.read();
    const matches = [...JSON.stringify(e3b).matchAll(/asset:\/\/[a-zA-Z0-9-]+/g)].map((m) => m[0]);
    const asset2 = matches.at(-1)!;
    receipts = [];
    await runTurn(
      "alice",
      "继续聊天",
      [[{ name: "codemode", args: { i: "auto steal 2", js: `return await tools.sticker_save({ url: ${JSON.stringify(asset2)} });` } }], [{ name: "finish" }]],
      "room3",
    );
    const blockedSteal = (receipts.find((r) => r.name === "codemode")!.value as { result: { value: { ok: boolean; error: string } } }).result.value;
    expect(blockedSteal.ok).toBe(false);
    expect(blockedSteal.error).toBe("save_gate_blocked");

    // Explicit user save request bypasses autonomousDailyLimit
    receipts = [];
    await runTurn(
      "alice",
      "帮我把这张表情存下来",
      [[{ name: "codemode", args: { i: "explicit save", js: `return await tools.sticker_save({ url: ${JSON.stringify(asset2)} });` } }], [{ name: "finish" }]],
      "room3",
    );
    const explicitReceipt = receipts.find((r) => r.name === "codemode")!.value as { result: { value: { ok: boolean } } };
    expect(explicitReceipt.result.value.ok).toBe(true);
  });

  it("supports directory import with manifest and store/console operations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-import-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, "无语"));
    const pngBytes = makePng(72, 72, [40, 40, 200]);
    fs.writeFileSync(path.join(dir, "无语", "sigh.png"), pngBytes);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        "无语/sigh.png": {
          tags: ["叹气"],
          desc: "默默叹气",
          character: "测试角色",
        },
      }),
    );

    const ext = setup.app.get("ishiki.ext.sticker") as unknown as {
      store: {
        overview: (a: null, q: { pending: number; running: number; completed: number; failed: number }) => StickerOverview;
        list: (q: Record<string, unknown>) => StickerListResult;
        update: (id: string, patch: Record<string, unknown>) => StickerRecord | undefined;
        batch: (action: "ban", ids: string[], value?: string) => { affected: number };
        listBlacklist: () => Array<{ sha256: string }>;
        unban: (sha: string) => boolean;
      };
      pluginConfig: PluginConfig;
    };

    const imported = await importFromDirectory(ext.store as never, ext.pluginConfig, undefined, undefined, { dirPath: dir, pack: "common" });
    expect(imported.imported).toBe(1);

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-outside-"));
    tempDirs.push(outsideRoot);
    await expect(
      importFromDirectory(ext.store as never, ext.pluginConfig, undefined, undefined, {
        dirPath: dir,
        pack: "common",
        allowedRoots: [outsideRoot],
      }),
    ).rejects.toThrow(/importRoots/);

    const listed = ext.store.list({ pack: "common", status: "active" });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.category).toBe("无语");
    expect(listed.items[0]?.characterName).toBe("测试角色");

    const updated = ext.store.update(listed.items[0]!.id, { ocrText: "唉" });
    expect(updated?.ocrText).toBe("唉");

    const sha = sha256Hex(pngBytes);
    expect(ext.store.batch("ban", [listed.items[0]!.id], "test_ban").affected).toBe(1);
    expect(ext.store.listBlacklist().map((b) => b.sha256)).toContain(sha);
    expect(ext.store.unban(sha)).toBe(true);

    // Auto-tag fail-closed parse error preserves manifest metadata and active status;
    // explicit safety rejection preserves metadata while demoting to pending.
    const preserveDir = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-preserve-"));
    tempDirs.push(preserveDir);
    fs.writeFileSync(path.join(preserveDir, "keep-parse.png"), makePng(74, 74, [90, 20, 120]));
    fs.writeFileSync(path.join(preserveDir, "demote-unsafe.png"), makePng(76, 76, [120, 90, 20]));
    fs.writeFileSync(
      path.join(preserveDir, "manifest.json"),
      JSON.stringify({
        "keep-parse.png": { tags: ["保留标签"], desc: "保留描述", character: "小桃" },
        "demote-unsafe.png": { tags: ["原标签"], desc: "原描述" },
      }),
    );
    const localQueue = new ReviewQueue(1, 600);
    const mockFailReviewer = {
      resolveVisionModelRef: (ref: string) => ref,
      review: async (input: { facts?: { character?: string } }) => ({
        approved: false,
        isSticker: false,
        safe: false,
        rejectReason: input.facts?.character === "小桃" ? REVIEW_PARSE_FAILURE_REASON : "不安全图片",
        category: "未分类",
        tags: [],
        description: "",
        ocrText: "",
        characterName: "",
        workName: "",
        emotions: [],
        scenes: [],
        cached: false,
      }),
      embedStickerFields: async () => undefined,
    };
    const autoImported = await importFromDirectory(ext.store as never, ext.pluginConfig, mockFailReviewer as never, localQueue, {
      dirPath: preserveDir,
      pack: "preserve",
      autoTag: true,
    });
    expect(autoImported.queuedForReview).toBe(2);
    await vi.waitFor(() => expect(localQueue.snapshot().completed).toBe(2));
    const afterItems = ext.store.list({ pack: "preserve" }).items;
    const parseRec = afterItems.find((item) => item.characterName === "小桃");
    const unsafeRec = afterItems.find((item) => item.characterName === "");
    expect(parseRec?.status).toBe("active");
    expect(parseRec?.tags).toEqual(["保留标签"]);
    expect(parseRec?.description).toBe("保留描述");
    expect(unsafeRec?.status).toBe("pending");
    expect(unsafeRec?.tags).toEqual(["原标签"]);
    expect(unsafeRec?.description).toBe("原描述");
  });

  it("registers Console RPC listeners and Server HTTP media route", async () => {
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "ishiki-console-"));
    tempDirs.push(dataPath);
    fs.mkdirSync(path.join(dataPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(dataPath, "models.yaml"), "providers: {}\n");

    const app = new App();
    app.plugin(memory);
    app.plugin(Server, { host: "127.0.0.1", port: 15841, maxPort: 15941 });
    app.plugin(Console, { open: false });
    app.plugin(Ishiki, {
      dataPath,
      dumpRequests: false,
      debugStream: false,
      logLevel: 0,
      commands: { enable: false, authority: 3 },
    });
    app.plugin(StickerExtension, {
      dataDir: "",
      importRoots: [],
      defaultVisionModel: "",
      defaultEmbeddingModel: "",
      requireApproval: false,
      maxFileBytes: 8 * 1024 * 1024,
      maxAspectRatio: 2.6,
      maxTotalStickers: 200,
      reviewConcurrency: 1,
      reviewRpm: 30,
      commands: { enable: false, authority: 3, readAuthority: 2, allowedPacks: [] },
      logLevel: 0,
    });

    await app.start();
    try {
      const server = app.server as unknown as { _http?: { address: () => { port: number } }; selfUrl: string };
      await vi.waitFor(() => expect(server._http?.address()?.port).toBeTypeOf("number"));
      const consoleService = app.console as unknown as {
        listeners: Record<string, { callback: (...args: unknown[]) => Promise<{ ok: boolean; value?: unknown }> }>;
      };
      const fakeClient = {} as never;
      const callRpc = async <T>(name: string, ...args: unknown[]): Promise<T> => {
        const listener = consoleService.listeners[name];
        expect(listener).toBeDefined();
        const res = await listener!.callback.apply(fakeClient, args);
        expect(res.ok).toBe(true);
        return res.value as T;
      };

      const pngBytes = makePng(64, 64, [20, 180, 220]);
      const uploadRes = await callRpc<{ created: number }>("ishiki-sticker/upload", {
        pack: "console-pack",
        files: [{ name: "test.png", dataBase64: Buffer.from(pngBytes).toString("base64") }],
        autoTag: false,
        character: "小桃",
      });
      expect(uploadRes.created).toBe(1);

      const overview = await callRpc<StickerOverview>("ishiki-sticker/overview");
      expect(overview.totalActive).toBe(1);
      expect(overview.mediaBasePath).toMatch(/^\/ishiki-sticker\/[a-f0-9]+\/files$/);

      const list = await callRpc<StickerListResult>("ishiki-sticker/list", { pack: "console-pack", status: "active" });
      expect(list.total).toBe(1);
      const item = list.items[0]!;
      expect(item.characterName).toBe("小桃");

      const updated = await callRpc<StickerRecord>("ishiki-sticker/update", item.id, { category: "卖萌", ocrText: "你好" });
      expect(updated.category).toBe("卖萌");

      const port = server._http?.address()?.port;
      expect(typeof port).toBe("number");
      const http = await import("node:http");
      const fetched = await new Promise<{ statusCode: number; contentType: string; body: Buffer }>((resolve, reject) => {
        http
          .get(`${server.selfUrl}${overview.mediaBasePath}/${item.sha256}`, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, contentType: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
          })
          .on("error", reject);
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.contentType).toBe("image/png");
      expect(fetched.body.equals(Buffer.from(pngBytes))).toBe(true);

      await callRpc<{ affected: number }>("ishiki-sticker/batch", { action: "ban", ids: [item.id], value: "rpc_ban" });
      const banList = await callRpc<BlacklistRecord[]>("ishiki-sticker/blacklist/list");
      expect(banList.map((b) => b.sha256)).toContain(item.sha256);
      await callRpc<{ removed: boolean }>("ishiki-sticker/blacklist/remove", item.sha256);
    } finally {
      await app.stop();
    }
  });
});
