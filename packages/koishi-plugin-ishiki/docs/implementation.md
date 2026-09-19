# koishi-plugin-ishiki 实现规格

> 状态:机制层共识已定(2026-09-19)。行为规格见 [`design.md`](./design.md)(本文写 `§n` 时指 design.md 的节号),机制论证见 [`mechanism.md`](./mechanism.md)。本文只讲**代码怎么落**:目录、类型、算法、装配、事务、测试面。
>
> 底座:`@yesimagent/core`。内核侧的 step 边界能力**已经落地**(见 §1.2),本文不再有待做的内核改动。

---

## 1. 现状与改造面

### 1.1 今天的 `src/`

| 文件          | 内容                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `index.ts`    | 插件入口:Schema、`ready` 装配、`models.yaml` / `profiles.yaml` 读取、session 分发          |
| `runtime.ts`  | `ProfileRuntime`:运行期状态、投影(`transformEntries`)、四个工具、落帧与空闲;纯函数在模块级 |
| `profiles.ts` | `profiles.yaml` 解析与校验、频道规则、`resolveFocus`                                       |
| `scene.ts`    | 场景身份、事实行渲染、归属遍历(`classify`)、帧分段(`frameSegments`)与场景读流(`factsOf`)   |
| `types.ts`    | `declare module` 扩展:事实 / 边界 / 独白                                                   |
| `debug.ts`    | `dumpRequests`:包装 `fetch` 落盘原始请求与响应                                             |

曾经规划过的 `scope.ts` / `entities.ts` / `facts/` / `fold/` / `tools/` / `lifecycle/` / `prompt/` **没有落地**:账号与频道规则在 `profiles.ts`,投影、工具与落帧都在 `runtime.ts`。切文件的判据见 §6.2 与 §8.0——按类型切文件会把还在变动的接口提前冻结,而「一个人的两个文件」并没有大到需要分。

**09-19 抽出 `scene.ts`**:这一层按 **seam** 切,不按类型切——投影与帧此前各自走了一遍同一条 entry 流(推进 cursor、判定够不够得着、按场景归属),撤回行的格式也抄了两份。判据是**调用点 ≥2**:`classify` 两个消费方(工作区投影、`frameSegments`),`factsOf` 三个(`peek_channel`、帧的存储回读、位置声明的频道名)。投影本身仍写在 hook 字面量里,不另开 module:它只有一个调用点,拆出来只是给测试留缝。

### 1.2 已落地的内核改动(既成事实,不再待办)

| 内核改动                                                                                                        | 状态   |
| --------------------------------------------------------------------------------------------------------------- | ------ |
| `send(…, { ifBusy: "join" })` 的持久化推迟到 step 边界(`TurnRequest.addJoined(messages, persist?)` 收 thunk)    | 已完成 |
| 新增 `AgentPlugin.onStepFinish`(每 step 恰一次,含最后一步;在 `drainJoined` 之后;第一个返回决定的插件拥有决定权) | 已完成 |
| `endTurn` 从 `ToolResultInfo` / `ToolExecutionResult` 移除,turn 结束改由 step 级决定                            | 已完成 |

依据:条目只有三个落盘点(内核 `runStep` 内部、session 摄入的 join、插件在 step / turn 边界的写入),三者都不会把 `user` 形态的渲染块插进 `assistant(tool-call)` 与其 `tool(result)` 之间。**配对完整性是结构性的,fold 不需要缓冲或重排规则。**

### 1.3 本轮(四段机制)改造面

| 目标                               | 落点                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 状态槽(**已落地**)                 | `transformEntries` 就地现算(挂钟取档 + `<state>` 正文 + `slot:<anchorId>` 的 id),在帧之后插入一条 `user` 消息                         |
| self-skip(**已落地**)              | session 处理器里就地判:`platform:userId` 在该 profile 的 sid 集合里 → 直接 return,不入 storage                                        |
| 帧按场景分组(**已落地**)           | `frameSegments()` 分桶并渲染行;`frameTextFor` 做存储路线的尾部 + 时间窗口过滤与段排序                                                 |
| 自己的话走事实通道(**已落地**)     | `send_message` 成功后在 step 边界落 `ishiki.self.message`;`transformEntries` 不投影它,帧侧与别人同格式渲染                            |
| 工具轨迹不折叠(**已落地**)         | `scene.ts` 的 `renderLines()`:每个 tool-call / tool-result 各一行,参数与结果完整;`truncateMiddle()` 与 `context.toolResultChars` 删除 |
| 工具轨迹按 cursor 归属(**已落地**) | `classify()` 的归属:assistant / tool 条目落进遍历到它时的 cursor 场景;`startFocus` 由 `rebuild` 传入                                  |
| 聚合取消(**已落地**)               | 帧侧 `pushFact` / `closeFacts` 删除;工作区投影一条事实一个块                                                                          |
| 立即换代(**已落地**)               | `onStepFinish` 的 `pendingFocus` 分支:由「落 change 条目」改为「立即 `rebuild("switch", previous)`」                                  |
| change 保险丝(**已落地**)          | `rebuild` 返回 false 时落 change 条目;`transformEntries` 就地把它渲染成块头(工作区投影的降级路径)                                     |
| 冷却降级(**已落地**)               | `switchedThisTurn` 与 `FocusCooldown` 全部删除;v1 无冷却                                                                              |
| `<scenes>` 段                      | 不做(09-19 删)                                                                                                                        |
| 去 K                               | 不实现「每 step 封顶 + `+n`」(09-19 否决)                                                                                             |

