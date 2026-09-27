# 02 · 唤醒与场景边界

## 一个场景一个心智

每个场景有自己的 agent、自己的事实流、自己的模型前缀。在这个场景里醒来时，看到的只有这个场景最近的记录。

这条设计的代价是「你在这边不知道那边发生了什么」，换来的是三件事：前缀天然冻结、并发请求分散在各自执行流里、事实流里没有伪装成当前场景的场外消息。

需要共享语境的场合不走工具调用那条路：`cross` 形态的 preset 把要合流的频道收进同一块视窗与同一份事实流，别处说过的话本来就在上下文里（见 [01-profile](./01-profile.md)）。

## 唤醒是每个场景自己的判断

一条事实到达时，独立问一个问题：它唤醒这个场景吗？

判断只读，不写任何东西。结论是 `wait` 时事实照样落进它所属场景的流里，只是不挂载实例、不调用模型——历史因此始终完整。

唤醒由**唤醒引擎**给出，同族互斥，preset 选一个。现有的三种：

只有普通消息能唤醒：缺省的 `standard` 对撤回事件一律返回 `wait`。被 `wait` 掉的事实仍然进流，下一次真的被唤醒时能看到。

### `standard`（缺省）

命中任意一条即唤醒：

```yaml
wakeup:
  engine: standard
  standard:
    direct: true # 私聊
    atSelf: true # 被 @
    quoteSelf: true # 被引用回复
    keywords: [neko] # 消息里出现这些词
```

### `classic`

YesImBot v3 的响应意愿：每个频道攒一个意愿值，有消息就按

```text
增益 = (基础分 + @/引用/私聊加成) × 兴趣系数 × 边际递减
```

加分，闲下来按半衰期衰减，越过阈值后以线性概率掷骰决定要不要说话，说过一轮扣掉 `replyCost`。参数即 `base` / `atMention` / `isQuote` / `isDirectMessage` / `keywords` / `keywordMultiplier` / `defaultMultiplier` / `maxWillingness` / `decayHalfLifeSeconds` / `probabilityThreshold` / `probabilityAmplifier` / `replyCost`。

两处与 v3 的刻意差异：衰减是**惰性**的（在判定与收尾时把距上次写入的时间一次折算完，不常驻 1 秒定时器）；v3 里从未被写入的时间戳 Map 与无调用方的分支不搬。

### `jev`

规则兜底 + 模型判定：私聊与 @ 等硬规则先短路（零请求），其余消息问一次模型要不要插话；判定失败或超时一律降级为 `wait`。

```yaml
wakeup:
  engine: jev
  jev:
    instruction: | # 补充判据，写在这里的约束加在内置判据之上
      neko，猫娘，话不多但会接梗。
    threshold: 0.5 # 概率阈值，调高更沉默
    cooldownMs: 30000 # 上次开口后的静默期；硬命中的规则不受它约束
    historyMessages: 8 # 喂给模型的最近消息条数
    timeoutMs: 1500 # 单次判定等待上限，超时按不唤醒处理
    rules:
      direct: true
      atSelf: true
      quoteSelf: false
      keywords: []
```

内置判据按场景分档（私聊默认该回、群聊默认别插话）并写在代码里，承载判定下限；`instruction` 只在其上追加。引擎自取该场景的近期记录判断「自己刚说过什么」，不需要外部回调。

## 声带

`send_message` 是消息到达平台的唯一途径。普通形态没有目标参数，只发到当前场景；`cross` 形态下 `target` 必填，坐标取自上下文的寻址头，落在本视窗可达清单之外时返回 `{ok: false, error: {name: "InvalidTarget"}}` 且不发出任何消息——换一个坐标重试。

不想开口就用 `finish` 结束本轮。**不要**在公开频道里汇报「我没有什么可说的」这类过程——那既不是对话内容，也会惊动真实用户并触发新的唤醒。

## 唤醒引擎的契约

引擎对单条事实给出 `trigger | wait`，可以异步（`jev` 要问模型）。引擎在场景挂载时取到 agent 与频道号，自行订阅与退订，自行读存储播种判定窗口。判定失败一律降级为 `wait` 并记日志——唤醒层的错误不该让整条事实流停下。
