# koishi-plugin-ishiki 设计规格

> 状态：进行中。本文记录**已确认的决定**、由底座推导出的**不变式**，以及**未决项**。
>
> 底座：`@yesimagent/core`（entry / turn / storage / plugin hooks）。`athena-harness/docs/cookbook/01-04` 是 athena 的产物，只作「主心智 / 三区 / 平滑过渡」的**模型参考**，不是本插件的既定设计——ishiki 的 agent loop 与存储都用 `@yesimagent/core`，与 athena 的 cortex / nerve / body 无关。

---

## 1. 定位与边界

- ishiki 是 Koishi 插件，目标 = 三区上下文 + 主心智模式。
- 不沿用 athena 的 cortex / nerve / body 设计。
- **一个 profile = 一个主心智 = 一个 `Agent` 实例。**

## 2. Profile

- 以 `profiles.yaml` 声明（数据目录下，不进 Koishi Schema、不上配置页）：

  ```yaml
  profiles:
    - id: "boki" # = 心智标识 = Agent id = 数据目录名
      dataPath: "data/ishiki/boki"
      model: "deepseek:deepseek-flash"
      # compactionModel: "..."                 # 可选；缺省用 model
      keywords: ["发布", "上线", "NekoChan"] # 关键词规则（策略，不落盘）
      allowedChannels: # 身体 → 该身体允许的频道（**身体集合的唯一来源**）
        - sid: onebot:1434974784
          channels: [channelA, channelB, "private:*", "!private:12345678"]
        - sid: onebot:12345678
          channels: [channelC]
        - sid: qq:4138444372060156334
          channels: ["private:*"]
  ```

- **没有 `bots` 字段**：一具身体的存在 ⇔ 它在 `allowedChannels` 里有条目（且至少一个频道）。`bodies` 是 `allowedChannels` 里出现过的 sid 集合——派生量不重复声明，避免两处需要保持同步。
  - 附带校验：`allowedChannels` 里的 sid 若在 `ctx.bots` 里找不到（适配器还没连上或拼错），`ready` 时打 `WARN`（不抛错——适配器可能稍后才连）。
- `allowedChannels` **同时是身体归属与频道白名单**：身体决定这具 bot 账号是否归这个心智，频道决定它是否被允许在那里运行。两者都成立才接管，**可见 = 可响应**。
- **隔离**：不同 profile 之间完全隔离，即使共用同一个 bot 账号。名字也不共享——昵称与频道名随事实一起快照（§3），一个 profile 里的改名不会改写另一个 profile 的历史。
- **摄入过滤**：`身体 ∈ allowedChannels 的 sid 集合` ∧ `频道在该身体的白名单内` ∧ `发送者 ∉ 该 sid 集合`。发送者是自己任何一具身体 → 直接 skip，不入 storage。
  - 推论：自己在本 focus 的动作由内核的 assistant / tool 条目承担，不靠 session 摄入；同一句发言不会在流里出现两次。
- **「两具身体落在同一个群」被配置层拒绝**（加载期抛错，见 implementation.md §4.1），所以不需要去重：跨平台（如一路 OneBot 民间协议、一路官方 QQ Bot）时 `messageId` 与 `userId` 的命名空间都不同，去重的输入本身不成立，只能在配置层拒绝；而这条路也判不出来（命名空间不可比，§4.2）。
- **外部 bot 就是普通用户**：不查名单、不识别、不抑制。
- **加载期静态校验**（三条，细节见 implementation.md §4.1）：① 同 profile 内、同一平台下两具身体的**多方场景**（群/频道）集合不相交——两方场景（`private:*`）**豁免**，因为 `private:U` 在两具身体下是两段不同的对话；② 跨 profile 同一 sid 的**全部**场景集合不相交（此处两方场景也校验——它管的是所有权划分，不是重复投递）；③ 不同平台的频道 id 不比较。失败 → 抛错，拒绝启动。
  - 频道规则的语义：`kind:exact`（精确）、`kind:*`（该 kind 的全部）、`!` 前缀为排除项。例如 `private:*` + `!private:A` 表示「除 A 以外的所有私聊」，于是共用同一 bot 账号的另一 profile 只能用 `private:A`。
  - 判定可算：kind 相同的 `*` 之间做补集运算，`*` 与 `exact` 之间做成员判定，kind 不同的天然不相交——不需要枚举运行期频道。
  - 零命中（没有任何 profile 接管某条 session）→ 静默忽略（不摄入、不响应）。