## 2. 目录结构

(不变,见 §1.1 的表)

## 3. 类型

### 3.1 事实(storage 里长期存在)

```ts
export namespace Fact {
  /** 场景身份 = **身体 + 频道**,地址写作 `platform:selfId:channelId`。 */
  export interface Scene {
    platform: string;
    selfId: string;
    channelId: string;
    guildId?: string;
  }

  export interface MessageCreated extends Scene {
    content: string;
    user: { id: string; name?: string }; // 摄入那一刻的快照
    channel: { id: string; name?: string; direct: boolean };
    messageId: string;
    timestamp: number;
    quote?: { id: string; content?: string };
  }

  export interface MessageDeleted extends Scene {
    messageId: string;
    operatorId?: string;
    timestamp: number;
  }

  /** 事件类(poke 等)。`targetIds` 是摄入期解析出的事实,不是「这是 awareness」的标记。 */
  export interface Notice extends Scene {
    kind: string;
    actorId?: string;
    targetIds?: string[];
    timestamp: number;
    detail?: Record<string, unknown>;
  }

  /** step 0 未产出工具调用时的重试提示;随流保留。 */
  export interface Nudge {
    reason: string;
    timestamp: number;
  }
}
```

事实里**没有**「awareness / focus」这类形态字段,也没有 `mentions`。`Notice` / `Nudge` 尚未摄入(§5.1)。

### 3.2 投影产物:原生消息,不落盘

| 产物                | 形态                                   | 来源                                 |
| ------------------- | -------------------------------------- | ------------------------------------ |
| 帧                  | 一条 `user`,正文 = payload 里的 `text` | 落帧时写入的字符串,直接读            |
| 位置声明            | 一条 `user`,正文 = `<frame …/>`        | 无边界时由投影派生                   |
| 状态槽              | 一条 `user`,正文 = `<state>…</state>`  | 每 step 在 `transformEntries` 里现算 |
| 裸行 / awareness 块 | 一条 `user`,正文 = 行或块              | 事实条目                             |
| 心智自己的话        | 一条 `assistant`                       | `ishiki.inner.thought`               |

没有 `ishiki.render.*` 渲染 type 这一层:投影直接产出原生消息,所以不需要 `toModelMessages`(`first-win` 且只拿得到单条消息,取不到 cursor)。

### 3.3 名字:随事实快照,不做实体表

事实自带 `user` / `channel` 快照,取值就是摄入那一刻的 `session.author?.name` / `session.event?.channel?.name`。前缀稳定白送;代价是重复存储,且改名**不回溯**。缺名回退到 id(fail-soft)。

### 3.4 entry

```ts
export interface Checkpoint {
  frameFocus: Focus; // 本代起点(身体 + 频道)
  text: string; // 已渲染的帧文本:生成一次,之后每个 step 只读这一份
  createdAt: number;
  // memory?: string;  // 慢层摘要的位置,落地时再加(§12)
}

export interface FocusChanged {
  previous: Focus;
  next: Focus;
  reason?: string;
}
```

- `AgentCustomEntry` 加的键:`ishiki.checkpoint`(帧)与 `ishiki.focus.changed`(切换记录)。它们是 entry 不是 message——投影时不会被当成一条消息直接放行。
- `AgentCustomMessage` 加的键:`ishiki.message.created` / `ishiki.message.deleted` / `ishiki.inner.thought` / `ishiki.self.message`(心智自己发出的消息),另有 onebot 的 `onebot.guild.member-added`。规划中的 `ishiki.notice` / `ishiki.nudge` 未实现。
- **状态槽不是 entry、不进 payload**:它派生得出来,存一份就是第二个事实来源(§7)。
- 改名说明:中段标签是 `<history>`(不是 `<hist>`);段头自声明 `sid` / `channel`;帧头声明当前焦点用 `focus_sid` / `focus_channel`(不再是 `sid` / `channel`)。

## 4. scope:装配期派生

```ts
type ChannelRule = { kind: "exact"; channelId: string } | { kind: "all" } | { kind: "not"; rule: ChannelRule };

interface Scope {
  bodies: readonly string[]; // `platform:selfId`
  rules: ReadonlyMap<string, ChannelRule[]>;
  bodyCount: number;
  singleScene: boolean; // 恰好一具身体,且它的规则是唯一的 exact
  multiBody: boolean; // bodies.length > 1        → 提供 sid 参数
  multiChannel: boolean; // 任一 sid 能命中多个频道 → 提供 channel 参数
}
```

派生公式:

```
singleScene  = bodies.length === 1 && rules.get(bodies[0]) 恰好是 [{kind:"exact", …}]
multiBody    = bodies.length > 1
multiChannel = 存在 sid 使 allows(sid, ·) 能命中 >1 个频道(family pattern 视为真)
```

### 4.1 加载期静态校验(拒绝启动)

先按参与方数量区分场景形态:`private` = 两方(私聊),`private:U` 在两具身体下是两段不同的对话,**豁免重叠校验**;其余 kind = 多方,重叠即「同一句话被两具身体各投递一次」,**校验**。

| 校验                   | 规则                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| 同 profile 内身体互斥  | 同一 platform 下,任意两具身体的**多方场景**集合不相交(两方豁免)                                              |
| 跨 profile 同 sid 互斥 | 同一 sid 出现在两个及以上 profile 时,它们在该 sid 上的**全部**场景集合不相交(两方同样校验——管的是所有权划分) |
| 不同平台不比较         | 不同 platform 的频道 id 属于不同命名空间                                                                     |

