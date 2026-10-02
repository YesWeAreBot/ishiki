# 跨频道融合机制（Cross-Channel Profile）架构设计

状态: 待验证（依赖长上下文信噪比与寻址准确率）
日期: 2026-09-27
来源: 推理视窗的统一与群私穿透讨论(~\.omp\agent\sessions\--D--Codespace-YesWeAreBot-ishiki--\2026-09-26T17-28-58-315Z_01a0dec3-54cb-700e-9220-07a7ed99958e.jsonl)

## 结论

一个 `profile.yaml` 定义一个 profile，目录名就是它的全局唯一 id：profile 下要么挂 `scenes`（普通形态，每个 scene 是一个生效单位，可就地扩展 profile 基线），要么以 `cross: true` + `claims` 声明 profile 自身即生效单位（全部 claims 的频道并集）。cross profile 聚合为一个 `AgentRuntime` 实例与同一份物理 `events.jsonl`（落盘在 `profiles/<id>/cross/events.jsonl`），以 profile 的 id（目录名）为聚合命名空间。彻底废弃 focus 注意力焦点和 awareness 机制，输入端实行全量消息带寻址头入流与同源 run-length 合并，输出端由 `send_message` 工具显式指定目标坐标，以最简的多路复用黑板模型解决群聊与私聊之间的因果断裂与失忆问题。

## 被否定的前提

1. **原假设：跨场景上下文连续性可以通过独立 Agent 之间的只读窥视（`peek_channel_history`）或内生刺激优雅解决。**
   - **为什么站不住**：私聊被唤醒时面对空白上下文，模型缺乏“我需要去窥视其他群”的自知之明，工具调用率极低。
   - **反例与推翻事实**：测试表明不同上下文的 Agent 交流远远不够，无法支撑群聊转私聊、私聊转群聊的高因果连贯性；通过外部硬编码标记注入提示词又引入了严重的模块耦合。

2. **原假设：同一 profile 下所有场景必须严格物理隔离，一个频道只能有一个独立上下文与 Agent 实例。**
   - **为什么站不住**：将物理隔离作为绝对不变量，切断了多信道融合的可能性，使得强相关场景（如特定用户私聊与管理群）无法形成共同语境。
   - **替换判定**：全局物理隔离依然是普通场景的默认基石，但应当允许配置者按需声明局部的共享视窗。

3. **原假设：没有默认投递目标会导致流式文本输出无法寻址且产生静默丢包。**
   - **为什么站不住**：ishiki 的底层架构中模型正文文本仅作内省，所有实际消息发送均强制走 `send_message` 工具；且唤醒机制属于多事件延迟合批，并不存在单一天然触发源。
   - **推翻事实**：工具入参显式寻址配合报错重试闭环，比动态维护易漂移的默认目标更可靠。

4. **原假设：cross 以 profile 上的布尔字段（`cross-channel: true`）声明，Scene 引用该 profile 自动聚合。**
   - **为什么站不住**：一个 profile 承载两种配置语义——`typing`/`failover` 等 per-channel 字段在共享实例下语义漂移，schema 无法表达「cross 时禁止写」；聚合关系隐式，哪些 Scene 合流要按引用关系全文拼图；给已有多 Scene 引用的 profile 加 cross 会立即合流全部引用者，副作用范围不由声明处决定。
   - **替换判定**：单文件单 profile 的结构——普通 profile 挂 `scenes`，cross profile 用 `cross: true` + `claims` 自成生效单位。归属由结构显式声明，合流范围 = 声明处所见。scene 扩展与 cross 禁令都成为结构事实，无需规则条文。详细论证见 `03-community-extension-mechanism.md`（装配层级与配置面两节）。

## 新机制

### 1. Profile 聚合与生命周期

