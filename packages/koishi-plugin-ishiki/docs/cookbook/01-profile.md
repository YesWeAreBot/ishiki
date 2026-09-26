# 01 · Profile、场景与配置

## Profile

一个 profile 是一个独立的心智。它拥有自己的人格、模型、场景白名单和事实流；不同 profile 之间不共享历史。

一个 profile 由一个目录自包含地声明：

```text
data/ishiki/profiles/<catalog>/
  profile.yaml      心智定义
  think.md          思考模板，可选
  scenes/<key>/     每个场景一个目录
    session.jsonl   该场景唯一的事实流
```

目录名（catalog）只用来定位数据；心智的标识是文件里的 `id`。启动时按目录名排序扫描 `profiles/*/profile.yaml`。

## 声明式配置

`profile.yaml` 是纯声明式的，分五部分：

1. **身份基底**：`id`、`name`、`model`、`systemPrompt`。
2. **身体**：`sid` 列表，形如 `platform:selfId`。
3. **全局默认**：`defaults`，所有场景的基线。
4. **场景预设**：`presets`，可复用的能力包。
5. **场景绑定**：`channels`，每条规则声明接管什么场景、用哪个 preset。

`defaults` → `preset` → 规则自身逐层叠加：标量后者覆盖前者，`promptExtension` 依次拼接，`disabledTools` 一旦在规则里出现就整体替换。

## 场景

场景由两部分组成：

- **身体**：`platform:selfId`，心智通过哪个账号出现。
- **频道**：该身体命名空间内的频道 ID。

完整地址是 `身体 + 频道`（内部写作 `sid:channelId`）。同一个频道 ID 挂在不同身体下不是同一个场景；不同平台的频道 ID 也不比较。

规则的 `match` 支持四个维度：`platform`、`sid`、`type`（`group` / `direct` / `guild` / `all`）与 `channelId`（精确、`*` 前缀通配、`!` 排除）。场景类型由平台报告：私聊优先，其次带 guildId 的，其余是 group。

## 一条事实只属于一个场景

多条规则都能匹配时，写在前面的那条生效。

没有命中任何规则的场景既不落盘也不挂载——它对这份心智不存在。

不同 profile 可以用各自的账号进同一个群（同一个频道里可以有两个心智），但同一具身体只能有一个 profile 认领。

## 分发边界

事件进入 profile 后依次经过受体归一化与规则匹配：

```text
平台会话
  → 受体把它归一化成一条中性事实
  → 规则判断这条事实属于哪个场景（不属于就丢弃）
  → 判断这条事实是否唤醒心智
```

发送者如果是该 profile 的任一身体，事件直接跳过，避免心智自己的平台消息再次作为外部消息进入事实流。

平台差异在受体里归一化。之后的场景判断、唤醒判断与渲染都不再有平台分支。

事实保存摄入时的发送者名称快照；频道只记 ID。之后改名不回溯历史；没有名称时使用稳定 ID。

## 校验

配置不合法会在启动时报错，不会带着半截配置跑起来：

- 必填项（`id`、`model`、`systemPrompt`、`sid`、`channels`）缺失，或 `sid` 形如 `platform:selfId` 之外的写法；
- 规则没有写 `preset`，或引用了未声明的 preset / 未声明的 sid；
- `id` 重复，或同一具身体被两个 profile 认领；
- 未知的键。

## 生命周期

场景按需挂载：某条消息真正唤醒某个场景时，才为它创建 agent、载入历史并跑一轮推理。
没有唤醒任何人的消息只写进它所属场景的事实流，不创建 agent、不调用模型。

场景空闲超过 `evictMs`（默认 2 分钟）后从内存中卸载；事实流留在磁盘上，下一次唤醒时从同一份 `session.jsonl` 恢复。