规则语言只有 `exact` / `*` / `!` 三种,相交判定三条即可:两个 `*` 在无 `!` 时相交;`*` 与 `exact` 用成员判定(含 `!` 否定);不同 kind 天然不相交。判定在**平台内**做,不需要枚举运行期频道。

> 已知边界:v1 只把 `private` 认作两方 kind。若某适配器用别的名字表示私聊(如 `direct`),它会被当成多方、从而可能误拒合法配置——这是配置可见的表象,将来用 `twoPartyKinds` 之类的配置项扩展,不预先猜。

### 4.2 不可静态判定的残余:同一个群被两路接入

`onebot:1434974784` 与 `qq:4138444372060156334` **不是同一个 QQ**:前者是民间协议(以用户账号登录),后者是官方 Bot,两条出口各有独立命名空间(样本里 onebot `channel.id = 857518324`,官方 qq `BC1E3F68…`)。于是「同一个群被两路覆盖」既判不出来(字符串不可比)也去重不了(没有可比字段)。

**v1 取向**:承认不可判定,只做同平台校验;另加运行时 `WARN`(两个不同场景的**频道名相同**且都是群 → 提示可能是同一群被两路接入)。启发式,只提示、不拒绝、不改行为。

### 4.3 身体集合的唯一来源

没有 `bots` 字段:一具身体的存在 ⇔ 它在 `allowedChannels` 里有条目且至少一个频道。配套:① sid 在 `ctx.bots` 里找不到 → `ready` 时 `WARN`;② `bodies` 同时用于摄入 `selfId` 匹配、self-skip、`atSelf` 判定、`sid` 参数门控。

## 5. 摄入层

```ts
ctx.on("internal/session", (session) => {
  for (const runtime of this.runtimes) {
    const sid = `${session.platform}:${session.selfId}`;
    if (!runtime.scope.bodies.includes(sid)) continue; // 这具身体不归我
    if (runtime.profile.allowedChannels.some((declaration) => declaration.sid === `${session.platform}:${session.userId}`)) continue; // 自己人说话不是输入
    const fact = projectFact(session, runtime); // §5.2
    if (!fact) continue;
    if (!allows(runtime.scope, sid, fact.channelId)) continue; // 身体 + 频道都在白名单内
    runtime.agent.send(fact, { trigger: hits(runtime, session, fact), ifBusy: "join" });
  }
});
```

- 白名单判定是「身体 + 频道」两个条件同时成立;它与唤醒判定**分开**:白名单决定是否接管,`hits` 决定是否触发 turn。
- `ifBusy: "join"`:中途到达的消息作为 step delta 进入当前 turn,落盘时机由内核固定在 step 边界(§1.2)。
- **self-skip(已落地)**:session 处理器在渠道判定之后直接返回,判据是 `platform:userId ∈ allowedChannels 的 sid 集合`——与 `atSelf` / `sid` 门控共用同一个集合。少了它,心智会把自己另一具身体发出的同一句话当成「某个人」说的读回来,同一句在流里出现两次。
- 外部 bot 不特殊化:别的心智的 bot 就是普通用户。

### 5.1 投影分派:一个 switch

分派是普通的 `switch (session.type)`,每个 case 一个纯函数 `(session, bodies) => Fact | undefined`;unknown → `undefined`(fail-closed,只档案不渲染)。**不引入注册表**:真实 session 类型集合还在变动,按类型切「处理器」会把接口形状提前冻结;扩展点等「外部插件要注册事实类型」这条需求成真时再评估。

| session                                       | 事实                  | 状态                                                                       |
| --------------------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `message-created`                             | `Fact.MessageCreated` | 已实现(`quote` 只取 `{id, content}`)                                       |
| `qq/group-at-message-create`(`type=internal`) | `Fact.MessageCreated` | 待实现:必须把「@ 了谁」文本化进 `content`,并补齐 `channelId` / `messageId` |
| `message-deleted`                             | `Fact.MessageDeleted` | 待实现                                                                     |
| `notice/*`(poke 等)                           | `Fact.Notice`         | 待实现:指向性从 adapter 私有 payload 解析,判不出就**不带 `targetIds`**     |
| `login-*` / `ready` / `resumed`               | 无                    | 自己身体的状态,只档案                                                      |

**框架隔离**:`session` 的形状由本地的结构化类型声明(只列用到的字段),不 import `koishi`——它的主入口会拉入 CLI/loader 运行时,测试跑不起来。平台分支只允许出现在这里。

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

## 6. fold:一个 hook

### 6.0 不变式

1. **只读 entry 流 + 配置**;昵称 / 频道名随事实快照(§3.3)。
2. **投影纯度收窄(09-19)**:除状态槽外,投影是流的纯函数——同一条流两次投影逐字节相同,新条目只延长最后一个块。**状态槽读挂钟**,是唯一例外;因此它不进任何「同流两次投影相同」的断言,复盘依赖 `dumpRequests` 的 dump。
3. **形态一次性**:条目形态由它在流中的位置(cursor)决定,与「现在几点」无关。
4. **时钟的两种读法**:帧文本里的 `at=` 与段内相对时间是**物化那一刻**读一次,写进 payload 后冻结;状态槽是**投影阶段**读。两者的分界线就在这条不变式上。

### 6.1 `transformEntries`:帧 + 状态槽 + 本代投影

