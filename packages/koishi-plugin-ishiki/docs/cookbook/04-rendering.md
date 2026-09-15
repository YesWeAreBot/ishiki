# 04 · 事件扩展与渲染

> v1 已确认的设计契约，不代表源码已实现。注意力语义见 [02-attention.md](./02-attention.md)，帧生命周期见 [03-context.md](./03-context.md)。

## 边界

这里的 core 指 **ishiki 产品核心**，不是 `@yesimagent/core`。

- ishiki core 负责注意力、中心化触发、渲染器注册表，以及内部预设消息 / 事件的处理。
- 扩展插件注册事件名，通过 `declare module "@yesimagent/core"` 扩展 `AgentCustomMessage`，并提供摄入处理器与正文渲染器。
- `@yesimagent/core` 保留通用 storage、消息类型、hook 和模型调用流程，不引入 ishiki 的 focus / awareness 语义。

类型声明提供编译期关联，注册表提供运行时分派。核心不通过不断增加 switch 分支来理解外部 payload。

## 消息事实

`ishiki.message.created` 是核心定义的消息事实：

- 增加 `kind: "private" | "channel"`，私聊也有 channel 地址；`guildId` 仍是可选父级，不是第三种 kind。
- 保存 Koishi `content`。需要识别 @ 时用 `h.parse(content)` 取得 elements；关键词直接在 `content` 上做字面子串匹配。不重复存储 `elements`、`atSelf`、`mentionsSelf` 或 `isDirect`。
- 保留来源、发送者、消息 ID、时间及可选 `quote` 等事实。
- 不写入 `shouldTrigger`、意愿分数、focus / awareness 标记或已渲染正文。

触发由独立的 profile 级引擎处理，不挂在事件注册定义上。引擎先结合待提交事实、已有历史和运行时状态评估，再由 `agent.send` 统一提交事件与 trigger 选项；不是先入库再判断。v1 只实现 @ 自己、私聊与 content 关键词触发，详见 [02-attention.md](./02-attention.md)。

## 摄入与渲染处理器

```text
摄入：Koishi session → 对应类型的 AgentCustomMessage
渲染：对应类型的 AgentCustomMessage → ModelMessage[]
```

Koishi session 是平台事件入口，不是唯一入口。插件可以直接构造并提交事件，例如心跳，不必伪造 session。事件入口由 core 决定是否唤醒；插件也可直接 `agent.send` 显式请求运行，跳过 ishiki 策略但遵守 Agent busy 机制。v1 触发引擎不增加定时检查，也不因此要求实现定时器插件；帧重建的空闲触发保留。

正文渲染器由 ishiki 统一注册表管理；核心内置类型也走该注册表。插件不通过各自的 yesimagent `toModelMessages` hook 竞争处理权。

一条事实可以渲染为多条连续的模型消息。文本正常渲染，多模态附件保留为 content parts；不将整组输出压成纯文本，也不与相邻事实合并。

注册定义还提供 `isVisible` 处理器，可隐藏 focus 内事件；通过可见性判定后，由 core 决定 focus / awareness 分类与包装。可见性与触发的四种组合都允许，见 [02-attention.md](./02-attention.md)。

## 公共来源契约

方向已确认：由 ishiki 定义公共来源契约，扩展事件遵守各归属域的必需字段。core 无须理解外部 payload，即可取得其来源。约束应在 ishiki 的注册接口落实；`declare module` 本身不保证第三方继承这些契约，也不限制 yesimagent 的全部自定义消息。

具体 `EventSource` 结构尚未确定，`DirectEvent / ChannelEvent / GuildEvent / GlobalEvent` 只是候选名称。是否单列账号域、sid 在哪些域必填，也未冻结；不得据此实现一套既定枚举。

- 事件来源、focus 和工具 target 不共用一个不断扩张的联合类型；不为候选事件域自动增加新的 focus 或选址模式。
- 来源解释集中在分发与注意力逻辑，避免 renderer、工具和消息意愿策略各自遍历全部来源类型。
- 不为未来兼容把来源字段全部改成可选，也不预先增加通用 source resolver 或能力层。
- 只覆盖当前真实入口，不为“只有 guildId、没有 channelId，且无法唯一归属 profile”的假设场景设计规则，不增加 guild 专属分发配置。未来确有需求再细分。新增来源不应迫使无关消费者修改。

公共来源契约方向已定，不再将每个插件自定义的来源提取器视为并列已选方案。具体字段形状、域划分和匹配规则在数据流收口后确定。

## 在 transformMessages 完成投影

```text
storage 中的原始事实
  → transformEntries 提供检查点 / 帧边界所需信息（具体接法待定）
  → ishiki transformMessages 按历史顺序遍历
      → 从帧的起始 focus 推进 cursor，遇 focus-change 换挡
      → 调用注册的 isVisible；不可见则跳过本条渲染，不影响触发路径
      → 按事件名调用注册渲染器
      → 为非 focus 可见消息添加 awareness 包装
      → 给 ModelMessage[] 补齐 id / timestamp，输出原生 AgentMessage[]
  → yesimagent 原生 AgentMessage → ModelMessage
```

- `AgentMessage` 已包含 user / system / assistant / tool 类型，输出不必保持为 custom。
- 原有 assistant / tool 消息直接保留，不交给事件渲染器重造。
- 最终投影只服务本次模型调用，不回写 storage。每 step 仍从事实流重新投影，不缓存渲染结果。
- 不引入 `ishiki.render.*`、内置 custom 文本中转，或跨 hook 的 focus / awareness 临时标记。
- 渲染器遵守同一代前缀稳定约定；不读取当前 logical focus 回头解释旧消息，不执行触发引擎的有状态决策。

## 为什么不放在 toModelMessages

yesimagent 的 `toModelMessages` 是 first-win：第一个非 `undefined` 返回值结束分派，`[]` 也会终止。它不是“插件先渲染、core 再包装”的流水线，且只接收单条消息。

统一注册表不必由同名 hook 调用。放在 `transformMessages` 内即可在一次遍历中完成 cursor、渲染和包装，无须为传递投影语境新增消息类型。

当前内核没有默认的 custom → user 转换。原生转换保留 content，但 user / system 顶层 `providerOptions` 尚未透传；若渲染器依赖它，需要补齐此通用转换边界，不能假定任意 ModelMessage 都能无损往返。

## 注册与投影失败

- 同一事件名重复注册：拒绝后一次注册并明确报错，保留已有注册，不静默覆盖，也不采用渲染 hook 的 first-win 作为注册规则。
- 渲染器不存在（包括插件卸载后读取历史事件）、`isVisible` 或正文渲染器抛错：记录事件类型、事件 ID 与失败原因，跳过该事件，继续后续上下文构造，不中断整个响应流。
- 跳过该事件整组渲染结果，不输出半条正文或未闭合的 awareness 包装；原始事实仍保留在 storage。
- 这条容错限于扩展投影，不吞掉核心存储或检查点保存错误。触发评估失败单独按 `trigger: false` 提交，见 [02-attention.md](./02-attention.md)。

## 实现计划中落实

- 公共来源字段与注册接口的具体形状，仅覆盖当前真实入口；不冻结候选事件基类，不追加假设性 guild 域需求。
- profile 级触发引擎的新增输入、历史查询、运行时状态与注册方式；事件注册中不增加逐事件触发判定器。
- 一对多投影的派生消息 ID 规则，以及 checkpoint 信息如何到达流投影入口。
- 原生消息转换的字段保真与扩展生命周期的具体接法。
