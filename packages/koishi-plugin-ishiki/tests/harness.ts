import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import memory from "@koishijs/plugin-database-memory";
import { Bot, type Fragment } from "@satorijs/core";
import { App, type Context, type Session } from "koishi";
import { stringify } from "yaml";

import Ishiki from "../src/index.js";

export const SECRET = "test-only-secret";

export const MODELS = [
  "providers:",
  "  mock:",
  "    api: openai-completions",
  "    baseUrl: https://fixture.invalid/v1",
  `    apiKey: ${SECRET}`,
  "    models:",
  "      - id: vision",
  "        type: language",
  "        input: [text]",
  "",
].join("\n");

/** 真实 Bot 实例：不连适配器，sendMessage 记录指令输出供断言。 */
class TestBot extends Bot {
  public readonly sent: string[] = [];

  constructor(ctx: Context) {
    super(ctx as never, {}, "test");
    this.platform = "test";
    this.selfId = "10001";
  }

  async start(): Promise<void> {}

  async dispose(): Promise<void> {}

  async sendMessage(_channelId: string, content: Fragment): Promise<string[]> {
    this.sent.push(Array.isArray(content) ? content.join("") : String(content ?? ""));
    return [];
  }
}

export interface TestSetup {
  app: App;
  host: Ishiki;
  bot: TestBot;
  dataPath: string;
  outputs(): string[];
  /** 构造会话（真实 Session，挂在 TestBot 上）。 */
  session(userId: string, channelId?: string, content?: string): Session;
  /** 模拟该用户在该频道发出一条消息，走完整的中间件路由（含指令识别）。 */
  message(userId: string, content: string, channelId?: string): Promise<void>;
  /** 派发一条回复消息进中间件链，用于二次确认。 */
  reply(userId: string, content: string, channelId?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startApp(
  options: {
    users?: Array<{ id: string; authority: number }>;
    plugins?: Array<new (ctx: Context) => unknown>;
    commands?: { enable: boolean; authority: number };
  } = {},
): Promise<TestSetup> {
  const dataPath = await mkdtemp(path.join(tmpdir(), "ishiki-commands-"));
  await mkdir(path.join(dataPath, "profiles"), { recursive: true });
  await writeFile(path.join(dataPath, "models.yaml"), MODELS);

  const app = new App();
  app.plugin(memory);
  // 引擎插件随启动加载：此测试环境里 boot 后加载的插件服务不会进入可用状态。
  for (const plugin of options.plugins ?? []) app.plugin(plugin as never);
  app.plugin(Ishiki, {
    dataPath,
    dumpRequests: false,
    debugStream: false,
    logLevel: 0,
    commands: options.commands ?? { enable: true, authority: 3 },
  });
  await app.start();

  for (const user of options.users ?? []) {
    // koishi 经 binding 表把 platform:userId 关联到数字用户 id，必须走 createUser。
    await app.database.createUser("test", user.id, { flag: 0, authority: user.authority });
  }

  const host = app.get("ishiki") as Ishiki;
  const bot = new TestBot(app as unknown as Context);

  // 真实 koishi（cordis 4）经 Context.associate 把 KoishiSession 的方法按 receiver 分发到
  // satori Session 上；vitest 的 koishi 别名解析到 cordis 3，没有这一步。这里把 KoishiSession
  // 原型的全部方法与访问器嫁接到真实 satori Session 实例，等价于正式运行时的分发结果。
  const template = Object.getPrototypeOf((app.get("koishi") as unknown as { session: object }).session);
  const graft = (session: Session): Session => {
    for (const name of Object.getOwnPropertyNames(template)) {
      if (name === "constructor") continue;
      Object.defineProperty(session, name, Object.getOwnPropertyDescriptor(template, name)!);
    }
    return session;
  };

  const session = (userId: string, channelId = "room1", content = ""): Session => {
    const created = graft(
      bot.session({
        type: "message-created",
        platform: "test",
        selfId: "10001",
        channelId,
        userId,
        user: { id: userId, name: userId },
        channel: { id: channelId, type: "direct" },
        timestamp: Date.now(),
      } as never) as unknown as Session,
    );
    // content 的 setter 会把文本解析进 event.message.elements，prompt 与指令解析都读它。
    if (content.length > 0) created.content = content;
    return created;
  };

  return {
    app,
    host,
    bot,
    dataPath,
    outputs: () => bot.sent,
    session,
    message: async (userId, content, channelId) => {
      // 走真实 dispatch 链路（message 事件 → 中间件链），指令消息在链上被识别并跳过路由。
      await app.emit("message", session(userId, channelId, content));
    },
    reply: async (userId, content, channelId) => {
      await app.emit("message", session(userId, channelId, content));
    },
    stop: async () => {
      await app.stop();
      await rm(dataPath, { recursive: true, force: true });
    },
  };
}

export async function writeProfile(dataPath: string, id: string, config: Record<string, unknown>): Promise<string> {
  const root = path.join(dataPath, "profiles", id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "profile.yml"), stringify(config));
  return root;
}

export const lastOutput = (setup: TestSetup): string => {
  const outputs = setup.outputs();
  return outputs[outputs.length - 1] ?? "";
};