```ts
transformEntries: (entries) => {
  const checkpoint = lastEntryOfType(entries, "ishiki.checkpoint");
  const workspace = workspaceOf(entries); // 边界之后(或全部)
  const out: AgentEntry[] = [];

  // 1. 帧(或位置声明)
  if (checkpoint !== undefined) out.push(frameMessage(checkpoint));
  else {
    const position = positionEntry(profile, workspace); // 取值只用该代首条 entry 与 initialFocus
    if (position !== undefined) out.push(position);
  }

  // 2. 状态槽:每 step 现算,不落盘、不冻结;id 钉在开段的那条 entry 上
  const anchor = checkpoint ?? workspace[0];
  if (anchor !== undefined) out.push(stateSlotEntry(anchor.id, workspace.at(-1)?.timestamp ?? anchor.timestamp));

  // 3. 本代投影
  const startFocus = checkpoint === undefined ? profile.initialFocus : checkpoint.data.frameFocus;
  let cursor = startFocus;
  let inWindow = false;

  for (const entry of workspace) {
    if (entry.type === "ishiki.focus.changed") {
      cursor = { ...entry.data.next };
      out.push(changeHeadMessage(entry.data)); // 带 from / reason 的块头(降级路径)
      inWindow = true;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.data;
    if (message.role !== "custom") {
      out.push(entry);
      inWindow = false;
      continue;
    }
    if (message.type === "ishiki.self.message") continue; // 自己的话:进帧不进工作区
    if (message.type === "ishiki.inner.thought") {
      out.push(assistantMessage(entry));
      inWindow = false;
      continue;
    }

    const rendered = message.type === "ishiki.message.created" ? createdText(profile, cursor, message.data) : deletedText(profile, cursor, message.data);
    if (rendered === undefined) continue; // 够不着、且在焦点外 → 不渲染

    // 焦点内:一段连续窗口事件只在开头带一次 <focus sid channel> 块头;别处够得着的整条包一层 <awareness>
    const text = rendered.focus
      ? inWindow
        ? rendered.text
        : `<focus sid="${cursor.sid}" channel="${cursor.channelId}">\n${rendered.text}`
      : awarenessMessage(rendered);
    inWindow = rendered.focus;
    out.push(textMessage(entry, text));
  }
  return out;
};
```

- `createdText` / `deletedText` 的返回形状携带 `sid` / `channel` 与 `focus`(`FactLine`),供包装与帧侧分桶用;文本本身仍是 `lineOf(fact)`。
- **一条事实一个块**:别处够得着的事实各自包一层 `<awareness>`,不合并、不设条数限额——合并要在原地改写已发送的尾部块,与工作区 append-only、形态一次性冲突。
- 投影输出**原生消息**:帧与状态槽是 `user`,事实块是 `user`,心智自己的话是 `assistant`,assistant / tool 条目原样通过。

### 6.2 `frameTextFor`:帧在物化那一刻组装

```ts
private frameTextFor(frameFocus: Focus, startFocus: Focus, entries, workspace): string {
  const at = Date.now();
  const here = focusKey(frameFocus);
  const scenes = scenesOf(profile, startFocus, workspace); // 本代按场景分桶 + 谁被工作过
  const parts = [`<frame ${positionAttributes(frameFocus, formatClock(at), workspace)}>`];

  // 焦点段:这一代里这个场景的样子(事实 + 工具轨迹,按流序)
  parts.push(`<history sid="${frameFocus.sid}" channel="${frameFocus.channelId}" focus>`);
  parts.push(...segmentLines(scenes.get(here)?.entries ?? []));
  parts.push("</history>");

  // 其余段:这一代工作过的场景用自己的切片;只被叫到过的场景从存储拉
  const rest = [];
  for (const [key, slice] of scenes) {
    if (key === here) continue;
    const kept = slice.focus ? { facts: slice.entries, dropped: 0 } : sceneFactsOf(entries, slice.scene, at, profile);
    if (kept.facts.length === 0) continue;
    rest.push({ scene: slice.scene, ...kept, latest: kept.facts.at(-1)?.timestamp ?? 0 });
  }
  rest.sort((left, right) => right.latest - left.latest);
  for (const segment of rest) {
    parts.push(`<history sid="${segment.scene.sid}" channel="${segment.scene.channelId}">`);
    if (segment.dropped > 0) parts.push(`<!-- 更早 ${segment.dropped} 条已折叠 -->`);
    parts.push(...segmentLines(segment.facts));
    parts.push("</history>");
  }

  parts.push("</frame>");
  return parts.join("\n");
}
```

**两种来源**(一个场景一段):

| 这段是什么                                        | 来源                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 焦点段                                            | 本代工作区里属于这个场景的条目 + 本代的工具轨迹,按流序                                              |
| 这一代工作过的别的场景(含被离开的那个)            | 它在工作区里的切片:事实 + 在那个场景里跑过的工具轨迹                                                |
| 只被叫到过的场景(awareness 命中 / 我在那里说过话) | 存储拉取:`context.historyEntries` 条尾部,且只收 `context.sceneWindowMs` 以内的事实,被裁时写折叠标记 |

- **`startFocus` 是这一代 cursor 的起点**(上一个检查点的 `frameFocus`):一次切换之后它就是被离开的那个场景,所以整步的工具轨迹落在它那段里,新焦点段里不会有上一步的调用。
- 归属由 `scenesOf()` 决定:事实进它自己的场景,assistant / tool 条目进遍历到它时的 cursor 场景;段内顺序就是流序。
- 段序:焦点段最前,其余按最近活跃倒序;**没有 `last_focus_history`,也没有 `<scenes>`**。
- `<memory>` 仍是慢层,v1 不出现。