- **关键词规则**：`profiles.yaml` 每 profile 一段 `keywords`（与 `allowedChannels` 同级）。判定面 = `session.content`（渲染后的文本，即最终投影进上下文的同一份文本），不读平台原始的 `raw_message`——那要理解 CQ 码之类的平台格式，与「核心不硬编码平台细节」冲突。关键词属**策略**，不写进事实、不落盘。

## 3. 摄入层：事实（facts）

- `session → ishiki event`：每种 session 类型一个 projector，负责解析并填好**事实**。
- 事实**不含策略**：不写「这是不是 awareness」、不写「要不要渲染」。
- 声明为 `AgentCustomMessage`（`ishiki.message.created` / `ishiki.message.deleted` / `ishiki.notice` / `ishiki.focus.changed` / `ishiki.nudge`）。同一条对象既是**档案记录**也是 **turn 触发消息**（不触发时用 `send(message, { trigger: false })`）。
- **场景身份 = 身体 + 频道**：`Scene = (platform, selfId, channelId)`。`channelId` 的语义域是 `selfId`——同一平台下不同身体的频道 id 可比，跨平台不可比，所以身体必须留在身份里。
- 事件同样摄入；事件可作 event 型 awareness（poke / 撤回 / 成员变动…）。`login-*` 描述的是自己身体的状态，归档案 / state，不作 awareness。
- **事实字段（v1 范围）**：`quote` 只存 `{ id, content }`，不补被引消息的发送者；**不新增 `mentions` 字段**——被 @ 的信息按需从 `content` 解析（判定层只读 `content` + `selfId`）。
  - **平台差异在 projector 里归一化**：onebot 的 `message-created` 里 @ 是元素形式（`content` 内含 `<at id="…"/>`）；QQ 的群聊 @ 走**独立 session 类型**（`type=internal`、`_type=qq/group-at-message-create`，其 `_data` 里没有提升出来的 channel / message，需要读平台字段），projector 必须把这一信号归一化进 `content`——否则它彻底丢失。
  - 于是判定层不需要平台分支：`atSelf` = `content` 里出现指向本 profile 任一身体（= `allowedChannels` 的 sid 集合）的 at 标记。`quote` 的发送者判定仍然没有输入（§11.3）。
- 未知 session 类型：只档案，不渲染（fail-closed）。
- **名字随事实快照，不设全局实体表**：事实里带 `user: { id, name? }` 与 `channel: { id, name?, direct }`，取摄入那一刻 `session.author?.name` 与 `session.event?.channel?.name`。
  - 前缀稳定是白送的：改名只影响此后新摄入的事实，旧行永远是当时看到的名字，不需要渲染期解析这一步。
  - 代价是重复（同一个频道名在每行事实里各存一份）且没有追溯回填——改名不修正历史，也不打算修正。
  - 缺名回退到 id（fail-soft）。

## 4. 三区 = 纯派生

- **边界** = `ishiki.checkpoint` entry（`AgentCustomEntry` 扩展点）。payload 钉住：`frameFocus`、`prevFocus`、状态快照、LLM 累积摘要、时间戳。
- **不物化**：帧与工作区都由 fold 从 entry 流派生，合成条目不落盘。只有 LLM 摘要是物化产物（它派生不出来）。
- **帧结构**：

  ```
  帧 = [ 状态快照 + LLM 摘要 + focus 声明 ]
     + last_focus_history（起点 prevFocus，仅因 focus 变化重建时存在）
     + hist            （起点 frameFocus）
  ```

  一代只允许切一次 focus，所以前段是同质段，帧内不需要推进 cursor。