- 一个 `profile.yaml` 定义一个 profile，目录名即全局唯一 id，文件内不再有 `id`：profile 下要么有 `scenes`（普通形态，每个 scene 是独立生效单位，可就地扩展 profile 基线），要么 `cross: true`（cross 形态，profile 自身是生效单位，`claims` 按 sid 认领频道：`claims: { "<sid>": { whitelist, blacklist } }`）。两者互斥，装载期校验。
- cross profile 的配置只有 profile 层生效：`claims` 之外的全部运行参数（model / context / wakeup / toolcall / typing / extends）内联在 profile 块内，无 scene 层扩展权。被此 profile 认领的频道不再为每个 `channelId` 单独创建实例，而是以 profile 的 id 为聚合键，在 profile 内实例化唯一的共享 `AgentRuntime`。
- 引擎实例随 `AgentRuntime` 诞生与销毁，一个实例一套；配置走三层合并，scene 可就地覆盖。cross profile 没有 scene 层，引擎配置只能写在 profile 上——这是结构决定的。引擎不共享实例，也没有跨实例状态池：`WakeupEngineDeps` 只带一个可选 logger，账本只看本视窗的事实流。
- 物理存储落盘至共享路径：`data/ishiki/profiles/<profileId>/cross/events.jsonl`。
- 选择结构声明而非引用式聚合的理由：布尔字段（`cross-channel: true` 打在别处，Scene 按引用合流）使聚合关系隐式——哪些 scene 合流要按引用关系全文拼图，且给已有多 scene 引用的配置加 cross 会立即合流全部引用者，副作用范围不由声明处决定。结构声明下归属写在同一个文件里：`scenes` 与 `cross: true` + `claims` 互斥且都在声明处所见，合流范围就是写下 `claims` 的那几行。

### 2. 时序事实流与输入投影

- **无过滤全量入流**：命中白名单的所有进门消息按绝对时间戳追加写入共享事实流，不设低优先级遮蔽，不做 awareness 通知包装。
- **寻址头标识**：
  - 单 `sid` 场景：寻址头可省略 `sid`，形如 `[#channelId | 发送者]`。
  - 跨平台 / 多 `sid` 场景：寻址头采用统一的复合坐标，形如 `[#sid/channelId | 发送者]`。
- **Run-Length 合并**：同一来源频道在连续时序上的多条连续消息，在渲染为模型上下文时做合并压缩，共享同一个块头。

### 3. 出站路由与工具调用

- `send_message` 工具在跨频道模式下解除当前单场景绑定的闭包限制，要求模型显式传入目标参数 `target: string`（如 `channelId` 或 `sid/channelId`）。
- 若参数缺漏或解析到无效频道，工具执行失败并返回明确的错误提示给模型，由模型在下一步自律修正，杜绝投递悬空。

## 已定细节

1. **架构模式**：采用全员共享黑板模型，不引入 Git 分支式 fork/merge、闲置判定或异步总结文档回写等重型状态机。
2. **安全与隐私权衡**：多用户私聊与群聊混杂在同一文件中的数据边界风险，由部署者通过精细配置 `whitelist` 自行圈定范围承担，内核不做不可靠的自然语言语义过滤。
3. **唤醒调度**：任何落入该 profile 的场景（或其合流视窗）的事件，均由该实例的唤醒引擎评估是否触发当次推理。

## 待验证假设

1. **寻址准确率**：在多频道消息高频交错的复杂上下文中，模型能否稳定识别块头并正确提取目标坐标，不发生跨群投递幻觉。
   - **验证方式**：在包含 2 个群聊和 1 个私聊的真实会话中注入交叉讨论，观察 `send_message` 目标传参的正确率与报错重试频率。
   - **失败意味着**：需要强化上下文模板中的块头格式规范，或在出站时增加启发式目标校验规则。
2. **信噪比与窗口膨胀**：真实活跃群聊的全量消息无差别进流，是否会过快推高 Token 消耗并引发频繁的上下文压缩，从而挤压有效记忆。
   - **验证方式**：在真实群聊下持续运行并监测共享 `events.jsonl` 的增长曲线与 `compact` 触发周期。
   - **失败意味着**：需要在摄入端引入更严格的合流前置过滤，或限制共享 profile 绑定的群聊数量。

## 下一步

1. 在 `packages/koishi-plugin-ishiki/src/profile.ts` 中扩展 profile Schema，增加 `cross` 配置字段。
2. 在 `packages/koishi-plugin-ishiki/src/runtime.ts` 中改造 `ProfileRuntime.route` 与 `ensure` 流程，支持按 profile 聚合构建共享 Runtime。
3. 改造 `send_message` 工具签名及上下文渲染器，支持复合寻址目标头与 Run-Length 消息合并。