### 6.3 自己的话:落盘为事实,不是转写

`send_message` 成功发出的每条消息,在 step 边界落一条 `ishiki.self.message` 事实:`platform` 取 `bot.platform`,`selfId` 取 `bot.selfId`,`user` 取 `{ id: bot.selfId, name: bot.user?.name ?? profile.name }`,`messageId` 取平台返回的 id,`channel.id` 是目标频道。

| 情况        | 落盘                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `ok: true`  | 每个气泡一条 `ishiki.self.message`;发往别的场景的也一样,它本来就是那个场景的事实 |
| `ok: false` | 不发事实:没出去的那条只留在工具轨迹里(与别的工具一样的两行)                      |
| 平台不回 id | 记一条 warning,该气泡不落事实(不编造 messageId)                                  |

- 帧里它与别人的行**同格式**(`lineOf(fact)`):没有 `【我:内容】`,也没有 `<self>` 块——整条转写通道(从调用参数反推内容 / 寻址 / 归属、气泡逐项成行、失败回显特判)已删除。`sentCall()` / `resultOk()` 不存在了。
- 可见性:**进帧,不进工作区投影**(§6.1)——工作区里「我说过什么」由那次 `send_message` 的 tool-call 承担。
- 落盘时机与独白同批:在 `onStepFinish`,排在换代之前(§9.1),所以切换后新帧的焦点段能看到它。
- 稳定区用一句以 uid 为键的规则代替标记:`你的 uid 是账号里 platform: 后面那一段。行里括号中的 id 等于你的 uid 时,这一行就是你说的。`

### 6.4 行渲染:一个 `segmentLines`

帧文本由 `segmentLines(entries)` 拼成 `string[]`;`transformEntries` 侧不共用它——那边产出的是原生消息(一条块 = 一条 `user` 消息),形状不同,强行共用只会把两边都拧弯。

- 段内一行的来源:事实(`ishiki.message.created` / `ishiki.self.message` / 撤回)走 `lineOf(fact)`;assistant 的 tool-call 一行 `[工具调用] name: {完整参数}`;tool result 一行 `[工具结果] name: {完整结果}`。
- **都不截断**:`truncateMiddle()` 与 `context.toolResultChars` 已删除,`inner_thought` 也在参数里原样呈现,不做字段级裁剪。
- assistant 的正文不进帧;独白(`ishiki.inner.thought`)在帧里不产出任何内容。
- 帧侧没有 awareness 包装块,也没有同场景聚合:`<awareness>` 只出现在工作区投影里,一个事实一个块。
- `renderEntries()` / `windowEntriesOf()` / `completeToolCalls()` / `skipScene` 都已随旧帧结构删除。

**配对完整性是结构性的,不靠 fold 兜底**:条目只有三个落盘点(内核 `runStep` 内、session 的 join、插件在 step / turn 边界的写入),三者都不会把 `user` 形态的块插进 `assistant(tool-call)` 与 `tool(result)` 之间。

### 6.5 事实类型的知识由 switch 持有

`transformEntries` 与帧侧的 `segmentLines()` / `scenesOf()` 是列举事实类型的地方(`types.ts` 的 `declare module` 除外)。共享的只有值工具(`sceneKeyOf` 判场景同一性、`focusKey` 取场景、`reachesMind` 判提及 / 关键词 / 私聊)与 `isFactOf()`(判断某条 entry 是不是某个场景的事实),不共享类型判别式的组织方式。

- **为什么不建「类型 → 处理器」注册表**:v1 的类型集合仍在变动,此时按类型切文件会把接口形状提前冻结;而 switch 的代价(加类型时改这一处)在规模上可以接受。**这是显式决定,不是遗漏。**
- **重新评估的时机**:真实类型集合稳定之后,触发条件是「外部插件需要注册事实类型」这条需求成真,而不是「这里有个 switch」。
- 投影出的形态是封闭的:帧 / 位置声明 / 状态槽 / 裸行 / awareness 块 / 心智自己的话。将来若允许插件注册事实类型,只能选其中一种,不能定义新形态。

## 7. 状态槽的实现

```ts
/** 4 档:一天最多变 4 次,远低于检查点间隔。 */
function daypartOf(hour: number): string {
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 18) return "下午";
  return "晚上";
}

/** `2026年9月19日 凌晨`——挂钟是全文唯一一处投影读此刻。 */
function wallClock(now: Date): string {
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${daypartOf(now.getHours())}`;
}

/** `anchorId` 取开段的那条 entry,保证 id 本代恒定。 */
function stateSlotEntry(anchorId: string, timestamp: number): AgentEntry<"message"> {
  const text = ["<state>", `当前时间:${wallClock(new Date())}`, "</state>"].join("\n");
  return createEntry("message", createUserMessage(text), { id: `slot:${anchorId}`, timestamp });
}

