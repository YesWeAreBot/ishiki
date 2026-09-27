# 03 · 上下文

模型看到的是这个场景自己的近期记录，不是一份写回磁盘的帧。投影不写回事实流——唯一的例外是压缩水位（下文的 `ishiki.compact`）。

上下文由**上下文引擎**组装，同族互斥，preset 选一个。现有的两种。

## `standard`（缺省）

以字符数为预算，超了就压缩最旧的一段。

```yaml
context:
  engine: standard
  standard:
    maxChars: 24000 # 单轮模型输入的文本上限（字符数）
    refillRatio: 0.8 # 压缩后压到上限的多少，留出余量
```

- **前台同步裁剪**：装配时只算体积、切最旧的一段，**不调用模型**，任何一轮都没有额外延迟。切点必须落在 user 行或自定义消息行上——截断工具调用与结果的配对会被提供商拒绝，所以工具轨迹整段留在切点之后。
- **后台异步压缩**：一轮结束后，如果上一轮是超预算装配的，就把切掉的那段并进摘要。压缩在后台跑，聊天照常；压缩失败不影响本轮，下一轮结束再试；场景停止时压缩中的请求一并中止，之后才回来的摘要一律丢弃。
- **水位写回事实流**：压缩成功时追加一条 `ishiki.compact` 条目，载荷是 `{ summary, lastEntryId }`——`lastEntryId` 是本次并入摘要的最后一条记录，锚点。下一次装配从这里往后取，摘要作为首条 user 消息插在可见记录之前。
- 锚点在流里找不到时（例如历史被换过）记一条告警，按没有摘要处理。

`maxChars` 设为 0 或负数等于关掉预算与压缩，全部记录原样交给模型。

## `classic`

YesImBot v3 的 WorldState 投影：每轮把窗口内的事件流渲染成一条 `<world_state>` user 消息。

```yaml
context:
  engine: classic
  classic:
    maxMessages: 50 # 单轮窗口内的消息条数上限
    keepFullTurnCount: 2 # 保留最近几轮的完整思考/行动/观察，更早的只留消息；0 表示不降级
    memoryBlocks: true # 把 <profileDir>/memory/*.md 当核心记忆块注入 system
```

- 频道、成员、以及切成 `processed_events` / `new_events` 两段的工作记忆（模板 `resources/templates/classic/world_state.jinja`）。
- 两段的切点是**最后一条 assistant 条目**：它之后的观察与新消息都算「新到」，于是模型每一步都能在 `new_events` 里先看到上一步的工具结果。没有 assistant 轨迹时全部算新到。
- **优雅降级**：只保留最近 `keepFullTurnCount` 轮的完整思考/行动/观察轨迹，更早轮次的轨迹整段剔除，消息全留。
- **记忆块**：`<profileDir>/memory/*.md`（`.txt` 也收），文件开头用 `---` 围出 frontmatter，`label` 必填且必须是安全标签名（字母开头，只含字母数字下划线减号），`title` / `description` 可选，其余是正文。渲染成 `<label><title><description>正文</label>` 注入 system（模板 `resources/templates/classic/instructions.jinja`），标签重复时保留先读到的那个。
- 模板在包内只读，编译一次；记忆块是用户文件，每轮重读——改了立刻生效，不需要热重载。
- 不调平台接口取频道名与成员资料，只用事件流里带的信息；只读事件流，不写存储、不起后台任务、不跨轮持有状态。

与 v3 的刻意差异：没有 L2 向量检索与 L3 日记（`<retrieved_memories>` / `<diary_entries>` 两节随之去掉）；没有 `<trigger_context>`（v3 那节实际上从不渲染）。

## 连续性

- 工具调用与结果保持配对：裁掉尾部以外的事实时，连同它们前面的工具轨迹一起裁掉。
- 每条事实只在一个场景的流里出现一次。
- 卸载不产生第二份真相：实例从内存消失不改变磁盘上的流。

## 不做的

不引入检查点状态机、帧换代与 `state_delta`。历史修剪只有压缩一条路径；需要跨轮保存的东西写进事实流本身，作为一条普通记录（`ishiki.compact` 就是这么做的）。