- **fold 只读近两代**：帧的内容来自 `[prevBoundary, boundary)`，工作区来自 `[boundary, now)`。更早的内容已经折叠进边界 payload 的摘要里，所以投影的成本与**代长**成正比，而不是与历史长度成正比。归档轮转（见下）把这条性质落到文件层面：当前文件的第一条就是边界。
- **压缩**：输入 = 上一代帧的两段内容 + 上一版摘要；输出 = **一段有 token 预算的自由文本**，写在边界 entry 的 payload 里落盘。使用的模型 = `compactionModel ?? profile.model`。压缩失败或写入失败 → 不写边界，本代继续，下次触发重试。形态后续可迭代为结构化分区（固定槽位：跨场景决策 / 未完成承诺 / 对人和场景的判断 / 上次切换原因）。
- **归档**：jsonl 过长（阈值按**文件字节数**，与 YesImBot 的 `session.archive.maxKB` 一致）或人工手动触发时轮转——把 `messages.jsonl` 移入 `archive/`，新建同路径的 `messages.jsonl` 并在头部写入一条 **compact**（= 边界 entry：状态快照 + 可选摘要）。于是归档之后帧的派生不再需要跨文件引用，更早的内容只以档案文件的形式存在。归档与重建是**同一种事务**（一次 `append` + 可选 LLM 压缩），同样只在无活动 turn 时发生。
  - **不需要自定义 storage，也不需要重建 Agent**：ishiki 的路径固定为 `messages.jsonl`，轮转是纯文件操作（rename + 新建 + 写 compact 头）。内核的 jsonl storage 每次 `read` / `append` 都按路径重新打开（`storage.ts:28-52`），所以文件被换掉后同一个 storage 实例继续可用；而 `Agent.storage` 是只读属性（`agent.ts:56`）这一点因此不再构成障碍。YesImBot 当年要「归档 = 重建 agent」，是因为它靠切换 active session 文件实现归档；ishiki 固定路径把这一步省掉了。
  - 对齐 YesImBot 的三条既有语义：空会话拒绝归档；有 summary 时新文件以 compact 开头；`no-summary` 是显式选项（用户接受叙事断档）。
  - **compact 失败 → 机械压缩回退（不用模型）**：归档的目的是**控制文件体积**，不是压缩上下文，所以模型不可用时不该阻止归档。机械压缩 = 把上一轮的渲染结果作为**文本快照**存入 compact，且该快照**不参与运行时渲染**；但**压缩输入把它当作上一版摘要**，于是下一次成功压缩会把它重新吸收进新摘要——机械回退 = 把叙事压缩延后一代，不是永久丢失。
  - **两种产物形状（按压缩路径分叉）**：
    - LLM 压缩成功 → 新文件 = `[compact(状态快照 + 摘要)]`，旧内容全部留在档案文件里；归档时刻的当前代内容由摘要承接（可能被摘要概括）。
    - 机械回退 → 新文件 = `[compact(状态快照 + 文本快照)] + 当前代条目原样搬入`。上下文**完全不变**，只削掉 frame 之前的历史。机械路径本来就不产出叙事承接，此时「搬」比「压」更诚实，也不会让一次模型故障变成一次失忆。
    - fold 不在乎形状差异：它只读当前文件，边界之后的条目就是工作区。
  - 自动归档的检查点与 YesImBot 的调度器一致：**只在没有活动 turn 时执行**。
- **切换条目**归它**离开**的那一块（放在前段尾）。
- **边界从哪来**：
  - 开局：全新 profile（stream 为空）在**第一次 turn 之前**写一条开局帧，声明初始焦点，并带一句只在这一代成立的话（"在此之前没有发生过任何事"——说的是记录，不是身体状态）。选在第一次 turn 之前而不是首轮结束之后，是因为后者会改写已经发出去的前缀。
  - turn 结束（`onTurnFinish`）：focus 发生变化 ∨ 本代条目量超阈值。
  - 空闲：本代有新条目 ∧ 静默超过 N（用于**提前压缩**，把成本移出 turn）。
  - **重启不是触发条件**——帧本来就从 storage 派生；旧流或开局帧写入失败时，投影按同一元素自行给出位置声明（cookbook 03）。
- **当代内禁止多次切 focus**：代码层冷却，判据 = 本代是否已有切换条目（从流里纯判定，零额外状态）。
- **重建事务** = 一次 `storage.append(...)`（边界 entry，摘要写在 payload 里）。没有内存工作区要清空，失败即无副作用，下次触发重试。
  - 注意：`plugin.onTurnFinish` 会吞掉异常（`core/agent.ts:326-332`），重建里调 LLM、写 entry 失败必须自己 catch + log。
- **剪枝不是独立步骤**，是 fold 按「条目落在哪一段」选的渲染粒度：本代原文；上一代折叠（工具结果压成一条记录、大块成功输出首尾保留、失败原因保留原文、已被状态快照取代的 state delta 移除）。

## 5. 渲染管线

| 阶段                                    | 输入                 | 输出                                           | 契约                                                    |
| --------------------------------------- | -------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `transformEntries(entries, { turnId })` | 全部 entry（含边界） | 原生 `AgentMessage[]`：帧或位置声明 + 本代投影 | 只能产出 message 条目，否则活不过 `agent.ts:172` 的过滤 |