/** 记录过的切换是唯一会移动 cursor 的东西。 */
function focusAfter(focus: Focus, entry: AgentEntry): Focus {
  return entry.type === "ishiki.focus.changed" ? { ...entry.data.next } : focus;
}
```

- 位置:帧(或位置声明)之后、工作区投影之前,永远恰好一条 `user` 消息。
- `createEntry` 的 `id` 必须**本代恒定**(例如 `slot:<boundaryId>`):它不进模型字节,但抖动的 id 会扰动 entry 身份与去重语义。
- `timestamp` 取该次投影的最后一条 entry 的时间(仅作为 entry 元数据;槽的**内容**用挂钟)。
- **不落盘、不进 payload、不参与折叠**——存一份就是第二个事实来源(§3.4)。
- **门控不是代码**:槽是每次投影现算的,「状态没变就不重渲染」等价于「同一批输入下 `stateSlotEntry` 返回同一个字符串」,字节自然不变,缓存从帧·历史起照常命中。
- **护栏**:新增字段前先问「它多久变一次」。任何每 turn 必变的量(精确时间、每轮情绪 marker)一律走工作区 append 行,不进槽。

## 8. 工具

### 8.0 依赖注入

**不引入依赖注入式包装**:没有 `interface ToolRuntime`,也没有 `create*Tool({ resolve, send, stop })` 工厂。工具在 `buildTools()` 里就地定义,闭包直接捕获 runtime——`execute` 里用 `this.currentFocus` / `this.profile` / `this.ctx.bots`,跨 step 待落盘的记录挂在 runtime 的 pending 字段上(`pendingFocus` / `pendingThoughts` / `pendingSelfMessages`)。测试也不为可测性在生产代码里留缝:harness 用真实运行时加假的外部边界(假 `ctx.bots`、脚本化模型、临时存储)。

### 8.1 四个工具与 tier 变体

| 工具           | 参数                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `send_message` | `messages[]`、`channel?`、`mode?`、`continue?`、`sid?`;`inner_thought` 仅在 `innerThought: true` 时存在 |
| `finish`       | `reason?`                                                                                               |
| `switch_focus` | `channel`(必);`sid?`、`reason?`                                                                         |
| `peek_channel` | `channel`(必);`sid?`、`limit?`                                                                          |

**寻址规则**(三个带 target 的工具共用,`resolveFocus` 是唯一实现):`sid` 省略 = 当前窗口所在的账号;`channel` 省略 = 当前窗口(focus)的频道。**点了账号就要点频道**:给了别的 `sid` 却不给 `channel` → `InvalidInput`(不静默套用窗口的频道)。`sid` 不在 `allowedChannels` → `UnknownBody`;频道不在白名单 → `TargetNotAllowed`,错误信息附上可用项。

**tier 降级尚未实现**(§12):参数集合目前固定;已定的原则不变——**参数不存在时,schema、description 与稳定区同时不含它**。

### 8.2 `send_message`

- 解析 target → `(sid, channelId)`;失败一律结构化错误,不静默回退。
- `ctx.bots[sid]` 取身体后逐条 `sendMessage(channelId, content)`;身体不在 `ctx.bots` → `BotNotFound`。
- `mode: "raw"` 时先 `h.escape`,否则 Koishi 的 `h.normalize` 会把正文当元素解析。
- 结果只回 `{ ok: true, count }`:工具结果是**永久留在前缀里**的内容,`target` 只是把入参抄回去。平台返回的消息 id 不进结果,它只用来写 `ishiki.self.message`(§6.3)。失败时 `{ ok: false, sent, failedAt, error: { name, message } }`,`name` 是模型能据以改正的东西。
- `inner_thought` 攒进 `pendingThoughts`,在 step 边界落一条 `ishiki.inner.thought`。
- 成功发出的每个气泡连同平台返回的 id 攒进 `pendingSelfMessages`,在 step 边界落成 `ishiki.self.message`(§6.3);平台没回 id 时该气泡只记 warning。
- **结束 turn 由 `onStepFinish` 决定**(§9.1)。

### 8.3 `switch_focus`

1. 解析 target → `(sid, channelId)`;必须是白名单内的场景,否则结构化错误。
2. 与当前 focus 相同 → `{ ok: true, changed: false }`。
3. **v1 没有冷却**:一次切换就是一代的结束,所以「一代只切一次」是结构性的,同一 step 里连切 = 连着结束两代(帧头停在最后那个场景)。将来的成本护栏是 `focusSwitch.minIntervalMinutes`,**未实现**。
4. `setLogicalFocus(next, reason)` → 记 `pendingFocus`(不结束 turn);`currentFocus` 立即更新,本 step 后续的发送默认去新场景。
5. pending 在 **`onStepFinish`** 落盘——**落盘动作是「立即换代」**(§9.2),不是写 change 条目。
6. 结果:`{ ok: true, changed: true, sid, channel }`。

### 8.4 `peek_channel`

读 `storage.read()`,按目标场景过滤事实条目,取最近 `limit` 条(上限 `PEEK_MAX_LIMIT`),渲染成文本行返回,自带 `<peek sid channel count>` 块头。不改 focus、不触发重建。

### 8.5 `finish`

返回 `{ ok: true }`;`onStepFinish` 见到它即结束 turn。存在的唯一理由:让「什么都不做」成为显式决策。

## 9. 生命周期

### 9.1 `onStepFinish`:每 step 恰一次

```ts
onStepFinish: async (info) => {
  // 1. 独白先落盘(它属于切换前的那一代)
  if (pendingThoughts.length > 0) { … append; pendingThoughts = []; }

  // 2. 本步真正发出的消息落成 ishiki.self.message(同样排在换代之前)
  if (pendingSelfMessages.length > 0) { … append; pendingSelfMessages = []; }

  // 3. pending 切换 → 立即换代;失败 → 落最小 change 条目(保险丝)
  if (pendingFocus !== null) {
    if (await rebuild("switch", pendingFocus.previous)) pendingFocus = null;
    else { await storage.append(createEntry("ishiki.focus.changed", pendingFocus, { turnId })); pendingFocus = null; }
  }

  // 4. step 级决定(结束 turn)
  const stop = stopRequestedThisStep;
  stopRequestedThisStep = false;
  return stop ? { continue: false } : undefined;
}
```

- **顺序**:内核先 `drainJoined` 再调 `onStepFinish`,所以本 step 中途 join 的消息排在换代之前——它们按切换前的 cursor 判形态。
- 独白排在换代之前:**它随上一代折叠消失**(§6.4)。
- `onStepFinish` 的异常被内核吞掉(它只是观察者),所以每一步都必须自己 catch + log。

### 9.2 立即换代

`switch_focus` 的落盘动作从「写 `ishiki.focus.changed` 条目」改为「**在 step 边界写新 checkpoint**」:

- `rebuild("switch")` 组装帧文本并 `append` 一条 `ishiki.checkpoint`。组帧的 cursor 起点 `startFocus` 取自上一个检查点的 `frameFocus`,它就是被离开的场景,所以整步的工具轨迹落在它那段里(§6.2)。
- **成功路径不落 change 条目**:切换语义由边界本身加新一代的 `frameFocus` 完整表达,旧场景的去向写在帧文本里。
- **时机必须在 step 边界**:tool `execute` 内本 step 的 assistant / tool 条目还没写完,重建会读到残缺工作区。
- **代价(显式)**:换代把本步已经发生的一切留在被离开的那个场景——触发消息、本次工具调用、工具结果都成为它在帧里的样子,新的工作区从换代点开始。缓存账上 miss 总量守恒。
- **重启恢复**:live focus = 最后 checkpoint 的 `frameFocus`;只有降级路径才需要再扫 change 条目。
- **慢层延迟保护**:切换重建的 `<memory>` 段延用旧版文本,下一检查点再替换(v1 无 memory,天然满足)。

### 9.3 change 保险丝

checkpoint 写失败时才落最小 change 标记:

```ts
createEntry("ishiki.focus.changed", { previous, next, reason }, { turnId, timestamp: Date.now() });
```

- 投影把它渲染成块头 `<focus from="…" to="…" [reason="…"]>`(不是旁白行):`changeHead()` 负责把 reason 里的引号与换行压平;`transformEntries` 在它之后把 `inWindow` 置为 true,所以后续裸行不会再开一个 `<focus …>` 头。
- pending 在落盘失败时**保留**?——不:换代失败后立即落保险丝并清空 pending。理由:再重试一次换代等于把同一段轨迹折两次,而保险丝已经保住了语义;真正的帧等下一次检查点重建。

### 9.4 turn 结束与空闲

```ts
onTurnFinish: () => { if (generationDirty || rebuildPending) scheduleRebuild("turn-finish"); }

