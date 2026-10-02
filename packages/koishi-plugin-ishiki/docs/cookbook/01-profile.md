# 01 · Profile、Scene 与配置

## Profile

一个 profile 是一个心智，也是一个通信域：事实与实例都不跨 profile 流动。
一个 `profile.yaml` 定义一个 profile，**目录名就是它的全局唯一 id**，文件里没有 `id` 字段。
多实例部署的最小差异化单元就是它：扩展包（`extends`）只到这一级。

```text
data/ishiki/profiles/<目录名>/
  profile.yml | profile.yaml
  persona.md          # 可选：人设正文
  memory/*.md         # 可选：核心记忆块，context.v3 的 memoryBlocks 读取
  mcp.json            # 可选：扩展包自用的同层配置
  scenes/<sid>_<channelId>/events.jsonl   # 普通形态：一频道一份事实流
  cross/events.jsonl                      # cross 形态：合流视窗一份事实流
```

启动时按目录名排序扫描 `profiles/*/`，每个目录读 `profile.yml` 或 `profile.yaml`。
坏掉的目录只跳过它自己（读不动、缺 `scenes` 又非 `cross`、scene 缺 `sid` 或 `whitelist`），各记一条 error，其余 profile 照常装载。

`name` 是可选备注名，内核不读它；`description` 只用于显示。

## 两层配置

`profile.yaml` 只有两层：顶层的基线，与 `scenes` 下的装配清单。

```yaml
name: neko
description: 示例人设

model: openai:gpt-4.1-mini # provider:model，或 models.yaml 里的组名
failover:
  attempts: 3
  backoffMs: 500
  failoverOn: unavailable
context:
  engine: standard
  standard:
    maxTokens: 32000
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
codemode:
  enable: false
  direct: []
  timeoutMs: 30000
typing:
  baseDelay: 500
  charPerSecond: 5
  minDelay: 800
  maxDelay: 4000

scenes:
  groups:
    description: 群聊
    sid: onebot:10000
    whitelist: ["group:*", "123456789"]
    blacklist: ["987654321"]
  dms:
    sid: onebot:10000
    whitelist: ["private:*"]
```

- **顶层**：`model` 必填；`context` 与 `wakeup` 在类型上必填，运行期缺失时由内置缺省补成 `standard`。引擎参数写在以引擎名命名的同级键下（`context.standard`），换引擎时旧引擎的参数会留在合并结果里，但消费端只读 `config[config.engine]`，读不到旧参数。
- **Scene**：`sid` 与 `whitelist` 必填，`blacklist` 可选；其余字段（`model`、`failover`、`context`、`wakeup`、`toolcall`、`innerThoughts`、`codemode`、`typing`）是对顶层的局部覆写，未写的键沿用顶层。

## 引擎配置随三层合并

`context` / `wakeup` / `toolcall` 全部走同一条三层合并（内置缺省 ← profile ← scene），没有字段例外。cross 形态只有两层（内置缺省 ← profile）：合流视窗下没有 per-channel 的字段可言。

- 引擎实例随 `AgentRuntime` 诞生与销毁，一个实例一套：上下文引擎记着本实例的 agent 与压缩水位；唤醒引擎的账本只看本视窗的事实流；工具调用层在本实例的模型上就地包裹。跨实例感知不做共享实例，也没有跨实例的状态池。
- 配置在展开期整体落到 `SceneSpec` 上；引擎变体的准入只看服务在不在（`ishiki.engine.<族>.<名字>`），与 `extends` 无关。
- 寻址头（每段事实行前的 `[#坐标]`）与工具的 `target` 参数按可达频道数派生：一个可达频道就没有 target、没有寻址头；聚合视窗必填 target。

## 三层合并

运行参数按三层叠加：内置缺省 ← profile ← scene。

- 普通对象逐键递归合并；数组与标量整体替换；`undefined` 与空缺的键都算「未写」，沿用前一层。
- 内置缺省（`FALLBACK`）是配置面唯一的默认值来源：`context.standard`、`wakeup.standard`、`toolcall.native`、`innerThoughts: false`、`codemode` 为 `enable: false` / `direct: []` / `timeoutMs: 30000`、`failover` 为 500ms 退避 + `unavailable`、`typing` 为 500/5/800/4000。
- Schema 里一律不写默认值。补上的值与用户写的值在合并层形状相同，无从分辨，覆写语义会因此失效——顶层里写的引擎永远轮不到。
- `sid` 与 scene 名只用于定位，不参与合并。

展开后的 spec 叫 **SceneSpec**：一份工厂的运行参数，由 profile 目录名与 scene 名唯一标识，引擎配置在内。cross 形态的 scene 名固定是 `cross`，与它的数据目录同名。

## 渠道认领

- 模式写法：`*` 全部；尾随 `*` 按前缀（`group:*`）；其余按精确值。
- `whitelist` 为空即不认领任何频道；`blacklist` 写法同 whitelist，命中即排除。
- **一个频道只能属于一个 profile**。同一账号下两份清单相交即冲突，判定只在共同覆盖的账号上做（不同账号的频道 id 空间互不相交）。
- 冲突不静默：按目录名排序装载，与已装载的清单冲突的那一份**整体跳过**并记一条 error。同一个 profile 内两个 scene 撞上同一频道同样按冲突处理。
- 同一个账号可以由多个 scene 分认不同频道（群聊与私聊就是两个 scene）。
- 没有命中任何 scene 的频道对这份心智不存在：不落盘、不挂载。

同一个频道 ID 挂在不同账号下不是同一个场景；不同平台的频道 ID 不比较。

## Scene 是工厂，实例是按需诞生的

配置里的 scene 不是运行实例，而是装配清单。真正运行的是 **AgentRuntime**：一个频道一个，首次有事件落到它头上时创建，创建时初始化目录、引擎与存储，从 `events.jsonl` 恢复上下文。

- 普通形态：实例目录是 `profiles/<目录名>/scenes/<sid>_<channelId>/`，目录名由 `sid` 与 `channelId` 拼接、文件系统禁用字符替换为 `_`。
- cross 形态：一个 profile 只有一个实例，被它认领的全部频道共用，目录固定是 `profiles/<目录名>/cross/`。

实例对外暴露两个坐标：`home` 是它自己的数据目录（`events.jsonl` 在里面），`root` 是 profile 目录（`profile.yaml`、`persona.md`、`mcp.json` 在这一层）。

本阶段**不做空闲驱逐**：唤醒过的频道实例常驻内存直到进程退出；进程 dispose 时统一停止。上限策略与 LRU 留给以后按需要加。

## 事实与地址

事实保存摄入时的地址（账号与频道）、发送者、消息 ID、时间与必要的引用信息。发送者名称是摄入时的快照，之后改名不回溯历史；没有名称时用稳定 ID。

地址就在事实自己的载荷上，「这条事实属于哪里」是读字段，不是逐类型的规则。

## 校验

配置不合法会在装载时报错，不会带着半截配置跑起来：

- 类型不符（`$.sid expected string but got 1` 这类带路径的报错）、Scene 缺 `sid` 或 `whitelist`、profile 缺 `scenes` 又没写 `cross: true`、`cross: true` 却带了 `scenes`、cross 没有 `claims`、文件读不动；
- 单个 profile 出错只跳过它自己，其余照常装载；频道认领冲突时后者整体跳过。

两处**不会**报错的地方，写错了要自己发现：

- 引擎参数块的内部键不校验（`context` / `wakeup` / `toolcall` 按引擎名判别的联合用 `Schema.any()` 收下整块），参数名写错只会安静地不生效；
- 未知的键既不报错也不被剥掉，只是没人读。