- **投影只有一个 hook**：`transformEntries` 是唯一拿得到 entry 的 hook，所以边界、cursor、渲染与包装都在一次遍历里完成——不需要渲染 type，不需要第二个 hook，也不需要在 hook 之间传递投影语境。
- **投影输出原生消息**：帧是一条 `user` 消息，事实是裸行或 awareness 块的 `user` 消息，assistant / tool / `user` 条目原样通过；不再经由 `ishiki.render.*` 中转。
- **形态判定**：cursor 由帧声明的起点 + 已记录的切换推进；落在 cursor 场景里的事实渲染成裸行，别处**够得着**的事实包一层 `<awareness>`（判定与唤醒同源，所以叫醒本轮的那条事实不会在轮内不可见）。
- **格式**：行 = `[HH:MM] 名(userId) #msgId: 正文`（名缺则只写 id）；awareness 块头 = `<awareness sid channel name>`（`name` 缺则省略），**不带触发原因**——模型只需要知道"这条不在焦点里"。
- **位置声明已经写明焦点**，所以焦点内的行不逐条包装：一段连续的窗口内事件只在开头带一次 `<focus sid channel>` 块头（不闭合），中间夹进别的东西后再出现就重开一段；别处的事件整块包 `<awareness>`。`peek_channel` 的结果自带 `<peek sid channel count>`：它是回答，不是事件，必须自己声明读的是哪个场景。
- **run-length 块与 tier 降级尚未实现**：一条事实一条消息，也没有单场景裁剪。
- **帧的 focus 声明**写明当前场景：身体（`sid`）+ 频道（id 与可读名）。
- **帧渲染 = 整帧一条 `user` message**，内部用标签分区（focus 声明 / 状态快照 / 摘要 / `last_focus` 段 / `hist` 段）。语义上帧是「系统给它的状态陈述」，不是主心智自己的口吻——`last_focus` 与 `hist` 因此不再需要靠 role 区分，靠分区标签。
- **帧的确切布局**：`<frame at sid channel name>` + `<last_focus_history>` + `<history>`。`at` 是帧创建时间（`HH:MM`）；`sid` / `channel` / `name` 声明当前 focus，`name` 取该代首条同场景事实的频道名（没有就省略）。`<memory>` 是 LLM 摘要留的位置，v1 只有机械剪枝，整段不出现。`<last_focus_history>` 只在这一代发生过切换时出现（内容按 `prevFocus` 游标渲染）；`<history>` 恒在（内容按 `frameFocus` 游标渲染，为空时留空行）。投影自己给的位置声明是同一元素的空壳 `<frame …/>`：取值只用该代首条 entry 的时钟与 initial focus，所以同一 turn 的每一步渲染出同一串。
- **assistant 消息原样保留**：内核持久化的 assistant 消息（`agent.ts:258-266`）在**本代**的消息数组里原样渲染——文本与 tool-call 都在。tool-call 部分**必须**保留（与 tool result 成对，否则 provider 直接拒；剪枝也必须成对）；文本部分保留的收益是本代内的跨 step 连贯性，风险是自我强化（cookbook 01 经验法则 6）。
- **进入下一代时，自己的话不进帧区**：帧内容只收**工具结果**（`frameItemOf` 的 assistant 分支不产出任何东西），所以"上一代我说过什么"不会以原文重复出现——能延续的是行为与行为结果，不是措辞。这也顺带避开自我强化。`innerThought` 配置因此只影响提示词，不影响渲染。

## 6. 可见性与唤醒

|          | focus 场景的普通条目     | 命中事实的条目（任意场景）                                    |
| -------- | ------------------------ | ------------------------------------------------------------- |
| 进上下文 | 是（focus 形态）         | 是（非 focus 时为 awareness 形态）                            |
| 起 turn  | 否（累积，等下一次唤醒） | **是**（空闲时起新 turn；有 turn 在跑时作为 step delta join） |

- 可见性（渲染层）与唤醒（触发层）是**两套谓词**，事实由 projector 提供，策略不写进事实。
- `decide` = 场景相关性（cursor）∧ 事件相关性（事实）。
- awareness **不触发帧重建**；主心智可忽略、`peek_channel` 查看来源、旁路行动或切换 focus。

## 7. scope 降级与寻址

