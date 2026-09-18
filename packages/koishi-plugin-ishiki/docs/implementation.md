# koishi-plugin-ishiki 实现规格

> 状态：进行中。行为规格见 [`design.md`](./design.md)（下称 §n）；本文只讲**代码怎么落**：目录、类型、算法、装配、事务、测试面。
>
> 底座：`@yesimagent/core`。本文引用的内核行号以当前 `yesimagent/packages/core/src/*.ts` 为准。

---

## 1. 现状与改造面

第一版 `src/` 只有 `index.ts` / `tools.ts` / `types.ts`；下面这张表记录的就是从那一版切到现在的改动（**已完成**）。今天的 `src/` 见 §2。

| 现有                                                       | 处理                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ishiki.Config.{dataPath, selfId, innerThought, logLevel}` | 拆成**插件级**（`dataPath` 基础目录、`profilesFile`、`logLevel`）与**profile 级**（design.md §11.2 全部）。`selfId` 删除——身体集合由 profile 的 `allowedChannels` 派生（§4） |
| 单个 `this.cortex: Agent`                                  | 改为 `Map<profileId, ProfileRuntime>`；`ready` 时按 `profiles.yaml` 逐个装配                                                                                                 |
| `session.selfId !== config.selfId` 过滤                    | 改为「该 sid 是否出现在某个 profile 的 `allowedChannels` 里」+「频道是否在该 sid 的白名单内」（§4）                                                                          |
| `createFormatMessagePlugin`（无条件投影）                  | **删除**。渲染全部交给 fold（§6）                                                                                                                                            |
| `toolsContext: { send_message: { ctx, selfId } }`          | 改为 per-profile 的**窄接口**（§7.0）                                                                                                                                        |
| `prepareStep` 强制 `toolChoice`                            | **删除**（会 400）。改为事后校验 + 一次重试（§8.3）                                                                                                                          |
| `toolChoiceViolation: "fallback"`                          | **删除**（不指定 `toolChoice` 后成为死配置）                                                                                                                                 |
| `createSendMessageTool` 的 `channel` 必填                  | 改为 tier 门控的可选 target（§7.1）                                                                                                                                          |
| `AgentCustomMessage` 只有两个事实类型                      | 扩为事实 + 渲染两组（§3）                                                                                                                                                    |
| `ishiki.checkpoint` 声明在 `AgentCustomMessage`            | **移到 `AgentCustomEntry`**（已经是），并补 payload（§3.3）                                                                                                                  |

一条来自内核的事实决定了整个渲染方案：**非 `message` 类型的 entry 在投影时被直接滤掉**（`agent.ts:172`），而 `toModelMessages` 只被调用一次且只拿得到单条消息（`plugin.ts:40`）。所以边界条目只能是 entry（不可见），形态只能由能看到整个流的 hook 决定。

## 2. 目录结构

```
src/
  index.ts                 插件入口：Schema、ready 装配、models.yaml / profiles.yaml 读取、session 分发
  runtime.ts               ProfileRuntime：运行期状态、投影、工具、落帧；纯函数在模块级（§6.1 的投影也在这里）
  profiles.ts              profiles.yaml 解析与校验、频道规则、resolveFocus
  types.ts                 declare module 扩展：事实 / 边界 / 独白
  debug.ts                 原始请求与响应的 dump（dumpRequests）
```

曾经规划过的 `scope.ts` / `entities.ts` / `facts/` / `fold/` / `tools/` / `lifecycle/` / `prompt/` **没有落地**：账号与频道规则在 `profiles.ts`，投影、工具与落帧都在 `runtime.ts`。切文件的判据见 §6.2.1 与 §7.0——按类型切文件会把还在变动的接口提前冻结，而"一个人的两个文件"并没有大到需要分。

## 3. 类型

### 3.1 事实（storage 里长期存在）

```ts
export namespace Fact {
  /**
   * 场景身份 = **身体 + 频道**。`channelId` 的语义域是 `selfId`（同一平台下不同身体的频道 id 可比；
   * 跨平台不可比），所以身体必须留在身份里。地址写作 `platform:selfId:channelId`。
   *
   * 「两具身体落在同一个频道」由**配置层静态拒绝**（§4），不靠去重兜底——跨适配器时
   * messageId 与 userId 的命名空间都不同，去重的输入本身不成立。
   */
  export interface Scene {
    platform: string; // onebot / qq / sandbox:xxx
    selfId: string; // 收消息的那具身体
    channelId: string;
    guildId?: string;
  }

  export interface MessageCreated extends Scene {
    content: string;
    userId: string; // 发送者（已在摄入层排除自己任何一具身体）
    messageId: string;
    timestamp: number;
    quote?: { id: string; content?: string };
  }

  export interface MessageDeleted extends Scene {
    messageId: string;
    operatorId?: string;
    timestamp: number;
  }

  /** 事件类（poke 等）。`target` 是摄入期解析出的事实，不是「这是 awareness」的标记。 */
  export interface Notice extends Scene {
    kind: string; // poke | member-added | …
    actorId?: string;
    targetIds?: string[]; // 指向谁（可能为空 = 不可判 → fail-closed）
    timestamp: number;
    detail?: Record<string, unknown>;
  }

  /** 切换事实：由 switch_focus 写入，是 fold 换挡与边界切分的依据。 */
  export interface FocusChanged {
    from: Scene;
    to: Scene;
    timestamp: number;
    reason?: string;
  }

  /** step 0 未产出工具调用时的重试提示；随流保留（§8.1）。 */
  export interface Nudge {
    reason: string;
    timestamp: number;
  }
}
```

事实里**没有**「awareness / focus」这类形态字段，也没有 `mentions`（§11.3）。`targetIds` 只记「谁指向谁」。

### 3.2 投影产物：原生消息，不落盘

投影直接产出 `AgentMessage`（`user` / `assistant` / `tool`），**没有渲染 type 这一层**：

| 产物                | 形态                                    | 来源                       |
| ------------------- | --------------------------------------- | -------------------------- |
| 帧                  | 一条 `user`，正文 = payload 里的 `text` | 落帧时写入的字符串，直接读 |
| 位置声明            | 一条 `user`，正文 = `<frame …/>`        | 无边界时由投影派生         |
| 裸行 / awareness 块 | 一条 `user`，正文 = 行或块              | 事实条目                   |
| 心智自己的话        | 一条 `assistant`                        | `ishiki.inner.thought`     |

原设计里的 `ishiki.render.*` 四种渲染类型已随"投影只用一个 hook"一起取消（§6）。

### 3.3 名字：随事实快照，不做实体表

事实自带 `user: { id, name? }` 与 `channel: { id, name?, direct }`，取值就是摄入那一刻的 `session.author?.name` / `session.event?.channel?.name`。没有 `entities.jsonl`，没有 upsert，没有渲染期解析。

- 好处：前缀稳定白送——改名只影响此后新摄入的事实，旧行永远是当时看到的名字。
- 代价：同一个频道名在每行事实里各存一份；改名**不回溯**，也不打算回溯。
- 缺名回退到 id（fail-soft）。

### 3.4 边界（entry）

```ts
export interface Checkpoint {
  frameFocus: Focus; // 本代起点（身体 + 频道）
  prevFocus?: Focus; // 上一代起点；仅当本代发生切换
  text: string; // 已渲染的帧文本：生成一次，之后每个 step 只读这一份
  createdAt: number;
}

