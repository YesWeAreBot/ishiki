# 05 · 引擎与装配

## 为什么要引擎

agent 循环里有些环节**只能有一个**：上下文怎么组装、这一条消息唤不唤醒我、模型的输出怎么读成工具调用。上一代把这些交给插件抢：插件用 `priority` 与 `match(session)` 全局匹配，彼此不兼容、无法组合，一个群装三个插件就打架。

ishiki 的做法是把这些环节收进**引擎**：一个引擎 = 一个环节的一种实现 + 它的参数；同族互斥，preset 只能选一个。插件退回到加法——加工具、加提示词、加收尾动作，不抢决策。

## 注册表形态

每个族一个目录，三件东西：

```text
src/<族>/
  engine.ts            # 抽象基类 + 参数表 interface + 注册表
  <名字>.engine.ts     # 一个变体一个文件，文件末尾自注册
  index.ts             # 桶文件，import 各变体使注册生效
```

`engine.ts` 里固定三件事：

- `interface XEngines {}`：参数表，键即 `x.<engine>` 的参数键，各变体文件用 `declare module` 增强它；
- `registerXEngine(name, create)`：登记一个变体，**重名抛错**，配置错误在装载时立刻暴露；
- `createXEngine(config)`：按 `config.engine` 取参数（`config[config.engine]`），**未登记的名字抛错，不静默退化**。

参数声明为可选（`Partial`）而不是改用索引签名，是为了让 `config[config.engine]` 仍能推导出具体类型。换引擎后旧引擎的参数键会留在合并结果里，消费端只读自己那个键，读不到旧参数。

## 现有的族

| 族       | 变体                                                                         | 参数键            |
| -------- | ---------------------------------------------------------------------------- | ----------------- |
| 上下文   | `standard`（缺省）、`classic`                                                | `context.<name>`  |
| 唤醒     | `standard`（缺省）、`classic`、`jev`                                         | `wakeup.<name>`   |
| 工具调用 | `native`（缺省）、`classic`、`hermes`、`qwen3coder`、`morph-xml`、`yaml-xml` | `toolcall.<name>` |
| 记忆     | `standard`（空壳，未接线）                                                   | —                 |

前两族实现 `AgentPlugin`：它们的钩子挂在 agent 实例上，随场景装配。第三族不进 `AgentPlugin` 体系——它作用于装配期的模型值，由调用点在装配时取用一次。记忆族只有抽象基类与一个返回空工具集的占位实现，插槽关系已定（它是被查询的数据源，不是管道上的兄弟），实现留给以后。

## 前两族归 preset 层

`context` 与 `wakeup` 只写在 preset 上：挂在 scene 上只会造出几份互不相干的账。

- **配置**按 preset 存，按 preset 造实例。寻址头在造上下文引擎时就定下——形态本就是 preset 的属性。
- **唤醒引擎**一 preset 一份，全部频道共用：它带的是各频道的冷却账本，共用才看得见「刚在群里说过话」。
- **上下文引擎**一生效单位一份。它不能跨 agent 共享——core 在 `createAgent` 时就把插件 hook 的引用绑好，引擎自己也记着 agent、压缩水位与在途压缩，共享会让这个频道的压缩去读另一个频道的存储。幸而这一层本就是「一生效单位」：cross 形态整个 preset 只有一块视窗、一个 agent。

`toolcall` 留在 scene 层：它不带账，只是按需包裹模型的一层中间件，构造一次扔掉即可。

### 工具调用引擎

一个引擎 = 一个输出协议 + 它的参数。协议的三件事由引擎持有：怎么写（输出契约的提示词模板 + 工具目录）、怎么读回（解析生成文本 / 流式解析）、历史怎么回写（工具调用与结果的文本形状）。这些由 `@ai-sdk-tool/parser` 组装成中间件接到模型上，契约与工具目录由中间件在每步请求改写时注入 system，引擎不向调用方交出文本——避免两处注入同一份说明。

`native` 不接管模型（用模型原生的 function call）；其余变体用于不支持原生 function call 的模型，或需要固定输出形状的场景。模型不是 v4 规格（网关没解析出 v4 provider）时中间件不适用，模型原样返回。

`classic` 是 YesImBot v3 的 JSON OUTPUT：`thoughts`（observe / analyze_infer / plan）+ `actions` 两块，空 `actions` 即结束本轮。它与 `context.classic` 共用同一份 `<action>` / `<observation>` 渲染（`src/toolcall/classic.engine.ts` 导出），协议钩子与上下文投影不会各写一份而漂移。

## 降级与重试

`model` 写 `provider:model` 时是单个候选，写 `models.yaml` 里定义的组名时按组成员逐个试。重试落在**模型调用层**而不是轮次或步一级：core 要等整条流结束才落盘，而流里的工具可能已经真发过消息，整步重跑会重发。

```yaml
failover:
  attempts: 3 # 缺省跑完一轮候选
  backoffMs: 500 # 逐次翻倍，封顶 8s，取半抖动
  failoverOn: unavailable # 或 any
```

- 只重试**首块语义内容之前**的失败。一旦模型已经开始生成，失败原样抛出——不能把上一个候选的半句接给下一个候选补完。
- 失败按状态码归类：客户端主动取消立刻抛出；端点不可用换人并计一次失败；请求本身的问题默认原样抛出，`failoverOn: any` 时也换人（用在不认某个参数的 relay 上）。
- 机制是**选择加入**的：`model` 不是组名、也没配 `attempts` 时，一次失败就是一次失败。

## 打字节奏

`typing` 按可见文本估算每条消息发出前的等待：CJK 与拉丁字符各按一档速度计（拉丁按 1.5 倍速），乘一个随机系数，夹在上下限之间，再加基础延迟。`charPerSecond` 为 0 时只留 `minDelay`。元素语法不占打字时间。

## 幕后念头

`innerThoughts: true` 时，每个工具的参数表前置一个 `inner_thoughts` 字段（第一个参数），念头在执行前被摘下记进日志；`think` 工具因此退场。与协议引擎同时开启时念头会被要求两次（契约里的 `thoughts` + 每工具的 `inner_thoughts`）。

## 新增一个引擎

1. 在对应目录建 `<名字>.engine.ts`：继承抽象基类，写清这个策略的取舍与与来源实现的差异（被否决的替代方案也写进去）。
2. 文件末尾 `declare module` 增强参数表，再调 `registerXEngine`。
3. 在 `index.ts` 里 import 该文件。
4. 示例与文档同步：`resources/profile.example.yml` 与 cookbook 对应章节。
5. 配置层不用改：`context` / `wakeup` / `toolcall` 的 Schema 是按引擎名判别的联合，新变体走同一形状。