- **场景身份 = 身体 + 频道**（`(platform, selfId, channelId)`）。`channelId` 的语义域是 `selfId`：同一平台下不同身体的频道 id 可比，跨平台不可比，所以身体必须留在身份里。
- 降级维度是两个量：

  | 声明派生的 scope                           | 才存在的东西                                                                                                    |
  | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
  | 单场景（一具身体 + 它只有一个 exact 频道） | 无 `sid`、无 `channel`、无 `switch_focus`、无 `peek_channel`、无 awareness、无 focus 声明；提示词不含主心智叙事 |
  | 身体数 > 1                                 | `sid` 参数                                                                                                      |
  | 任一身体频道数 > 1                         | `channel` 参数                                                                                                  |
  | 场景数 > 1（即 `!singleScene`）            | focus 声明、`switch_focus`、`peek_channel`、awareness 判定机制                                                  |
  - 「单场景」按**声明**判定：`private:*` 展开的是家族，即使运行时只遇到一个私聊频道，scope 仍是多场景。
  - 这个公式成立靠一条静态校验：**同平台下同一 profile 的两具身体频道集合必须不相交**（implementation.md §4.1）。它挡住了"两具身体同频道"这种公式算不对、去重也救不了的形态。

- 降级必须在装配期**同时**落到四处：工具是否提供该参数、description 怎么写、提示词是否提及、**渲染格式是否出现该字段**。四者不同进同退就是 false capability 或幽灵参数。
- **寻址**：`sid` 省略即 logical focus 的身体；`channel` 省略即该身体唯一允许的频道（不唯一则必须显式给，否则结构化错误）。Koishi 的 `channel.id` 是裸 id（`data/` 样本：onebot `857518324` / qq `BC1E3F68…` / sandbox `@Alice`），所以 `sid` 决定命名空间。
- **可见与可响应**：`allowedChannels` 同时是身体归属与频道白名单——身体决定这具 bot 是否归我，频道决定是否被允许在那里运行；两者都成立才接管，接管即响应。

## 8. 工具

主心智的能力清单只有三项：切换默认情境、旁路读取、感知 awareness（awareness 不是工具）。工具集与它 1:1 对应，另加两个「表达 / 结束」的出口——不多不少。