private async rebuild(reason) {
  const workspace = workspaceOf(entries);
  if (workspace.length === 0) { generationDirty = false; return; }
  // 切换已经在本 step 边界重建过,所以这里不再以 switched 为触发条件
  if (reason !== "idle" && !this.overBudget(workspace)) return;
  … 组装并 append checkpoint …
}

private async checkIdle() { … generationDirty ∧ agent.isIdle() ∧ 静默超 idleMs → scheduleRebuild("idle") … }
```

- `overBudget`:只累计最后一条 `ishiki.checkpoint` 之后条目的字符数 ÷ `charsPerToken`。
- `rebuildChain` 串行化,避免空闲重建与 turn 结束重建并发。
- `rebuild` 是**唯一物化写**;失败不写边界,本代保留,下次触发重试。

### 9.5 归档轮转(未实现)

触发:`messages.jsonl` 字节数 > `archive.maxKB`,或人工命令。步骤:空会话拒绝 → LLM 压缩(失败则机械回退:把上一轮**帧文本**作为快照)→ `fs.rename` 到 `archive/messages-<ts>.jsonl` → 按路径 append 新边界。全程只在 `agent.isIdle()` 时执行,与 `rebuild` 共用串行化链。

### 9.6 step 0 兜底(nudge,未实现)

`onTurnFinish` 里检查「本 turn 从未产生工具结果」;命中则 `send(nudge, { trigger: true, ifBusy: "defer" })`,最多重试一次。`ifBusy` 必须是 `"defer"`:`"reject"` 抛 `AgentBusyError` 而插件异常被吞;`"join"` 会静默丢失。排队 nudge 时**跳过本次重建**(零工具调用的 turn 不可能切换)。

## 10. 参数解析

- 插件级:`dataPath`(基础目录,含 `models.yaml` 与 `profiles.yaml`)、`profilesPath`、`logLevel`、`dumpRequests`。
- profile 级字段名与默认值见 design.md §16.2。
- `compactionModel` 缺省 = `model`;`dataPath` 缺省 = `<基础目录>/<profile.id>`。
- `context.workspaceTokenLimit` 缺省 = `gateway.models("language").find(...)?.metadata.contextWindow × 0.5`,拿不到窗口时用 `8192`。

## 11. 测试面与验证

纯函数优先,测试只覆盖确定性行为(不写「有测试」的填充):

| 目标                | 用例要点                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` 派生        | 单场景 / 多频道 / 多身体三档;`private:*` 视为家族                                                                                                                                                                                                                                     |
| 静态校验            | 同 profile 内同平台两具身体的**多方**场景相交 → 抛错;**两方豁免**;跨 profile 同 sid 全场景相交 → 抛错;不同平台不比较                                                                                                                                                                  |
| 寻址解析            | `channel` 省略且该身体只有一个频道 → 取它;多频道未给 `channel` → 结构化错误;`sid` 省略取 focus 的身体                                                                                                                                                                                 |
| **self-skip**       | 自己任一具身体(`platform:userId ∈ allowedChannels`)的发言不入 storage、不起 turn;别人的同频道发言照常摄入                                                                                                                                                                             |
| **自己的话**        | 成功的 `send_message` 每个气泡落一条 `ishiki.self.message`(带平台返回的 id 与自己的 user 快照);工作区投影里看不到它;帧里与别人的行同格式;失败不落事实;平台不回 id 时只记 warning                                                                                                      |
| **立即换代**        | 一次 `switch_focus` 后 storage 里**没有** `ishiki.focus.changed`、多了一条 `ishiki.checkpoint`;新 checkpoint 的 `frameFocus` 是进入的场景,旧场景在它的帧文本里有自己的一段;下一个 step 的帧头已是新场景(`focus_sid` / `focus_channel`);同一 step 连切则 `frameFocus` 停在最后那个场景 |
| **轨迹归属**        | 一次切换把整步的工具调用留在被离开的那段里:新焦点段里没有任何 `[工具调用]`,`send_message` / `switch_focus` 两行都落在旧段                                                                                                                                                             |
| **状态槽**          | 位置(帧之后、工作区之前);正文匹配 `^<state>\n当前时间:\d{4}年\d{1,2}月\d{1,2}日 (凌晨                                                                                                                                                                                                 | 上午 | 下午 | 晚上)\n</state>$`;同一次投影内槽与帧之前的字节不含任何时钟漂移;冷启动无 checkpoint 时槽照样出现 |
| 冷启动              | 空流第一 turn 之前写开局帧;无边界时投影自给 `<frame …/>`                                                                                                                                                                                                                              |
| `frameTextFor` 分段 | 焦点段在最前且带 `focus`;这一代工作过的场景用工作区切片;只被叫到过的场景从存储拉;段序按最近活跃倒序                                                                                                                                                                                   |
| 段的裁剪            | 存储路线的段裁到 `historyEntries` 条、只收 `sceneWindowMs` 以内,被裁时写 `<!-- 更早 N 条已折叠 -->`;焦点段不受该上限影响                                                                                                                                                              |
| 工具轨迹不折叠      | 每个 tool-call / tool-result 各一行,参数与结果完整,`已截断` 不出现;独白随参数进帧                                                                                                                                                                                                     |
| 一条事实一个块      | 帧侧没有 `<awareness>` 块,也没有聚合;工作区投影里别处的事各自一块                                                                                                                                                                                                                     |
| name 回退           | 平台报不出账号昵称时用 `profile.name`;两者都没有则只写 id                                                                                                                                                                                                                             |
| change 保险丝       | checkpoint 写失败时落 change 条目,且被渲染成带 `from` / `reason` 的块头                                                                                                                                                                                                               |
| 前缀稳定            | 同一 turn 两个 step 的 request,除状态槽外逐字节相同;追加一条同场景消息后旧字节不变                                                                                                                                                                                                    |
| 前缀稳定(槽)        | 同一粗档内两次投影的槽逐字节相同                                                                                                                                                                                                                                                      |
| 内核 step 边界      | join 的消息不在本 step 的 storage 里、在下一 step 的 collect 里;最后一步 join 的消息在 turn 结束后仍在 storage 里;`onStepFinish` 每 step 恰一次(含最后一步)                                                                                                                           |

