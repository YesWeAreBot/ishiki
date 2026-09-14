# 02 · 主心智

> v1 已确认。前置：[01-profile.md](./01-profile.md)。帧重建见 [03-context.md](./03-context.md)。

一个 profile 一个意识流。它不属于任何频道，同一时刻只 **focus** 一个场景，对其余白名单频道保持 **awareness**。

## 存储与渲染

storage 摄入该 profile 白名单内的全部消息。条目格式一致，不打 awareness 标记。

模型必须能看出消息来自哪个频道。非 focus 的高优先级和当前 focus 的普通消息，差别只出现在渲染。

一条可见事实对应一条模型消息，不做 run-length 分块。

## Awareness

非 focus 的高优先级进入上下文，只渲染触发那一条，不附带该频道的额外上下文。

高优先级：私聊、群聊 @、提及、引用、关键词。

awareness **可以起 turn**。已有 turn 在跑则 join，当作工作区追加，形态仍是 awareness。

## 前缀与切 focus

`[instructions]` 和已渲染的 messages 前缀，只允许在帧重建时改。

本轮调用了 `change_focus` 到 B：

- 已经画出的形态保持不变。
- 之后新到的 B 消息按 focus 形态追加；A 的新消息按 awareness。
- 不把 B 的近期历史灌进本轮工作区。
- 需要选址的工具，缺省 target 变为 B。
- `change_focus` 可以带参数，把一部分 B 上下文放进**工具结果**（参数形状未定）。

真正换帧在本轮结束之后，见 [03-context.md](./03-context.md)。

## 工具选址

投机缺省：不填则发往当前 focus。profile 只有一具 bot 时不需要 `<sid>`。提示词按实际模式写。