| 工具           | 存在条件   | 作用                   | 关键点                                                                                                                                                                                                                                       |
| -------------- | ---------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message` | 所有 tier  | 唯一的表达出口         | 省略 `sid` → logical focus 的身体；省略 `channel` → 该身体唯一允许的频道；`messages[]` 多条 = 多气泡（拟人分句）；`mode` = element / raw；`continue` 为真则发完继续本 turn，否则结束 turn（`onStepFinish` 决定，见 implementation.md §11.3） |
| `finish`       | 所有 tier  | 显式结束 turn 而不发言 | 让「不回复」成为显式决策（"我看过了 / 我已完成"）。备选名 `wait` / `skip`，语义固定为「结束 turn」                                                                                                                                           |
| `switch_focus` | 场景数 > 1 | 改变默认情境           | 只改 logical focus（场景 = 身体 + 频道）并追加一条 `ishiki.focus.changed` 事实；**不立即重建帧**（turn 结束才重建）；代内冷却：一代只允许一次                                                                                                |
| `peek_channel` | 场景数 > 1 | 不改 focus 的旁路查看  | 结果是 tool result，进当步工作区；不改 focus、不触发重建                                                                                                                                                                                     |

- 平台原生能力（禁言、撤回、精华、表情回应…）不属 v1：由附属插件按 profile 注册、按 tier 门控，走同一套工具注册概念。
- 不把 `send_sticker` / `send_voice` 拆成独立工具：在用户看来都是"发消息"，用 `send_message` 的 element 模式表达。
- 不提供记忆 / 检索类工具：v1 没有长期记忆机制，且 `notes/others/04_系统架构重审.md §4.11` 记录过「模型不会主动使用检索工具」。
- 工具通过闭包捕获该 profile 的 `ctx` 与运行时窄接口（读 logical focus、追加切换条目、读档案窗口）；用窄接口而非整个 Agent 实例。
- **需要但不是工具**：稳定区里要列出「身体 → 该身体可达的频道」（静态配置派生量，缓存友好，不必为此新增工具）。工具的参数与返回值只写在工具 schema 里——稳定区再抄一份就会与 schema 漂移（`inner_thought` 就漂过一次：稳定区写了、schema 里没有）。
- **稳定区讲的是模式**：一次唤醒是一个 turn、turn 由 step 组成、怎么结束本轮、`finish` 是沉默这个选项、focus 是什么、焦点内的事件是裸行、别处的事件带 `<awareness>` 包装、有没有切过 focus 看 `[focus change]`。

### 8.1 step 0 未产出工具调用（兜底）

不用 `toolChoice: "required"`——部分模型在思考模式下会以 400 拒绝它。改为**事后校验 + 一次重试**：

- **判据**：`onTurnFinish(result)` 里检查 `!result.messages.some((m) => m.role === "tool")`（本 turn 从未产生工具结果 = 从未调用过工具）。等价于「step 0 只输出了文本」——零工具调用时内核的 `continue` 为 false，turn 直接结束（`agent.ts:316`）。
- **重试**：写入一条 nudge（CustomMessage），`send(nudge, { trigger: true })`。内核没有"零调用后继续同一 turn"的路径（`turn.ts:143-188`），所以重试必然是新 turn。
- **必须 `ifBusy: "defer"`**。`onTurnFinish` 在 `runTurn` 内、队列仍认为该 turn active 时被调用（`turn.ts:143-188`）：
  - `"reject"` → 抛 `AgentBusyError`，而插件异常被内核吞掉 → 静默失败；
  - `"join"` → 消息落进正在收尾的 turn 的 joined 列表，而 `drainJoined` 只在下一次循环迭代读取 → **静默丢失**；
  - `"defer"` → 排队，`runTurn` 返回后继续 pump，重试成为下一个 turn。
- **成本低**：重试请求的 instructions + 帧 + 工作区逐字节不变，nudge 只追加在尾部 → 前缀缓存全命中，只多付 nudge + 输出 token。
- **有界**：最多重试一次。再一次仍无工具调用 → 接受为「不回复」，记 warning（避免死循环）。
- 后续 step 不强制；文本输出结束或 `finish` 都可以。
- **nudge 的可见范围 = 随流保留**：它像普通条目一样经剪枝进入 `last_focus_history` / `hist`。这样 fold 保持「只按形态判定、没有按年龄的特例」的均匀性，也与「失败的原文必须保留」一致（cookbook 01 经验法则 2）。噪音有界——重建时它会被折叠进压缩摘要。措辞应中性（陈述事实，不责备），避免模型模仿自己的失误。

> 副作用：`toolChoiceViolation: "fallback"` 在不指定 `toolChoice` 之后成为死配置，应移除。

## 9. 不变式

1. **前缀稳定**：instructions + 帧逐字节不变；变化只发生在边界（重建时整块换）。
2. **形态一次性判定**：条目进入序列时的形态不再变。cursor 链由流本身确定，重放一致。
3. **边界只在无活动 turn 时写入**（turn 结束 / 空闲 / 归档）。「turn 内帧冻结」是结构性的，不靠约定。
4. **可见性没有结构保证**：摄入条目是 CustomMessage，天生走消息路径，因此必须由 fold 显式表态（丢弃 / 改写）。
5. **工具 schema、description、提示词三者同进同退。**
6. **流只增不改**：撤回、编辑、封禁、身体离线等「后续事件否定先前条目」的情况，本代只能以追加 delta 表达；真正移除只能在重建时由剪枝完成。
7. **条目只在 step / turn 边界落盘**（内核保证，见 implementation.md §11）：工具配对不会被渲染块打断，因此折叠层不需要任何缓冲或重排规则——它只按流顺序映射。

## 10. 收敛记录与未决项

### 10.1 曾提出、已收敛

| 议题                    | 结论                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身体集合的来源          | 删除 `bots` 字段：**身体集合 = `allowedChannels` 里出现过的 sid**（单一声明点，§2）                                                                                                                       |
| 场景身份是否含身体      | **含**：`Scene = (platform, selfId, channelId)`。跨平台时 channel id 不可比，身体必须留在身份里                                                                                                           |
| 同一频道多具身体        | **配置层静态拒绝**，且只针对多方场景（群/频道）：私聊在两具身体下是两段不同的对话，豁免（implementation.md §4.1）；同一群被两路接入（民间协议 + 官方 Bot）不可静态判定，v1 承认并加运行时同名告警（§4.2） |
| 别的心智的 bot          | 当普通用户，无"外部 bot 名单"                                                                                                                                                                             |
| `endTurn` 的归属        | 从 `ToolResultInfo` 移到 `onStepFinish`（implementation.md §11.3）——结束 turn 是 step 级策略，不是工具返回值                                                                                              |
| 事实 vs 渲染数据        | 事实只存 id；`nickname` / `channelName` 由**全局实体表**在渲染期解析（§3），缺名回退 id                                                                                                                   |
| 渲染 type 命名          | `ishiki.render.*`，与事实 type 在名字上分开（§5）                                                                                                                                                         |
| 存储层                  | v1 用 jsonl + 归档轮转（§4）；不需要自定义 storage，也不需要重建 Agent                                                                                                                                    |
| 归档时 compact 失败     | 机械压缩回退，产物形状按压缩路径分叉（§4）                                                                                                                                                                |
| 空闲重建的用途          | 提前压缩，把成本移出 turn（§4 触发条件）                                                                                                                                                                  |
| 时间跳跃断块            | 断；阈值 T 只看相邻两条的时间差（§5）                                                                                                                                                                     |
| 帧的 role               | 整帧一条 `user` message（§5）                                                                                                                                                                             |
| 独白的渲染              | 本代原样保留（文本 + tool-call，后者必须成对）；进入帧区时只保留工具结果，自己的话不进帧（§5）                                                                                                            |
| nudge 的可见范围        | 随流保留，不给 fold 加按年龄的特例（§8.1）                                                                                                                                                                |
| `toolChoice` 强制       | 不指定参数，改事后校验 + 一次重试（§8.1）                                                                                                                                                                 |
| `peek_channel` 结果形态 | 场景标注由工具自己的输出文本承担，走内核 tool message 路径，不新增渲染 type（§8）                                                                                                                         |
| 「我的 messageId 集合」 | v1 不需要（fail-closed）；将来需要时来源 = `send_message` 的 tool result                                                                                                                                  |

### 10.2 仍未定 / 待补

| 项                 | 说明                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| 状态快照 v1 装什么 | **v1 不做**——等 state 服务                                                  |
| `quote` 的发送者   | v1 不补，所以「这条在回复我」不可判（§11.3）；要做时给 `quote` 加发送者字段 |
| 提示词模板结构     | `notes/tasks/0913.md` 的进行中任务                                          |

## 11. 参数与默认值（v1）

### 11.1 插件级（Koishi Schema）

| 参数           | 默认                        | 消费点（谁读 / 何时）                                                                             |
| -------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `profilesFile` | `data/ishiki/profiles.yaml` | 插件 `ready` 时读一次 → 为每个 profile 建一个 `Agent`（各自的 storage / 计时器 / projector 集合） |
| `logLevel`     | `INFO`                      | 插件构造时设一次                                                                                  |

### 11.2 profile 级（`profiles.yaml`）

| 参数                             | 默认                                                     | 消费点（谁读 / 何时）                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id` / `dataPath`                | 必填                                                     | 装配期：`Agent` id、`<dataPath>/messages.jsonl`、档案目录                                                                                              |
| `allowedChannels`                | 必填                                                     | ① 装配期：**身体集合 = 出现过的 sid**（§2）、身体数与频道数 → tier；② 摄入层：`selfId` 匹配、白名单、self-skip；③ 加载期：同平台身体频道集合不相交校验 |
| `allowedChannels`                | 必填                                                     | ① 摄入层：每条 session 是否接管；② 装配期：场景数 / 频道数 → 三处降级；③ 启动：同一 sid 的频道集合两两不相交校验                                       |
| `model`                          | 必填                                                     | 装配期：`createAgent({ model })`                                                                                                                       |
| `compactionModel`                | = `model`                                                | 每次边界重建与归档：生成摘要                                                                                                                           |
| `keywords`                       | `[]`                                                     | fold 的 `decide()`：每 step 对每条非 focus 条目判定可见性；session 处理器判定唤醒                                                                      |
| `innerThought`                   | `false`                                                  | 为真时 `send_message` 的 schema 才带 `inner_thought`（说明由参数描述承担），发消息时顺带记一条 `ishiki.inner.thought`（本代可见，不进帧）              |
| `context.workspaceTokenLimit`    | **不填 = `0.5 × 模型声明的窗口`**（拿不到窗口用 `8192`） | `onTurnFinish` / 空闲：本代条目字符数 ÷ `charsPerToken` 超阈值 → 落一帧                                                                                |
| `context.charsPerToken`          | `4`                                                      | 同上：字符 → token 的换算（中文密度高，可调小）                                                                                                        |
| `context.idleMs`                 | `30min`                                                  | 空闲计时器：无活动 turn ∧ 本代有新条目 ∧ 静默超阈值 → 提前落帧                                                                                         |
| `context.historyEntries`         | `40`                                                     | 落帧：未发生切换时带进新帧的尾部条目数                                                                                                                 |
| `context.focusHistoryEntries`    | `40`                                                     | 落帧：发生切换时给新焦点现查的条目数                                                                                                                   |
| `context.toolResultChars`        | `2000`                                                   | 落帧：工具结果与其它长文本的截断上限                                                                                                                   |
| `compaction.maxTokens`           | `1000`                                                   | 压缩器：摘要输出预算                                                                                                                                   |
| `block.gapMinutes`               | `30`                                                     | fold 分块：相邻同键条目时间差超阈值 → 断块                                                                                                             |
| `archive.maxKB`                  | `5120`（`0` = 禁用）                                     | 归档检查（turn 结束 / 空闲）：当前 `messages.jsonl` 超阈值 → 轮转                                                                                      |
| `focusSwitch.minIntervalMinutes` | `0`                                                      | `switch_focus` 的 `beforeToolCall`：上次切换发生在多久之前（时间取自边界 payload）                                                                     |
| `wakeOn`                         | `["direct", "atSelf", "keyword"]`                        | session 处理器：命中才 `trigger: true`（见 §6 的两套谓词）                                                                                             |
| `send.maxBubbles`                | `5`                                                      | `send_message` 入参校验：超出返回结构化错误，绝不静默截断                                                                                              |
| `peek.limit` / `peek.maxLimit`   | `20` / `50`                                              | `peek_channel`：默认条数 / 硬上限（超出报错）                                                                                                          |