export interface FocusChanged {
  previous: Focus;
  next: Focus;
  reason?: string;
}
```

- `AgentCustomEntry` 加两个键：`ishiki.checkpoint`（帧）与 `ishiki.focus.changed`（切换记录）。它们是 entry 不是 message——投影时不会被当成一条消息直接放行。
- `AgentCustomMessage` 加三个键：`ishiki.message.created` / `ishiki.message.deleted` / `ishiki.inner.thought`，另有 onebot 的 `onebot.guild.member-added`。规划中的 `ishiki.notice` / `ishiki.nudge` 未实现。
- payload 里**没有 LLM 摘要字段**：v1 只有机械剪枝，摘要是以后的事（design.md §4）。

## 4. scope：装配期派生

```ts
type ChannelRule =
  | { kind: "exact"; channelId: string }
  | { kind: "all" } // `kind:*`
  | { kind: "not"; rule: ChannelRule }; // `!` 前缀（只允许出现在列表项）
```

```ts
interface Scope {
  bodies: readonly string[]; // `platform:selfId`
  rules: ReadonlyMap<string, ChannelRule[]>; // sid → 该身体允许的频道
  bodyCount: number;
  /** 单场景：恰好一具身体，且它的规则是唯一的 exact（无 `*`、无 `!`）。 */
  singleScene: boolean;
  multiBody: boolean; // bodies.length > 1        → 提供 sid 参数
  multiChannel: boolean; // 任一 sid 能命中多个频道 → 提供 channel 参数
}
```

派生公式（与 §7 的 tier 表一一对应）：

```
singleScene  = bodies.length === 1 && rules.get(bodies[0]) 恰好是 [{kind:"exact", …}]
multiBody    = bodies.length > 1
multiChannel = 存在 sid 使 allows(sid, ·) 能命中 >1 个频道（family pattern 视为真）
```

**这个公式成立，靠的是下面两条静态校验**——校验保证了「多身体 ⇒ 频道集合两两不相交」，于是每个身体各自占住自己的场景，场景数就是 `Σ 每个 body 的频道数`，不会出现"两具身体在同一个频道"这种公式算不对的形态。

### 4.1 加载期静态校验（拒绝启动）

**先按参与方数量区分场景形态**——这是判定规则的前提：

| 形态                  | kind                               | 重叠时意味着什么                                                                                               | 是否校验重叠               |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **两方**（私聊）      | `private`                          | 同一个字符串 `private:U` 在两具身体下是**两段不同的对话**（U 私聊 A ≠ U 私聊 B），且只有一具身体会收到那条消息 | **豁免**（不存在重复投递） |
| **多方**（群 / 频道） | 其余 kind（`group` / `guild` / …） | 同名 = 同一个群 = 同一句话被两具身体各投递一次                                                                 | **校验**                   |

> 已知边界：v1 只把 `private` 认作两方 kind。若某个适配器用别的名字表示私聊（如 `direct`），它会被当成多方、从而可能误拒合法配置——这是配置可见的表象，将来用 `twoPartyKinds` 之类的配置项扩展，不预先猜。

三条校验，都在 `ready` 装配时算，失败即抛错、拒绝启动：

| 校验                       | 规则                                                                                                      | 依据                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **同 profile 内身体互斥**  | 同一 platform 下，任意两具身体的**多方场景**集合必须不相交（两方场景豁免）                                | 两具身体落在同一个群里 = 同一句人话被同一心智摄入两次。同平台下频道 id 可比，所以判得出来；跨平台部分见 §4.2                             |
| **跨 profile 同 sid 互斥** | 同一 sid 出现在两个及以上 profile 时，它们在该 sid 上的**全部**场景集合必须不相交（**两方场景同样校验**） | 这条的目的不是防重复投递，而是**所有权划分**：同一句人话不该被两个心智都当成自己的输入，否则两个心智都会回应。两方场景在这里没有豁免理由 |
| **不同平台不比较**         | 不同 `platform` 的频道 id 属于不同命名空间，无法比较，也不比较                                            | `857518324` 在 onebot 与 qq 下是两个不同的东西                                                                                           |

规则语言只有 `exact` / `*` / `!` 三种，相交判定三条即可：两个 `*` 在无 `!` 时相交；`*` 与 `exact` 用成员判定（含 `!` 否定）；不同 kind 天然不相交。判定在**平台内**做，不需要枚举运行期频道。

### 4.2 不可静态判定的残余：同一个群被两路接入

一条要记清的事实：`onebot:1434974784` 与 `qq:4138444372060156334` **不是同一个 QQ**。前者是**民间协议**（OneBot 实现，以用户账号登录），后者是**官方 Bot**（官方接口，bot 账号）——两条完全不同的出口，各自有独立的 id 命名空间。样本里就能看到差别：onebot 的 `channel.id = 857518324`，官方 qq 的 `channel.id = BC1E3F68…`。

于是残余风险不是"同一具身体被接入两次"，而是：**同一个群同时被一路 OneBot 身体和一路官方 Bot 身体覆盖**。此时同一个群在两路下的频道 id 不同、用户 id 也不同（官方 Bot 用的是 openid 一类的不透明 id），所以：

- 静态判不出来（命名空间不同，字符串不可比）；
- 运行时也**去重不了**——两条投递除了时间相近，没有任何可靠的可比字段。

后果是同一场对话以两个场景、两套身份命名空间进入同一个心智的流。

**v1 的取向**：承认不可判定，允许一个 profile 混用多平台，只做同平台的不相交校验；另加一条**运行时告警**兜底——实体表里两个不同场景的**频道名相同**（且都是群）时打 `WARN`，提示可能是同一群被两路接入。这是启发式，不是判定：只提示、不拒绝、不改行为。三条更彻底的收紧方式见 §12.1。

### 4.3 身体集合的来源：`allowedChannels` 是唯一声明点

配置里**没有** `bots` 字段。一具身体的存在 ⇔ 它在 `allowedChannels` 里有条目且至少一个频道：

- 一具没有任何允许频道的身体是没用的（不能摄入、不能响应、不能被 `switch_focus` 选中），所以"声明一具身体"和"声明它在哪运行"本来就是同一件事。
- 两个声明点必须保持同步，而它们一旦不同步就会出现幽灵身体或漏掉的归属。派生量只留一个来源。

代价与配套：

1. **附带校验**：`allowedChannels` 里的 sid 在 `ctx.bots` 里找不到 → `ready` 时 `WARN`（不抛错，适配器可能稍后才连上）。这条把 sid 拼写错误从"静默不工作"变成可见。
2. **多身体必须真的多平台或多频道**：如果两具身体只有重叠的频道集合，会被 §4.1 拒绝；所以"多身体"在实践中必然意味着"多频道或跨平台"。
3. `bodies` 同时用于：摄取的 `selfId` 匹配、self-skip（"自己人"的发言不摄入）、`atSelf` 判定、以及 §7.1 的 `sid` 参数门控。它们现在都引用同一个集合。

## 5. 摄入层

```ts
ctx.on("internal/session", (session: Session) => {
  for (const runtime of this.runtimes) {
    const sid = `${session.platform}:${session.selfId}`;
    if (!runtime.scope.bodies.includes(sid)) continue; // 这具身体不归我
    const fact = projectFact(session, runtime); // §5.2
    if (!fact) continue; // 未知类型 / 自己发的
    if (!allows(runtime.scope, sid, fact.channelId)) continue; // 身体 + 频道都在白名单内
    runtime.entities.upsert(session); // 记住名字（§3.3）
    runtime.agent.send(fact, { trigger: hits(runtime, session, fact), ifBusy: "join" });
  }
});
```

- `projectFact` 内部先做 **self-skip**：`scope.bodies.includes(`${session.platform}:${session.userId}`)` → 返回 `undefined`（§4）。无论哪具身体听到，自己人的发言都不摄入。
- 白名单判定是「身体 + 频道」两个条件同时成立（`allows(scope, sid, channelId)`）：身体决定这具 bot 是否归我，频道决定它是否被允许在那里运行。二者都来自同一条 `allowedChannels` 声明。
- 频道白名单与唤醒判定分开：白名单决定**是否接管**，`hits` 决定**是否触发** turn（design.md §6 的两套谓词）。
- `ifBusy: "join"` 保留：中途到达的消息作为 step delta 进入当前 turn；其落盘时机由内核改动固定在 step 边界（§6.4 / §11）。
- **不需要去重**：「两具身体落在同一个频道」由 §4.1 的静态校验拒绝，所以同一个场景不会被两个身体各投递一次。
- **实体表 upsert**：把 `(platform, userId) → nickname`、`(platform, channelId) → channelName` 写进全局实体表（§3.3）。与是否触发 turn 无关，也不参与白名单判定。upsert 失败只记日志，不影响摄入。
- **外部 bot 不特殊化**：别的心智的 bot 就是普通用户，不查名单、不识别、不抑制（用户已明确）。可能出现的"两个 bot 互相对话"不是漏洞：触发谓词（私聊 / @我 / 关键词）本身就是闸门。

### 5.1 投影分派：一个 switch，不建注册表

分派是**普通的 `switch (session.type)`**，每个 case 一个纯函数 `(session, bodies) => Fact | undefined`；unknown → `undefined`（fail-closed，只档案不渲染）。**v1 与 T12 都不引入注册表**，理由与 fold 侧相同（§6.2.1）：真实 session 类型集合还在变动，按类型切「处理器」会把接口形状提前冻结；扩展点等「外部插件要注册事实类型」这条需求成真时再评估。

v1 至少覆盖：

| session                                         | 事实                  | 备注                                                                                           |
| ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `message-created`                               | `Fact.MessageCreated` | `quote` 只取 `{id, content}`；onebot / qq / sandbox / qqguild 同属这一类                       |
| `message-deleted`                               | `Fact.MessageDeleted` | 指向性不可判 → 只填能确定的字段                                                                |
| `notice/*`（poke 等）                           | `Fact.Notice`         | 指向性从 adapter 私有 payload 解析（`_data.target_id`）；判不出就**不带 `targetIds`**          |
| `qq/group-at-message-create`（`type=internal`） | `Fact.MessageCreated` | 必须把「@ 了谁」文本化进 `content`，并补齐 `channelId`/`messageId`（`_data` 里没有提升的字段） |
| `login-*` / `ready` / `resumed`                 | 无                    | 自己身体的状态，v1 只档案（不走事实通道）                                                      |

**框架隔离**：`session` 的形状由本地的结构化类型声明（只列用到的字段），不 import `koishi`——它的主入口会拉入 CLI/loader 运行时，测试跑不起来（Task 11 执行记录）。平台分支只允许出现在这里，下游不得再判断平台。

### 5.2 唤醒谓词

```ts
function hits(runtime, session, fact): boolean {
  for (const rule of runtime.config.wakeOn) {
    if (rule === "direct" && session.isDirect) return true;
    if (rule === "atSelf" && mentionsAny(fact.content, runtime.scope.bodies)) return true;
    if (rule === "keyword" && runtime.config.keywords.some((k) => fact.content.includes(k))) return true;
  }
  return false;
}
```

`mentionsAny` 用 `h.parse(content)` 取 `type === "at"` 的元素 id，无需平台分支（§11.3）。`wakeOn` 里没有 `"quote"`：事实没有 quote 发送者。

## 6. fold：一个 hook

### 6.0 不变式

1. **只读 entry 流 + 配置**：投影的全部输入就是流与 profile；昵称 / 频道名随事实快照（§3.3），不需要任何外挂字典。
2. **前缀稳定**：同一条流重跑两次产出逐字节相同；新条目只延长最后一个块。
3. **形态一次性**：条目形态由它在流中的位置（cursor）决定，与「现在几点」无关。

### 6.1 `transformEntries`：分段 + 帧 + 本代投影

```ts
function transformEntries(entries: readonly AgentEntry[], profile: Profile): AgentEntry[] {
  const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
  const workspace = workspaceOf(entries); // 边界之后（或全部）的条目
  const out: AgentEntry[] = [];
  if (checkpoint !== undefined)
    out.push(frameMessage(checkpoint)); // 帧文本整条投影
  else {
    const head = positionEntry(profile, workspace); // 无边界时的位置声明，见 03-context.md
    if (head !== undefined) out.push(head);
  }

  let cursor = checkpoint === undefined ? profile.initialFocus : checkpoint.data.frameFocus;
  for (const entry of workspace) {
    if (entry.type === "ishiki.focus.changed") {
      cursor = { ...entry.data.next };
      out.push(textMessage(changeLine(entry.data))); // [focus change] 行
      continue;
    }
    if (entry.type !== "message") continue;
    if (entry.data.role !== "custom") {
      out.push(entry); // assistant / tool / user 原样通过
      continue;
    }
    if (entry.data.type === "ishiki.inner.thought") {
      out.push(assistantMessage(entry)); // 心智自己的话
      continue;
    }
    const line = entry.data.type === "ishiki.message.created" ? createdBlock(profile, cursor, entry.data.data) : deletedBlock(profile, cursor, entry.data.data);
    if (line !== undefined) out.push(textMessage(line)); // 裸行或 awareness 块
  }
  return out;
}
```

帧文本由 `frameTextFor(frameFocus, previousFrameFocus, workspace)` 在**落帧那一刻**生成并写进 payload，之后每个 step 只读取这份字符串：

```
frame 文本 = <frame at sid channel name>
           + [<last_focus_history> 段]   cursor = prevFocus（仅发生过切换）
           + [<history> 段]             cursor = frameFocus
```

两段共用 `renderEntries(entries, cursor, …)`，只是 cursor 不同。切换事实归**离开的那一块**，即位于前段尾；因为一代只允许切一次（design.md §4 冷却），每段内 cursor 恒定，帧里不需要推进 cursor。

没有边界时（旧流或开局帧写入失败）：位置声明由**投影自己**给出，只用该代首条 entry 与 `initialFocus`，因此同一 turn 的每个 step 渲染出同一串——这正是"不物化也能前缀稳定"的那条路。

### 6.2 形态判定与成行

```ts
function createdBlock(profile: Profile, cursor: Focus, fact: IshikiEvent.MessageCreated): string | undefined {
  if (sceneKeyOf(fact) === focusKey(cursor)) return lineOf(fact); // 裸行：位置声明已写明焦点
  return reachesMind(profile, fact) ? awarenessBlock(sidOf(fact), fact.channel, [lineOf(fact)]) : undefined; // 别处够得着
}
```

| 条目             | 落在 cursor 的场景里                                | 别处                                                |
| ---------------- | --------------------------------------------------- | --------------------------------------------------- |
| `MessageCreated` | 裸行（一段的首行带一次 `<focus sid channel>` 块头） | 命中私聊 / 提及 / 关键词 → awareness 块；否则不渲染 |
| `MessageDeleted` | 同上（`#id: (已撤回)`）                             | `operatorId ∈ bodies` → awareness 块；否则不渲染    |

`reachesMind` 与唤醒谓词同源（design.md §6），所以叫醒本轮的那条事实不会在轮内不可见。awareness 块头只写 `sid` / `channel` / `name`，**不写触发原因**：模型只需要知道"这条不在焦点里"。

尚未实现（v1 未做，决定仍成立）：`Notice` / `Nudge` 事实、run-length 分块（§6.3）、tier 降级。

### 6.2.1 事实类型的知识由 switch 持有（v1 决定）

`transformEntries` 的分支链是**唯一**列举事实类型的地方（`types.ts` 的 `declare module` 除外）。共享的只有值工具（`sceneKeyOf` 判场景同一性、`focusKey` 取场景、`reachesMind` 判提及 / 关键词 / 私聊），不共享类型判别式。

- **为什么不建「类型 → 处理器」注册表**：v1 的类型集合仍在变动（规划中的 poke / 成员变动 / 撤回等），此时按类型切文件会把接口形状提前冻结；而 switch 的代价（加类型时改这一处）在规模上可以接受。**这是显式决定，不是遗漏。**
- **重新评估的时机**：真实类型集合稳定之后。触发条件是「外部插件需要注册事实类型」这条需求成真，而不是「这里有个 switch」。
- **已经确立的边界（不因这个决定改变）**：投影出的形态是封闭的四种（帧 / 位置声明 / 裸行 / awareness 块，加上心智自己的话）；插件若将来能注册事实类型，只能选择其中一种，不能定义新形态。

### 6.3 分块

**块格式**（当前实现，一条事实一条消息）：

```xml
[21:40] Alice(1434974784) #a1b2: 内容…
[21:41] Bob(998877) #c3d4: 内容…

<awareness sid="onebot:1434974784" channel="123456" name="闲聊群">
[21:42] Carol(555) #e5f6: 内容…
</awareness>
```

- **焦点内的事件没有块头**：位置声明（帧的 `<frame …>` 或投影自给的 `<frame …/>`）已经写明焦点，所以只有**别处**的事件需要边界。
- **awareness 块头属性**：`sid`（身体）、`channel`（该身体命名空间下的频道 id）、`name`（可读频道名，来自事实快照，缺则省略）。身体属于场景身份（§3.1 的注释解释了为什么），所以块头必须带它。**不写触发原因**——模型只需要知道"这条不在焦点里"。
- **行**：`[HH:MM] 名(userId) #msgId: 正文`。**每行恒带 `msgId`**——`quote id=` 需要它，而"哪条会被引用"无法预知。名随事实快照，缺则只写 id。
- **未实现**：run-length 合块（`mergeBlocks` / `block.gapMinutes`）与 tier 降级；当前也没有实体表可查（名字就在事实里）。

**配对完整性是结构性的，不靠 fold 兜底**。改动后（§11）条目只有三个落盘点，三者都不会把 `user` 形态的渲染块插进 `assistant(tool-call)` 与其 `tool(result)` 之间：

| 落盘点                                      | 位置                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `runStep` 内部                              | assistant(tool-call) 与它的每个 tool(result) 相邻写入（`agent.ts:258-266` 与逐 call 的 persist） |
| session 摄入（join）                        | step 边界（§6.4）                                                                                |
| 插件写入（`onStepFinish` / `onTurnFinish`） | step 边界 / turn 边界                                                                            |

所以 fold 不需要缓冲规则，也不能随手插队——它只是在流顺序上做映射。

`FocusChange` 不参与合并（自带块），且是 cursor 换挡的唯一载体。

### 6.4 join 的时序：内核改动（已定）

`send(…, { ifBusy: "join" })` 的持久化在 `enqueue` 时立即启动（`agent.ts:459-464`），不等当前 step 结束；`storage.append` 只与其它 append 串行（`agent.ts:82-98`），所以一条中途到达的消息**可以**落在 assistant(tool-call) 与 tool(result) 之间。

**这个"立即"买不到任何可见性**：本 step 的 `collectModelMessages`（`agent.ts:170`）在模型调用之前就已经跑完了，之后无论怎么追加，最早也要等下一个 step 的 collect 才可能被看到——而"下一个 step 的 collect"正是 step 边界。所以立即落盘只带来配对破坏与剪枝歧义（工具调用与结果之间夹着一条 user 条目），不带来实时性。

**决定**：join 的持久化推迟到 step 边界（内核改动，见 §11）。join 要解决的实时性不受影响——step 边界就是可见性的下界。

`FocusChanged` 走同一条路：pending 切换不由 `afterToolCall` 立即落盘，而是在 `onStepFinish`（新增的内核钩子，§11.2）里落盘，`onTurnFinish` 兜底。于是它也不会夹在工具配对中间。

**顺序**：`drainJoined` 先于 `onStepFinish`，所以本 step 中途 join 的消息排在 `FocusChanged` **之前**——它们按切换前的 cursor 判形态（归为 awareness）。若要反过来（让它们算作新场景的消息），就得调整两个调用的先后；默认采用「先排空、后换挡」，因为切换是在这一步中途才决定的。

### 6.5 为什么没有 `toModelMessages`

投影直接输出**原生** `user` / `assistant` / `tool` 消息（帧与位置声明是 `user`，事实块是 `user`，心智自己的话是 `assistant`），所以 ishiki 不需要这一步转换，`toModelMessages` 也删掉了。它不适合当投影入口的理由仍然成立：first-win（第一个非 `undefined` 返回值结束分派，`[]` 也终止），且只拿得到单条消息，取不到 cursor。

## 7. 工具

### 7.0 依赖注入

**不引入依赖注入式包装**：没有 `interface ToolRuntime`，也没有 `create*Tool({ resolve, send, stop })` 工厂。工具在 `buildTools()` 里就地定义，闭包直接捕获 runtime——`execute` 里用 `this.currentFocus` / `this.profile` / `this.ctx.bots`，跨 step 待落盘的记录挂在 runtime 的 pending 字段上（`pendingFocus` / `pendingThoughts`）。

判据：出现只被实例化一次、字段全是函数的参数对象，或只有一个实现的 interface，就说明这一步走歪了。测试也不为可测性在生产代码里留缝——harness 用真实运行时加假的外部边界（假 `ctx.bots`、脚本化模型、临时存储）。

### 7.1 四个工具与 tier 变体

| 工具           | 参数                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `send_message` | `messages[]`、`channel`（必）；`mode`、`continue`、`sid`；`inner_thought` 仅在 `innerThought: true` 时存在 |
| `finish`       | `reason?`                                                                                                  |
| `switch_focus` | `channel`（必）；`sid`、`reason?`                                                                          |
| `peek_channel` | `channel`（必）；`sid`、`limit?`                                                                           |

**寻址规则**（三个带 target 的工具共用，`resolveFocus` 是唯一实现）。场景 = `(sid, channel)`：

| 参数      | 值                              | 省略时                    |
| --------- | ------------------------------- | ------------------------- |
| `sid`     | `${platform}:${selfId}`         | 取当前窗口所在的账号      |
| `channel` | 该 sid 命名空间下的 `channelId` | 取当前窗口（focus）的频道 |

- **省略 = 当前窗口**：`send_message` 默认发到 focus（省略 `sid` 与 `channel` 即可），这也是最常见的情形；只有往别的频道发、或换个账号发才写它们。
- **点了账号就要点频道**：频道 id 只在一具身体的命名空间里有意义，窗口的 `channelId` 属于窗口自己的账号，所以给了别的 `sid` 却不给 `channel` → `InvalidInput`（不静默套用窗口的频道）。
- 给了 `sid` 但该身体不在 `allowedChannels` 里 → `UnknownBody`；频道不在该身体白名单里 → `TargetNotAllowed`，错误信息附上可用项。
- **tier 降级尚未实现**：参数集合是固定的，不随场景数增删。已定的原则不变——**参数不存在时，schema 与 description 与稳定区同时不含它**（design.md §7 三处同进同退，`inner_thought` 现按此实现）。

### 7.2 `send_message`

- 解析 target → `(sid, channelId)`：两个参数都省略就是当前窗口（`resolveFocus` 的默认）；只给 `sid` 不给 `channel` → `InvalidInput`；解析失败一律结构化错误，不静默回退到窗口。
- 发消息：`ctx.bots[sid]`（Koishi 按 `platform:selfId` 索引）取到身体后逐条 `sendMessage(channelId, content)`。**不能用插件级固定 `selfId`**——一个心智可能有多具身体（§4）；身体不在 `ctx.bots` 里 → `BotNotFound`。
- `messages[]` 逐条发出，一条一项、按序、**不设条数上限**（拟人分句是人设的事，不是工具的事）。`mode: "raw"` 时先 `h.escape`，否则 Koishi 的 `h.normalize` 会把正文当元素解析。
- 结果只回 `{ ok: true, count }`：`messageIds` 没有任何消费方，`target` 只是把入参抄回去——而工具结果是**永久留在上下文前缀里**的内容。失败时保留原文：`{ ok: false, sent, failedAt, error: { name, message } }`，`name` 是模型能据以改正的东西（`BotNotFound` / `TargetNotAllowed` / `InvalidInput`）。
- `inner_thought`（仅 `innerThought: true` 时存在）攒进 `pendingThoughts`，在 step 边界落一条 `ishiki.inner.thought`，投影成心智自己的 `assistant` 文本；不进帧（帧只收行为与行为结果）。
- **结束 turn 由 `onStepFinish` 决定**（§11.3）：本 step 调用了 `send_message` 成功且该调用 `continue !== true` → 结束；调用了 `finish` → 结束；`send_message` 失败或只调了 `switch_focus` / `peek_channel` → 不结束（沿用内核默认 `continue: true`，让模型继续）。
- 工具本身不返回 `endTurn`——内核在 §11.3 之后没有这个概念。

### 7.3 `switch_focus`

1. 解析 target → `(sid, channelId)`；必须是白名单内的场景，否则结构化错误。
2. 冷却：本代已有 `FocusChanged` 事实 → 结构化错误（「一代只允许切一次」，判据来自流，零额外状态；若配了 `focusSwitch.minIntervalMinutes` 再比边界时间戳）。
3. `setLogicalFocus(next, reason)` → 记录 **pending**，不结束 turn（否则切完无人唤醒，handoff 会停住）。
4. pending 在 **`onStepFinish`** 落盘为 `Fact.FocusChanged`（§6.4 的顺序说明）；`onTurnFinish` 里再兜底一次（最后一步由 onStepFinish 处理后 pending 已空）。落盘失败时不丢 pending，下次边界重试。
5. 结果：`{ ok: true, sid, channel }`。

### 7.4 `peek_channel`

读 `readEntries()`，按目标场景过滤事实条目，取最近 `limit` 条（上限 `peek.maxLimit`），渲染成文本行返回。它是**原始旁路读取**：不渲染对方的帧（那需要重新分段），只给事实行。不改 focus、不触发重建。

### 7.5 `finish`

返回 `{ ok: true }`。`onStepFinish` 见到它即结束 turn（§11.3，不靠工具返回值）。存在的唯一理由：让「什么都不做」成为显式决策；配合 §8.3 的兜底，模型没有「静默结束」这条路。

## 8. 生命周期

### 8.1 边界重建

`onTurnFinish` 里：

```ts
async function onTurnFinish(result: TurnResult) {
  await flushPendingSwitch(runtime); // 若 step 中未落盘
  const entries = await runtime.agent.storage.read();
  const focusChanged = hasFocusChangedInGeneration(entries);
  if (!focusChanged && !overBudget(entries, runtime.config)) return;
  await rebuild(runtime); // 串行化：runtime.rebuilding 链
}
```

- `overBudget`：**只累计最后一条 `ishiki.checkpoint` 之后的条目**的字符数 ÷ `rebuild.charTokenRatio`（design.md §11.4），并且条目数 ≥ `rebuild.minEntries`。
- `rebuild`（事务，唯一物化写）：
  1. 取上一条边界 `b`、切分点，得到两段 + 上一版 `summary`；
  2. 调 `compactionModel ?? model` 压缩（`generateText`，来自 core 的重导出），输出 ≤ `compaction.maxTokens`；
  3. `append(createEntry("ishiki.checkpoint", { frameFocus, prevFocus, summary, createdAt }))`。
- 失败处理：压缩失败或 append 失败 → **不写边界**，本代保留，下次触发重试。必须自己 `catch` + `log`——`onTurnFinish` 的异常被内核吞掉（`agent.ts:326-332`）。
- 冷启动不需要重建：帧本来就由 fold 派生（§4）。
- 空闲触发：计时器在 `agent.isIdle()` ∧ 本代有新条目 ∧ 静默超 `idle.rebuildMinutes` 时调用同一个 `rebuild`（提前压缩）。同一条 `runtime.rebuilding` 链保证不与 turn 结束的重建并发。

### 8.2 归档轮转

触发：`onTurnFinish` / 空闲检查时，`messages.jsonl` 字节数 > `archive.maxKB`；或人工命令（`ishiki.archive`）。

1. 空文件（无边界且无条目）→ 跳过。
2. 压缩：**先尝试 LLM**（输入 = 上一版 summary + 整个文件的可渲染内容剪枝后的结果，输出概括全部）；失败 → **机械压缩**：取当前 fold 渲染出的**帧文本**作为快照，`mechanical: true`（§8.2 的「上轮 frame 作为文本快照」——注意只取帧，不含 body，否则 body 会重复出现）。
3. 轮转：`rename(messages.jsonl → archive/messages-<ts>.jsonl)`，然后按路径 `append` 新的边界条目（`appendFile` 会创建目录与文件）。
4. **产物形状按路径分叉**：
   - LLM 成功 → 新文件只有 `[compact]`；归档时刻的当前代内容由摘要承接。
   - 机械回退 → 新文件 = `[compact]` **+ 当前代的 body 条目原样搬入**：上下文完全不变，只削掉帧之前的历史。
5. 全程只在 `agent.isIdle()` 时执行，且与 `rebuild` 共用串行化链——轮转期间的 append 必须与内核的 `storageTail` 串行（`agent.ts:82-98`），因此轮转不进 `storage.append` 而用 `fs.rename` 时，要先确认 `isIdle()`。

对齐 YesImBot 的既有语义：空会话拒绝归档；有 summary 时新文件以 compact 开头；`no-summary` 是显式选项。

### 8.3 step 0 未产出工具调用的兜底

`onTurnFinish` 里：

```ts
if (result.status === "done" && !result.messages.some((m) => m.role === "tool")) {
  if (runtime.nudgedLast) { logger.warn(...); runtime.nudgedLast = false; }   // 只重试一次
  else {
    runtime.nudgedLast = true;
    runtime.agent.send(createCustomMessage("ishiki.nudge", { reason, timestamp: Date.now() }),
                       { trigger: true, ifBusy: "defer" });                   // 必须 defer
  }
}
```

- `ifBusy` 必须是 `"defer"`：`"reject"` 会抛 `AgentBusyError`（`turn.ts:75`）而插件异常被内核吞掉；`"join"` 会把消息塞进正在收尾的 turn（`turn.ts:143-188`），只在下一次 `drainJoined` 被读，而那时已经 `result` 收尾 → **静默丢失**。
- 零工具调用必然结束 turn（`agent.ts:316` 的 `continue` 定义），所以「重试」只能开新 turn，无法在同 turn 内续跑。
- 重试请求的 instructions + 帧 + 工作区逐字节不变，nudge 只追加在尾部 → 前缀缓存全命中。
- `send` 只能在 `onTurnFinish` 内安全调用（`turn.ts:139` 的 `void this.pump()` 会在 `runTurn` 返回后继续排空队列）。
- 排队 nudge 时**跳过本次重建**：零工具调用的 turn 不可能发生切换（切换本身是工具调用），而重建会白付一次压缩 LLM 调用；重试的 turn 结束时会再判一次。

## 9. 参数解析

- 插件级：`dataPath`（基础目录，含 `models.yaml` 与 `profiles.yaml`）、`profilesFile`、`logLevel`（design.md §11.1）。
- profile 级字段名与默认值见 `design.md` §11.2；`rebuild.tokens` 的缺省值在装配期算：`gateway.model(profile.model)?.metadata.contextWindow`（`gateway/src/types.ts` 的 `LanguageModelConfig.contextWindow`）→ `× 0.6`，拿不到时用 `rebuild.contextTokens`。
- `compactionModel` 缺省 = `model`；`dataPath` 缺省 = `<基础目录>/<profile.id>`。

## 10. 测试面与验证

纯函数优先，测试只覆盖确定性行为（不写"有测试"的填充）：

| 目标                                       | 用例要点                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` 派生                               | 单场景 / 多频道 / 多身体三档；`private:*` 视为家族；不相交校验的三种相交情形（`*`×`*`、`*`×`exact`、不同 kind）                                                                                                                        |
| 静态校验                                   | 同 profile 内同平台两具身体的**多方**场景相交 → 抛错；**两方（private）豁免**；跨 profile 同 sid 的**全部**场景相交 → 抛错（含 private）；不同平台不比较                                                                               |
| 寻址解析                                   | `channel` 省略且该身体只有一个频道 → 取它；该身体有多个频道且未给 `channel` → 结构化错误；`sid` 省略取 focus 的身体                                                                                                                    |
| `fold` 分段                                | 有切换 / 无切换 / 冷启动；`last_focus_history` 与 `hist` 的切分点                                                                                                                                                                      |
| `decide`                                   | 同场景恒可见；非焦点仅 `hits` 变 awareness；`Notice` 无 `targetIds` → drop                                                                                                                                                             |
| `mergeBlocks`                              | run-length 合并、跳块阈值、新块只在尾部追加（前缀逐字节不变）                                                                                                                                                                          |
| 内核 step 边界（`@yesimagent/core/tests`） | join 的消息不在本 step 的 storage 里、在下一 step 的 collect 里；最后一步 join 的消息在 turn 结束后仍在 storage 里；`onStepFinish` 每 step 恰一次（含最后一步）；`onStepFinish` 的 `continue: false` 能结束 turn、返回 void 时沿用默认 |
| 前缀稳定                                   | 同一条流两次投影逐字节相同；追加一条条目后旧块不变                                                                                                                                                                                     |

验证命令（仓库现有）：`bun run lint`、`bun run format:check`、`bun run build`、`bun run test`（yakumo vitest）。

## 11. 内核改动（`@yesimagent/core`）

三处：11.1 / 11.2 来自 §6.4 的决定（**条目只在 step / turn 边界落盘**），11.3 把 turn 的结束决定从工具结果移到 step 边界。

### 11.1 join 的持久化推迟到 step 边界

现状（`agent.ts:459-464`，`turn.ts:202-225`）：`addJoined` 收一个**已经启动**的 `Promise<void>`，`drainJoined` 只 await 它，所以写入时机由 `send()` 决定（立即）。

改动：

```ts
// turn.ts — TurnRequest
addJoined(messages: AgentMessage[], persist?: () => Promise<void>): void;

// turn.ts — createQueuedTurn：pending 存 thunk，drain 时才执行
addJoined(nextMessages, persist) {
  joined.push(...nextMessages);
  if (persist) pending.push(persist);
},
async drainJoined() {
  await Promise.all(pending.splice(0).map((run) => run()));
  return joined.splice(0);
},
```

```ts
// turn.ts — runTurn：循环结束后补一次排空
// 最后一步期间 join 进来的消息没有"下一个 step"去消费它，必须在这里落盘，否则丢失。
// 排空只做持久化，不进本 turn 的 allMessages（它不是本 turn 的对话内容）。
await request.drainJoined();
```

```ts
// agent.ts — send："join" 分支传 thunk 而非已启动的 promise
if (behavior === "join" && activeTurnId) {
  return queue.enqueue([message], "join", () =>
    ensureInit()
      .then(() => persistMessages([message], activeTurnId))
      .then(() => undefined),
  );
}
```

三条依据：

1. **可见性零损失**：本 step 的 collect 早于本 step 的一切 tool 执行（`agent.ts:170`），所以「立即落盘」不会让本 step 看到它；可见性的下界本来就是 step 边界。
2. **重复落盘无害**：`persistMessages` 用对象身份的 WeakMap 去重（`agent.ts:149-165`），同一条消息在 `drainJoined` 与下一步 `runStep` 顶部各写一次，第二次是 no-op。
3. **不会丢**：`drainJoined` 在循环内的调用点只在 `continue === true` 时到达（`turn.ts:162-164`），所以必须补 §runTurn 末尾那一次排空。

验收（`yesimagent/packages/core/tests/`）：新增一个回归用例——工具执行期间 `send(msg, { join })`，断言该消息在**本 step 的 storage 里不存在**、且在**下一 step 的 collect 里存在**；再补一个「最后一步 join 的消息在 turn 结束后仍在 storage 里」的用例。两者改前均失败。

### 11.2 新增 `onStepFinish`

动机：插件需要「在 step 边界落盘自己的条目」的能力，而现有钩子里 `prepareStep` 在 `collectModelMessages` **之后**跑（`agent.ts:224-235`），拿不到"模型已经看过本 step"这个时机；`onTurnFinish` 只有 turn 边界。`FocusChanged` 必须落在配对闭合之后、且越早越好（下一步就要换挡），所以需要一个 step 边界钩子。

```ts
// plugin.ts
export interface StepFinishInfo {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly result: TurnStepResult; // 含 continue / finishReason / usage / messages
}
export interface AgentPlugin {
  // …与 onTurnFinish 同级：观察者，不得改变已完成的 step 结果
  onStepFinish?(info: StepFinishInfo): Awaitable<void>;
}
```

```ts
// turn.ts — TurnQueueOptions
onStepFinish?(info: StepFinishInfo): Promise<void> | void;
```

```ts
// turn.ts — runTurn：每 step 恰好一次（含最后一步），在 drainJoined 之后
const continues = result.continue;
const drained = await request.drainJoined();
await this.options.onStepFinish?.({ turnId: request.turnId, stepNumber, result });
if (!continues) break;
stepNumber += 1;
incoming = drained;
allMessages.push(...drained);
```

```ts
// agent.ts — 与 onTurnFinish 同构：逐插件调用，吞掉异常
onStepFinish: async (info) => {
  for (const plugin of plugins) {
    try {
      await plugin.onStepFinish?.(info);
    } catch {
      // A step observer must not change the completed step result.
    }
  }
},
```

要点：

1. **每 step 恰好一次**，包括 `continue === false` 的最后一步——否则最后一步里产生的插件条目要等到 turn 边界才落盘，且 join 的消息会丢。
2. **在 `drainJoined` 之后**：step 级的写入排在已到达的消息之后（§6.4 的顺序说明）。
3. **异常语义与 `onTurnFinish` 一致**：插件必须自己 `catch` + `log`。ishiki 的 pending 切换在落盘失败时保留 pending，等下一次边界重试（幂等）。
4. **不改 `AgentHooks`**：`onTurnFinish` 也不在其中（`agent.ts:326-332` 直接遍历 `plugins`），`onStepFinish` 照此办理。

验收：一个 turn 跑 2 个 step 时 `onStepFinish` 被调用 2 次、且都在该 step 的 tool 消息之后；`continue === false` 的最后一步也调用一次。

### 11.3 `endTurn` 从 `ToolResultInfo` 移到 `onStepFinish`

现状：`afterToolCall` 返回 `endTurn`，`runStep` 用「本 step 所有已执行调用都为 true」聚合（`agent.ts:283-315`）。问题有三：

1. **决定权在错的地方**：单个工具无法知道同一步里别的工具做了什么，却要对自己的"是否结束 turn"表态，再由内核用一条任意的聚合规则（全真才结束）拼起来。
2. **工具被迫懂策略**：`send_message` 的 `continue` 参数、`finish` 的存在，都是"结束 turn"这一策略的碎片，被摊在工具返回值里。
3. **看不到整步**：真正需要的信息是「这一步调了哪些工具、结果如何、`finishReason` 是什么」，只有 step 结束才齐备。

改动：

```ts
// tools.ts —— 两个 interface 去掉 endTurn
export interface ToolResultInfo extends ToolCallInfo {
  result: unknown;
  isError: boolean;
}
export interface ToolExecutionResult {
  result: unknown;
  isError: boolean;
}
// executeAgentTool 不再计算 endTurn；ToolDecision / beforeToolCall 不变
```

```ts
// agent.ts —— runStep 只算默认值：本 step 有工具调用就继续（全 invalid 也继续，让模型修输入）
continue: toolCalls.length > 0,
```

```ts
// plugin.ts —— step 级决定
export interface StepFinishDecision { continue?: boolean }
onStepFinish?(info: StepFinishInfo): Awaitable<StepFinishDecision | void>;
```

```ts
// turn.ts —— onStepFinish 的决定覆盖默认值；未决定则用默认
const decision = await this.options.onStepFinish?.({ turnId: request.turnId, stepNumber, result });
const continues = decision?.continue ?? result.continue;
const drained = await request.drainJoined();
if (!continues) break;
stepNumber += 1;
incoming = drained;
allMessages.push(...drained);
```

链式语义：**第一个返回决定的插件拥有决定权**（`chainFirst`，按 `enforce` 排序）。理由：这是一个策略决定，不是可叠加的变换；「最后一个赢」会让插件顺序含义反转，更难推理。其余插件仍可拿到同一个 `StepFinishInfo` 做观察。

于是 `onStepFinish` 的语义是「观察 + 可选的 step 级决定」：抛异常的插件按"未做决定"处理（沿用内核默认）并记录，不改变已完成的 step 结果。

ishiki 侧的落法（§7.2 / §7.5 更新）：一个 `onStepFinish` 里集中判定：

| 本 step 的情况                                         | `continue`                               |
| ------------------------------------------------------ | ---------------------------------------- |
| 调用了 `finish`（成功）                                | `false`                                  |
| 调用了 `send_message` 成功且该调用 `continue !== true` | `false`                                  |
| 调用了 `send_message` 失败                             | 默认（`true`）——让模型有机会修           |
| 只有 `switch_focus` / `peek_channel`                   | 默认（`true`）——换挡后仍要在新场景里行动 |
| 无工具调用                                             | 默认（`false`）——零调用本来就不继续      |

验收（core tests）：`send_message` 成功后 turn 结束；`send_message` 失败后 turn 继续；`finish` 结束；同一 step 里 `switch_focus` + `send_message`（`continue: true`）不结束。README 的「Turn termination is a plugin decision」段落要同步改写为 step 级。

## 12. 风险与待定

| 项                               | 说明                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内核改动的兼容面                 | ① `TurnRequest.addJoined` 的第二个参数由 `Promise<void>` 变 `() => Promise<void>`（调用点只有 `agent.ts` / `turn.ts`）；② `runTurn` 的循环体顺序调整（drain 提前到 break 之前）；③ 新增 `AgentPlugin.onStepFinish`；④ **`endTurn` 从 `ToolResultInfo` / `ToolExecutionResult` 移除**——`core/tests/agent.spec.ts:77,100,110` 与 `core/README.md:101,167-174` 要同步改写 |
| 边界不变量靠内核保证             | `onStepFinish` 只保证「回调发生在 step 边界」，不保证「插件不在别处 append」。ishiki 自己不在 `afterToolCall` / tool `execute` 里写条目，这条自律由 §11.2 的钩子替代了原本需要的 fold 兜底                                                                                                                                                                             |
| `FocusChange` 渲染成 `assistant` | 语义上属主心智自己的动作；若某 provider 对连续 assistant 敏感，退路是渲染成 `user`（此时它仍在 tool 结果之后，配对安全）                                                                                                                                                                                                                                               |
| `peek_channel` 的读取成本        | 每次 `storage.read()` 全量解析当前文件；与 fold 同阶。归档轮转把文件上限卡在 `archive.maxKB`，所以有界                                                                                                                                                                                                                                                                 |
| `logicalFocus` 的来源            | 运行期缓存（初值 = 最后一条边界的 `frameFocus`），由 `setLogicalFocus` 抢先更新；事实条目按 §7.3 延迟落盘。两者短暂不一致只影响「同一 step 内的切换 + 发送」，且 `send_message` 结果会回显目标                                                                                                                                                                         |
| 同一个群被两路接入               | OneBot（民间协议，用户账号）与官方 QQ Bot 是两条出口，同一个群在两路下频道 id 与用户 id 都不同 → 不可静态判定、也去重不了。v1 只做**同平台**不相交校验 + 「同名频道」启发式 `WARN`（§4.2）；三条可选收紧见 §12.1                                                                                                                                                       |
| 外部 bot 当用户                  | 另一个心智的 bot 会被当普通用户摄入、可能被回应。触发谓词（私聊 / @我 / 关键词）就是闸门；若将来要抑制 bot 间对话，再引入 `foreignBots` 名单                                                                                                                                                                                                                           |
| 实体表是共享状态                 | 它跨 profile 共享（§3.3）。渲染因此不再是"只读流"的纯函数——**同一份流在不同时刻可能投影出不同的文本**，且「模型当时看到了什么」不能只靠流还原。两条都写进了 §6.0 与 design.md §3                                                                                                                                                                                       |
| 实体表的重建                     | 它是所有 profile 流的**并集**派生物，所以单个 profile 重放不能重建它；重建需要全部流（v1 不做重建命令，只保证「空表也能工作」）                                                                                                                                                                                                                                        |
| 实体表的并发写                   | 多 profile 同时 upsert → append-only 日志 + 内存索引，不读-改-写；写入串行化在同一条 promise 链上                                                                                                                                                                                                                                                                      |
| 提示词                           | 最后定；`prompt/index.ts` 只先固定装配契约（哪些 tier 下有哪些段落）                                                                                                                                                                                                                                                                                                   |

### 12.1 同一个群被两路接入：三条可选收紧

残余风险（§4.2）是**同一个群被一路民间协议身体与一路官方 Bot 身体同时覆盖**——跨平台、id 命名空间不同、不可静态判定、也去重不了。三种处理方式：

| 方式                        | 效果                                                                               | 代价                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **（v1）承认不可判定**      | 允许一个 profile 混用多平台，只做同平台的不相交校验；用「同名频道」启发式打 `WARN` | 用户配置错误时症状是同一场对话以两个场景进入同一心智；靠告警提示 |
| 禁止一个 profile 混用多平台 | 同一个群不可能被两路同时覆盖（一个心智只在一个平台的命名空间内活动）               | 一个心智不能同时存在于 QQ 与 Telegram 等两个平台                 |
| 一个 profile 只能有一具身体 | 这一整类问题消失（去掉多身体、`sid` 参数、多场景寻址的一半复杂度）                 | 一个心智不能持有两个账号；跨平台只能开两个 profile（= 两个心智） |

选择依据是产品意图而非技术：**一个数字生命是否应当能同时存在于两个平台**。v1 保守地保留了这个能力，并用静态校验（同平台）+ 运行时告警（跨平台同名）两层兜底。
