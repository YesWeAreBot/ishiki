# Cortico 参考建议

> 来源：对 [Cortico](https://github.com/Pal-AI-Lab/Cortico)（基于事件流的 Agent Harness）源码和文档的分析，与 ishiki 和 athena-harness 做三方对比后提炼的可参考设计。
>
> Cortico 仓库位置：`D:\Codespace\references\Cortico`

---

## 1. 合批投递（P0 — 接受）

**ishiki 现状**：每条 `internal/session` 到达后独立调用 `agent.send(message, { trigger, ifBusy: 'join' })`。高频场景（群聊刷屏、多人同时发言）下，心智要么被逐条唤醒，要么靠 `join` 隐式聚合——但 `join` 的效果取决于心智是否恰好在忙，不可控。

**Cortico 的做法**：WakeBus 的 debounce 模式有三个参数（`quietGapMs` 2.5s、`minBatchAgeMs` 0、`maxBatchAgeMs` 15s），加上 `maxBatchSize` 100 条上限。安静间隔 + 最大等待 + 数量上限三条线确保"不会等太久，也不会太碎"。

**建议**：在 `ProfileRuntime` 的事件入口处加一个 debounce 层。不需要 Cortico 那么复杂的四模式——IM 场景下两个就够：

- **debounce**（默认）：消息到达后等一个安静窗口（比如 2s 没有新消息），或等到最大批龄（比如 10s），然后一次性投递整批。这对群聊多人发言尤其有意义：模型看到的是一个完整的对话片段而非碎片。
- **preempt**：私聊消息、@ 消息立即投递，不等 debounce 窗口。对应 ishiki 已有的 `trigger: true` 概念。

实现很轻：一个 `setTimeout` + 一个缓冲数组 + preempt 条件清空缓冲。合批后，`agent.send` 的参数从一条消息变成一批消息——这也意味着 `transformEntries` 投影在一个 step 内看到的不再是单条事件、而是一个时间窗口内的所有事件，帧渲染自然更完整。

当前 `join` 的隐式聚合可以保留作为兜底——合批投递的是第一条消息的 `send`，后续消息在 debounce 窗口内积累，如果心智碰巧在忙则 join 上去。

### Cortico 源码参考

- `src/core/bus.ts`：`WakeBus` 实现，四种触发模式（`preempt`/`flush`/`debounce`/`piggyback`）
- `src/core/types.ts`：`TriggerMode` 类型定义
- 配置默认值：`quietGapMs 2500`、`minBatchAgeMs 0`、`maxBatchAgeMs 15000`、`maxBatchSize 100`

---

## 2. 事件投递用 tool frame 而非 user message（延迟）

> 延迟理由：实际效果未知，不引入复杂度。

**ishiki 现状**：所有事件（focus 裸行、notification、switch 标签）都作为 user message 投递。`stableZone` 里告诉模型"user message 是这台机器在跟你说话"，但实际上 user message 里放的是其他人的聊天内容。

**Cortico 的做法**：外部事件放在合成的 `function_call("external_event_frame", "{}")` + `function_result("[3 new events]\n...")` 对中。ORIENTATION.md 明确告诉模型：「外面的人说的话在 `external_event_frame` 里；user message 永远是这台机器跟你说话」。

**潜在好处**：

- 语义更准确。user message = 系统给心智的指令/通知；tool result = 外界发生的事。这对模型的角色理解有帮助。
- 模型不容易把其他人的话当成"系统让我做的事"。user message 在很多模型的训练中暗示"请求/指令"，把聊天消息放在 user role 中是一个微妙的语义错位。
- tool frame 天然是一个原子单元：一整批事件在一个 frame 里，截断时整体保留或整体丢弃，不会切到一半。

**适配要点**：需要 `@yesimagent/core` 的 `AgentEntry` 支持 tool-call / tool-result 类型的 entry。`transformEntries` 投影输出的外部事件从 user message 改为 tool pair。

### Cortico 源码参考

- `src/core/loop.ts`：`appendEventFrame()` 方法，合成 `functionCall` + `functionResult`
- `src/core/loop.ts`：`EXTERNAL_EVENT_FRAME` 保留名，`RESERVED_FRAME_NAMES`
- `src/core/markers.ts`：`eventFrameHeader(count)` 生成 `[3 new events]` 头
- `src/core/util.ts`：`renderEventLines()` —— 只做 `events.map(e => e.text).join('\n')`，Core 不添加语义
- `bots/cormini/persona/ORIENTATION.md`：告诉模型 `external_event_frame` 是外界的人在说话

---

## 3. 环境提示词的动态段（延迟）

> 延迟理由：目前由 state delta 和 `<state>` 标签负责动态信息，要求前缀稳定以复用缓存，提供有限的动态片段。

**Cortico 的做法**：system prefix 在每次模型请求前重建。其中 World 的环境段由 `envPromptVars()` 提供动态占位符值——QQ 的 `{{qq.conversations}}`（当前监听的群列表）、`{{qq.identity}}`（连接状态）、Minecraft 的 `{{minecraft.world}}`（当前世界状态）都是实时值。前缀变化由 `prefixFingerprint` 检测。

**潜在好处**：prefix 能反映当前状态。比如有个群被移出监听列表了，prefix 里的频道列表立刻更新；bot 连接断了，prefix 里会写"连接尚未建立"。

**与 ishiki 的冲突**：ishiki 有意让前缀稳定以利用 prompt cache（`cachedInstructions`），每次重建会破坏缓存命中。Cortico 不依赖 prompt cache 或愿意为实时性付出 cache miss 代价。

### Cortico 源码参考

- `src/core/prefix.ts`：`assembleSystem()` / `assembleSystemSegments()` 每次请求重建
- `src/core/prefix.ts`：`collectWorldContexts()` 调用各 World 的 `envPromptVars()`
- `src/core/template.ts`：`renderTemplate()` / `renderSections()` 模板渲染
- `bots/cormini/persona/PREFIX.md`：顶层模板 `{{worlds.envPrompts}}`
- `bots/cormini/persona/ENV_SECTION.md`：每个 World 段的模板 `## {{world.id}}\n{{world.envPrompt}}`
- `src/worlds/qq/ENV_PROMPT.md`：QQ 环境模板带 `{{qq.conversations}}` 和 `{{qq.identity}}` 占位符
- `src/worlds/minecraft/ENV_PROMPT.md`：Minecraft 环境模板带 `{{minecraft.world}}`、`{{minecraft.explored}}`、`{{minecraft.policy}}` 等

---

## 4. DeliveryGate / 投递闸门（记录，延迟）

> 延迟。具体实现上可以提供一个工具和管理员命令，暂时将某个频道设置为"免打扰"。

**Cortico 的设计**：Persona 可以安装一个 `DeliveryGate`，按关键词或溢出条件扣留所有唤醒项。QQ World 的起草确认门就是用这个实现的：bot 起草消息 → 操作者在控制台确认 → 放行下一批事件。

**ishiki 场景**：心智正在处理一轮重要对话时，不希望被其他场景的 notification 打断。或者管理员需要暂停心智对某个群的响应。

**轻量实现方向**：

- 在 `ProfileRuntime` 上增加一个 per-channel `muted` 状态
- 事件继续写入存储，但 muted 频道的事件不触发 `agent.send`
- 提供一个心智可调用的工具（如 `mute_channel` / `unmute_channel`）
- 管理员通过 Koishi 命令或 WebUI 设置免打扰
- 恢复时把积压事件作为一批投递（与合批投递机制配合）

### Cortico 源码参考

- `src/core/types.ts`：`DeliveryGate` / `DeliveryGateApi` 接口定义
- `src/core/bus.ts`：gate 与 `paused` 的交互逻辑
- `src/worlds/qq/world.ts`：QQ World 的起草确认门实现

---

## 5. 事件的 `reaches` 逻辑外化为可配置规则（延迟）

> 延迟，可以留到后面做。

**ishiki 现状**：`reaches` 逻辑硬编码在 `eventRenders` 的每个事件类型里（私聊 → 穿透，@ 我 → 穿透，关键词 → 穿透）。

**方向**：把 `reaches` 逻辑从 `eventRenders` 里提出来，变成 Profile 级别的可配置规则。每个 Profile 可以声明不同的穿透策略。未来支持更复杂的条件：消息来自某个特定用户时穿透、消息包含图片时穿透、最近 N 分钟内该频道活跃度超过阈值时穿透。

### Cortico 参考点

- World 可见性由 `Core.setWorldVisible()` 运行时控制
- QQ World 有显式的"名单"概念——只监听名单里的群和私聊
- 事件投递由 WakeBus trigger + DeliveryGate 分层控制

---

## 6. 运行诊断与可观测性（记录，延迟）

> 延迟。

**Cortico 的做法**：每次 run 保存完整的 `events.jsonl`、`log.jsonl`、`transcript.jsonl`、`toolcalls.jsonl`，有 `logq` 命令行工具做查询，有 `diagnostics` API 导出脱敏诊断包。控制台有实时的 session 统计、用量面板、事件时间线。日志带关联字段（`sess` / `round` / `resp` / `call` / `ev` / `task`），30 秒内重复行折叠。

**短期最有价值的**：一个 tool call 日志——每次工具调用记录工具名、参数、结果、耗时、是否失败。在 agent plugin 的 `onStepFinish` 中自动写入。

**中期**：类似 Cortico `logq timeline` 的查询能力——把 JSONL 存储中的事件、工具调用、帧重建、focus 切换按时间归并展示。在 Koishi WebUI 里做一个面板。

### Cortico 源码参考

- `src/core/tool-log.ts`：工具调用记录
- `src/core/transcript.ts`：模型调用的上下文副本
- `scripts/logq.ts`：查询工具（`runs` / `log` / `timeline` / `turn` / `doctor` / `bundle`）
- `src/web/diagnostics.ts`：诊断包导出

---

## 不建议参考的

- **PWSR（Persona-World 状态对账）**：为 Minecraft 这种"运行时状态和语义记忆需要双向同步"的场景设计的，对纯 IM 场景的 ishiki 没有意义。
- **Provider 管理和本地模型托管**：ishiki 通过 `@yesimagent/gateway` 对接模型，不需要自己管理 llama-server 进程。
- **one-bot-per-process + 部署系统**：ishiki 跑在 Koishi 上，多 profile 共享一个进程，不需要独立的部署目录体系。
- **多语言控制台**：短期内没有必要。

---

## Cortico 架构速览

> 供后续查阅时快速定位。

**四层设计**：Core（机械生命周期）→ Persona（语义层，上下文构造 + Memory 解释）→ Memory（被动持久化）→ World（环境边界，事件 + 工具）。

**核心特征**：

- **World 与 Persona 之间没有程序接口，只有语义通道**：事件正文、工具描述+回执、环境提示词段。任何 World 与任何 Persona 可以自由组合。
- **Core 拥有主循环**（`loop.ts`）：模型调用、工具执行、重试、上下文交接都在 Core 中。Persona 通过钩子（`onDelivery`、`onHandoff`、`onTurnEnded`）参与语义决策。
- **诚实的认知论**：Core 不改写事件正文，系统生成的内容只陈述可确认的事实。
- **one-bot-per-process**：一个进程跑一个 bot，多份部署可以使用同一个代码包。

**上下文结构**：system prefix（Persona 段 + 各 World 环境段拼接）→ sessionHead（合成开头，不落盘）→ 持久化历史（internal → user message；external → tool frame `external_event_frame`）。

**事件合批**：WakeBus 四模式（debounce/preempt/flush/piggyback），统一队列，FIFO 投递。不同 World 的事件在同一个帧内按到达时间混排。

**扩展**：npm 包，三种 kind（`cortico-world` / `cortico-provider` / `cortico-bot`），契约版本化（`cortico.api`），控制台一键安装。