**一条测试面的诚实说明**:状态槽读挂钟,而生产代码里**不注入时钟**(为可测性留缝是明确禁止的)。因此「档位映射」没有确定性单测——结构断言只能覆盖取值域(正则),边界(05:59→06:00 等)靠人工在真实实例里跨档观察。这是选挂钟方案的既定代价,不是遗漏。

验证命令(仓库现有):`bun run lint`、`bun run format:check`、`bun run build`、`bun run test`(yakumo vitest)。

## 12. 风险与待定

| 项                     | 说明                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 投影纯度收窄           | 状态槽是唯一读此刻的地方。它坏掉的方式是**字段变热**:一旦有人往槽里加每 turn 必变的量,整段工作区每轮重付。审查新字段时只看这一条。           |
| 独白随换代消失         | 独白在换代前落盘,而帧不渲染它 → 切换会让本代的独白不可见。旧口径如此(「本代可见、不进帧」),但**立即换代把「本代」缩短了**,需要复核是否接受。 |
| 离场场景的丢失         | 焦点之外、没被 awareness 叫到过的事实不进任何段——有意的裁剪;被叫到过、或我在其中说过话的场景会进帧,没有信号的场景只能靠 `peek_channel`。     |
| 一次换代的折叠量       | 换代把本步已经发生的一切留在被离开的场景里,长 turn 中途切换会让那一代的内容一次性进帧。缓解:切换本来就要付一次检查点,这是它的价格。          |
| 切进安静场景的焦点段薄 | 焦点段是这一代里那个场景的样子,刚切过去时可能只有叫你的那一句。若实测发现模型接不上话,再评估「切换时从存储补足焦点场景」。                   |
| tier 降级              | 四处同进同退(参数、description、提示词、渲染格式)。                                                                                          |
| 未实现的历史承诺       | nudge、归档轮转、`Notice` / 撤回摄入、`quote` 发送者。                                                                                       |
| 提示词                 | 稳定区的分段与措辞最后定;现在只固定装配契约(哪些 tier 下有哪些段落)。                                                                        |