### 11.3 唤醒谓词的输入从哪来

`wakeOn` 默认 `["direct", "atSelf", "keyword"]`。三条输入都不需要额外字段：

- `direct` → `session.isDirect`（Koishi 访问器）
- `atSelf` → 解析 `content` 里的 at 标记，比对本 profile 的身体集合（§3）。平台差异在 projector 里抹平：onebot 的 @ 本来就在 `content` 的元素形式里；QQ 的群聊 @ 是独立 session 类型（`_type=qq/group-at-message-create`），projector 负责把这个信号文本化进 `content`。**不写入 `mentions` 字段。**
- `keyword` → `profile.keywords` 与 `session.content` 的包含判定

`quote`（「这条在回复我」）仍然不在 v1：`quote` 只存 `{id, content}`，没有发送者。

> 已知平台事实：QQ 群机器人只会把 **@ 它的消息**推给 bot（`qq/group-at-message-create` 是唯一可用的群消息类型），所以「QQ 群里的普通消息」在这个适配器上本来就不存在。

### 11.4 `rebuild.tokens` 的口径

**预算只算「本代在频道里发生的事件」**：边界 `ishiki.checkpoint` 之后的所有条目（摄入事实、assistant / tool 条目、state、nudge），字符数 ÷ `charTokenRatio`。不计入：

