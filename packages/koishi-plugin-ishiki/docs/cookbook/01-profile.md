# 01 · Profile、Scene 与配置

## Profile

一个 profile 是一个心智，也是一个通信域：事实与实例都不跨 profile 流动。

profile 由一个目录自包含地声明：

```text
data/ishiki/profiles/<目录名>/
  profile.yml | profile.yaml
  persona.md          # 可选：人设正文
  scenes/<sid>_<channelId>/events.jsonl
```

目录名是 `id` 的缺省值；文件里写了 `id` 就以文件为准。启动时按目录名排序扫描 `profiles/*/`，每个目录读 `profile.yml` 或 `profile.yaml`。坏掉的目录只跳过它自己：读不动、preset 悬空、缺 `sid`，各记一条 error，其余 profile 照常装载。

## 三段配置

`profile.yml` 只有两部分：`presets`（可复用的运行模式）与 `scenes`（装配清单）。

```yaml
id: neko
description: 示例人设

presets:
  chat:
    description: 日常聊天
    model: openai:gpt-4.1-mini # provider:model，或 models.yaml 里的组名
    failover:
      attempts: 3
      backoffMs: 500
      failoverOn: unavailable
    context:
      engine: standard
      standard:
        maxChars: 32000
        refillRatio: 0.8
    wakeup:
      engine: standard
      standard:
        direct: true
        atSelf: true
        quoteSelf: true
        keywords: [neko]
    toolcall:
      engine: native
    innerThoughts: false
    typing:
      baseDelay: 500
      charPerSecond: 5
      minDelay: 800
      maxDelay: 4000

scenes:
  groups:
    description: 群聊
    sid: onebot:10000
    preset: chat
    whitelist: ["group:*", "123456789"]
    blacklist: ["987654321"]
  dms:
    sid: onebot:10000
    preset: chat
    whitelist: ["private:*"]
```

- **Preset**：`model` 必填；`context` 与 `wakeup` 在类型上必填，运行期缺失时由内置缺省补成 `standard`。引擎参数写在以引擎名命名的同级键下（`context.standard`），换引擎时旧引擎的参数会留在合并结果里，但消费端只读 `config[config.engine]`，读不到旧参数。
- **Scene**：`sid` 与 `preset` 必填，`whitelist` / `blacklist` 是渠道模式；其余字段（`model`、`failover`、`toolcall`、`innerThoughts`、`typing`）是对 preset 的局部覆写。`context` 与 `wakeup` 不在这一层，理由见下。

## 引擎归 preset 层

`context` 与 `wakeup` 只写在 preset 上：两者都带账——压缩水位、各频道的冷却——挂在 scene 上只会造出几份互不相干的账。

- 唤醒引擎一 preset 一份，该 preset 的全部频道共用——跨频道共享冷却账本正是「刚在群里说过话」能被另一个频道看见的原因。
- 上下文引擎一生效单位一份：core 在建 agent 时就把插件 hook 的引用绑好，引擎自己又记着 agent 与在途压缩，跨 agent 共享会让一个频道的压缩去读另一个频道的存储。
- 寻址头（每段事实行前的 `[#坐标]`）是 cross 形态的装配选项，形态本就是 preset 的属性，于是在造上下文引擎时就定下。

因此展开结果有两份：`specs`（各生效单位的装配清单，不含引擎）与 `engines`（按 preset 名索引的引擎配置）。spec 只留一个 `preset` 键指回来。

## 三层合并

运行参数按三层叠加：内置缺省 ← preset ← scene。

- 普通对象逐键递归合并；数组与标量整体替换；`undefined` 与空缺的键都算「未写」，沿用前一层。
- 内置缺省（`FALLBACK`）是配置面唯一的默认值来源：`toolcall.native`、`innerThoughts: false`、`failover` 为 500ms 退避 + `unavailable`、`typing` 为 500/5/800/4000。引擎另有 `ENGINE_FALLBACK`：`context.standard` 与 `wakeup.standard`。
- Schema 里一律不写默认值。补上的值与用户写的值在合并层形状相同，无从分辨，覆写语义会因此失效——preset 里写的引擎永远轮不到。
- `sid` 与 `preset` 只用于定位，不参与合并。

展开后的 spec 叫 **SceneSpec**：一份工厂的运行参数，由 profile 与 scene 名唯一标识。引擎不在里面——见上。

## 渠道认领

- 模式写法：`*` 全部；尾随 `*` 按前缀（`group:*`）；其余按精确值。
- `whitelist` 为空即不认领任何频道；`blacklist` 写法同 whitelist，命中即排除。
- 归属靠顺序，**首条命中即归属**：profile 内部按 `scenes` 的书写顺序；跨 profile 按目录名排序，先装载的那个接管。重复认领不报错。
- 同一个账号可以由多个 spec 分认不同频道（群聊与私聊就是两个 spec）。
- 没有命中任何 spec 的频道对这份心智不存在：不落盘、不挂载。

同一个频道 ID 挂在不同账号下不是同一个场景；不同平台的频道 ID 不比较。

## Scene 是工厂，实例是按需诞生的

配置里的 scene 不是运行实例，而是装配清单。真正运行的是 **AgentRuntime**：一个频道一个，首次有事件落到它头上时创建，创建时初始化目录、引擎与存储，从 `events.jsonl` 恢复上下文。聚合形态下一个 preset 只有一个实例，被它认领的全部频道共用。

本阶段**不做空闲驱逐**：唤醒过的频道实例常驻内存直到进程退出；进程 dispose 时统一停止。上限策略与 LRU 留给以后按需要加。

## 事实与地址

事实保存摄入时的地址（账号与频道）、发送者、消息 ID、时间与必要的引用信息。发送者名称是摄入时的快照，之后改名不回溯历史；没有名称时用稳定 ID。

地址就在事实自己的载荷上，「这条事实属于哪里」是读字段，不是逐类型的规则。

## 校验

配置不合法会在装载时报错，不会带着半截配置跑起来：

- 类型不符（`$.sid expected string but got 1` 这类带路径的报错）、Scene 缺 `sid`、profile 缺 `presets` 或 `scenes`、引用了未声明的 preset、profile 文件读不动；
- 单个 profile 出错只跳过它自己，其余照常装载。

两处**不会**报错的地方，写错了要自己发现：

- 引擎参数块的内部键不校验（`context` / `wakeup` / `toolcall` 按引擎名判别的联合用 `Schema.any()` 收下整块），参数名写错只会安静地不生效；
- 未知的键既不报错也不被剥掉，只是没人读。