- instructions / persona / 工具 schema——它们根本不在 entry 流里；
- 帧区（边界之前的内容）；
- 上一版摘要——它在边界 payload 里。

实现：turn 结束（`onTurnFinish`）时扫一次 storage，从后往前找最后一条 `ishiki.checkpoint`，累计其后条目。成本与「fold 每 step 全量读一次」同阶（`agent.ts:170`），一次 per turn 可以接受，且不引入需要跨重启同步的新状态。

一个顺带的性质：这个口径也**间接约束了帧的规模**——帧就是上一代工作区的剪枝产物，工作区被阈值卡住，帧就跟着被卡住。

**默认值**：显式配置 `rebuild.tokens` 就用那个绝对值；不填则 `0.6 × 上下文窗口`（窗口拿不到时 `contextTokens`，默认 `65536` → ≈ `39k`）。因为预算只覆盖事件，剩下的四成窗口正好留给稳定区、帧、输出与增长。

计量用字符估算（`字符数 ÷ charTokenRatio`）。想要更准可以改用 provider 上报的 `usage.inputTokens` 反推（它含稳定区 + 帧 + 工作区，减掉装配期已知的稳定区即可），属于精度优化，v1 不做。

## 12. 出处

- 内核：`yesimagent/packages/core/src/{agent,plugin,entry,message,storage}.ts`（本文引用的行号以此为准）。
- 会话样本：`packages/koishi-plugin-ishiki/data/*.json`。
- 讨论记录：`notes/tasks/0912.md`、`notes/tasks/0913.md`、`notes/tasks/0828-上下文构造机制.md`。
