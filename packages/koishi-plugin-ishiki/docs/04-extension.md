# ishiki 扩展机制结论

## 一句话判断

ishiki 当前的扩展机制设计是成立的，而且和 Koishi 的核心模型结合得比较好：

> **Koishi/Cordis 负责插件、服务、依赖与生命周期；ishiki 负责 profile、AgentRuntime 和 Agent 内部的扩展装配。**

它刻意把扩展分成两类：

1. **引擎扩展**：替换一个互斥的运行策略，例如上下文、唤醒、工具调用协议。
2. **贡献物扩展**：向现有 Agent 增加工具和提示词，不参与核心决策。

这套划分避免了插件通过优先级抢占全局钩子，也避免了社区扩展直接修改 Agent 循环。

---

## 一、当前机制的结构

```text
Koishi 插件
  │
  ├─ static inject = ["ishiki"]
  │
  ├─ ctx.ishiki.agent.use("workspace", factory)
  │       │
  │       └─ ishiki.ext.workspace Service
  │
  └─ 引擎插件
          │
          └─ new ContextEngine / WakeupEngine / ToolcallEngine
                  │
                  └─ ishiki.engine.<族>.<名字> Service


profile.yaml
  │
  ├─ extends
  │     └─ 选择贡献物包，并传入 profile 配置
  │
  ├─ context.engine
  ├─ wakeup.engine
  └─ toolcall.engine
        │
        └─ 转化为 ProfileLoad.services


ctx.inject(ProfileLoad.services, profile fiber)
  │
  ├─ 服务缺失：profile 等待
  ├─ 服务出现：profile 激活
  └─ 服务消失：profile 停止并重建


AgentRuntime 按频道或 cross 视窗惰性创建
  │
  ├─ 创建三个引擎运行体
  ├─ 调用各扩展工厂
  ├─ 取得 RuntimePlugin
  └─ 创建 Agent
```

这里最重要的设计是三层生命周期：

| 层级   | 单位         | 内容                                    |
| ------ | ------------ | --------------------------------------- |
| 服务层 | 进程         | Koishi Service、扩展工厂、引擎 provider |
| 选中层 | profile      | `extends`、引擎选择、配置依赖           |
| 实例层 | AgentRuntime | 工具、提示词、上下文、唤醒状态          |

这个分层是清楚的，没有把 profile 配置、Agent 实例和 Koishi 插件混成一个对象。

---

# 二、与 Koishi 特性的结合评价

## 1. 用 Service 作为扩展登记处，方向正确

ishiki 没有另造一个全局 Registry，而是使用 Koishi/Cordis 的 Service：

```ts
ctx.ishiki.agent.use("workspace", factory);
```

最终形成：

```text
ishiki.ext.workspace
```

这是当前设计中最正确的一点。

Cordis v3 的 Service 本身就具备：

- 服务命名
- 服务可用性判断
- `ctx.get()` 访问
- `inject` 依赖声明
- 服务消失时触发依赖方卸载
- 服务恢复时重新加载
- 服务绑定 Context 生命周期

因此 ishiki 的扩展服务天然拥有 Koishi 的生命周期语义，不需要再实现一套：

- `registerExtension()`
- `unregisterExtension()`
- `watchExtension()`
- `reloadExtension()`

这些机制。

从模块设计角度看，`ctx.ishiki.agent.use()` 是一个比较深的扩展接口。调用者只需要知道如何登记工厂，服务创建、依赖等待、激活和失效都由内部完成。

---

## 2. profile 使用 `ctx.inject()`，利用了 Cordis 的失效传播

当前 profile 激活逻辑会把这些服务作为依赖：

```text
ishiki.ext.workspace
ishiki.engine.context.standard
ishiki.engine.wakeup.standard
ishiki.engine.toolcall.native
```

服务不在时：

```text
profile fiber = waiting
```

服务出现时：

```text
profile fiber = reload
```

服务消失时：

```text
profile fiber = unload
AgentRuntime = stop
路由表 = 移除
```

这正好对应 Cordis v3 的依赖机制：

- required service 不存在，插件不激活
- required service 变化，插件先回收副作用
- 服务恢复后重新执行插件逻辑

因此 ishiki 没有自己实现热替换，也没有自己维护依赖 diff。这一点应该保留。

### 这个粒度的优点

profile 是一个合理的重启单位：

- 一个 profile 内的扩展配置通常属于同一个心智
- profile 下的多个 AgentRuntime 可以整体换代
- 事实流仍然保存在磁盘中
- 未使用该扩展的 profile 不受影响

### 这个粒度的代价

任何一个 profile 依赖的扩展服务或引擎服务消失，整个 profile 都会停止：

```text
一个引擎失效
  → 整个 profile 停止
  → 所有频道 AgentRuntime 停止
```

它不会做到单频道隔离，也不会热替换单个引擎实例。

这个代价是可以接受的，因为引擎 provider 通常属于 profile 的整体运行策略。若未来需要更细粒度的失效隔离，需要重新定义生命周期单位，不能只在现有机制上加几个判断。

---

## 3. `extends` 是 ishiki 的配置准入，不是 Koishi 插件嵌套

这里要分清两个概念。

### Koishi 层

Koishi 配置决定扩展包是否安装：

```yaml
plugins:
  workspace:
```

这决定：

```text
ishiki-workspace 这个 Koishi 插件是否存在
```

### ishiki 层

profile 决定这个心智是否使用扩展：

```yaml
extends:
  workspace:
    config:
      mounts:
        - ./docs:/docs:ro
```

这决定：

```text
这个 profile 是否依赖 ishiki.ext.workspace
```

所以同一个扩展包可以：

- 被 Koishi 进程加载一次
- 服务多个 profile
- 每个 profile 有不同配置
- 每个 AgentRuntime 再决定如何产生实例级资源

这是比“每个 profile 启动一个插件副本”更适合当前架构的方式。

MCP 客户端扩展已经验证了这种模式：

```text
Koishi 插件一份
  → 工厂按 profile 调用
  → ProfilePool 按 profile 共享
  → AgentRuntime 只持有引用计数
```

---

# 三、贡献物机制评价

## 1. 只开放工具和提示词，是正确的保守边界

`RuntimePlugin` 目前只有：

```ts
type RuntimePlugin = Pick<AgentPlugin, "name" | "extendTools" | "extendInstructions" | "stop">;
```

返回对象上出现名单之外的键（含改名前的 `dispose`）装配期当即抛错——名单是一张 `Record` 白名单，不是文档约定。这意味着社区包可以：

- 增加工具
- 增加系统提示词
- 持有自己的资源
- 在 AgentRuntime 停止时释放资源（`stop`）

但不能直接参与：

- 唤醒判定
- `onStepFinish`
- `prepareStep`
- `beforeToolCall`
- `toModelMessages`
- 事实接收
- 事件归一化
- 事件渲染
- 停轮决策

这个边界很好。

Agent 循环中有一些环节没有天然的组合语义。例如多个扩展同时修改 `beforeToolCall`，到底按顺序叠加、首个生效，还是后者覆盖前者？一旦把这些钩子开放给社区，就会重新出现旧版的优先级竞争。

ishiki 当前采用：

```text
核心决策封闭
贡献能力开放
互斥策略做成引擎族
```

这是比“所有东西都做成插件钩子”更稳定的设计。

---

## 2. 工具合并规则明确

当前顺序是：

```text
内核工具
  → extends 中的扩展工具
  → innerThoughts
  → codemode 收窄
```

扩展包之间按照 `extends` 的书写顺序合并。

工具撞名直接抛出：

```ts
throw new ToolConflictError(name);
```

这比静默覆盖安全得多。尤其是 `send_message` 和 `finish` 属于内核机制，不应被第三方工具替换。

需要注意一点：

> 工具撞名发生在 Agent 轮次的工具面装配阶段，而不是 AgentRuntime 创建阶段。

因此实例可能已经创建成功，直到第一次轮次才失败。这是当前设计的一个延迟错误点。

---

## 3. 每轮现取工具和提示词，适合动态扩展

core 的 `assemblePrompt()` 会在每轮第一步重新获取：

- 扩展提示词
- 扩展工具

这样 MCP 的工具列表变化、工作区技能变化等可以在下一轮生效，不需要重建 Agent。

优点：

- 不需要内核缓存扩展结果
- 扩展包可以自己决定缓存粒度
- 支持运行时变化
- 不需要引入二次注册机制

代价：

- 第一次轮次可能承担异步初始化成本
- 扩展钩子报错会表现为轮次失败
- 工具与提示词只能在轮次边界更新，同一轮的多步调用中不会重新装配

这和当前 Agent core 的执行模型是匹配的。

---

# 四、引擎扩展机制评价

三类引擎的设计比较完整：

| 引擎族         | 作用                             | 扩展形式                            |
| -------------- | -------------------------------- | ----------------------------------- |
| ContextEngine  | 条目裁剪、消息渲染、上下文提示词 | Service provider + Runtime instance |
| WakeupEngine   | 判断事件是否唤醒 Agent           | Service provider + Runtime instance |
| ToolcallEngine | 包装模型、处理工具调用协议       | Service provider + Runtime instance |

它们都遵循：

```text
Service provider
  → 每个 AgentRuntime 创建一个运行体
```

这解决了两个常见问题：

1. provider 不持有频道级状态
2. 不同 AgentRuntime 不共享压缩水位、唤醒账本或模型包装状态

插件级配置和 profile 运行配置也被明确分开：

```text
provider 配置：扩展包自身的资源与端点
profile 配置：该心智如何使用这个引擎
runtime 状态：该实例的上下文、账本与缓存
```

这套分层是合理的。

## 引擎扩展的限制

社区只能扩展已有三族：

```text
context
wakeup
toolcall
```

不能新开一个 Agent 循环插入点。

这意味着如果社区需要：

- 新的事实接收协议
- 新的事件渲染体系
- 新的停轮规则
- 新的工具审批流程
- 新的上下文整体组装模型

就必须回到 ishiki core 增加新的机制。

这不是缺陷，而是刻意选择的封闭边界。当前核心规则尚未稳定时，开放更多插入点会让扩展之间无法验证组合正确性。

---

# 五、和 Koishi Context 过滤器的关系

Koishi 原生 Context 过滤器适合：

```ts
ctx.platform("onebot").channel("123").on("message-created", handler);
```

它表达的是：

> 哪些平台事件会触发这个插件副作用。

ishiki 的 `profile`、`scene` 和 `cross` 表达的是：

> 哪些频道属于一个心智，以及哪些频道共享一个 Agent 视窗。

两者不是同一个问题，因此 ishiki 没有直接用：

```ts
ctx.channel(...)
ctx.platform(...)
```

来实现 AgentRuntime 的扩展挂载，这是正确的。

特别是 cross 形态下，一个实例覆盖的是：

```ts
{
  form: "cross",
  accounts: [...]
}
```

它没有单一的当前频道。把它强行映射成 Koishi 的一个频道过滤器，反而会丢失聚合视窗的语义。

坐标里的 `domain` 是这里的关键接口：

```ts
type InstanceDomain =
  | {
      form: "channel";
      platform: string;
      selfId: string;
      channelId: string;
    }
  | {
      form: "cross";
      accounts: readonly ClaimedAccount[];
    };
```

扩展包只需要根据 `domain.form` 处理两种形态，不必自己猜测当前 Agent 属于哪个频道。

---

# 六、当前机制的主要风险

## 1. 坐标里不再有 `ctx`（已收口）

这个边界已经在运行体插件面改造中收口：`RuntimeScope` 只给 `config` / `domain` / `home` / `root`，`ctx` 不在其中。

- 工厂拿不到调用方那条 fiber 的 Context，从坐标里也推不出来——包要用的 Koishi 服务在**构造期**取好闭包进来（`workspace` 取 `ctx.ishiki.dataPath`、`mcp-client` 取 `ctx.logger` 都是范例）。
- 实例级资源的打开与回收走 `stop`：实例停止时逆序执行，与 AgentRuntime 的生命周期对齐。
- 之所以不给：钩子的调用时刻可能晚于注册插件的 dispose（服务消失 → 依赖它的 profile fiber 复位 → 实例停止），把宿主 ctx 交进坐标只会诱使包在钩子里现取，拿到一条正在死去的 fiber 上的东西。

结论：

> 坐标只描述「这个实例是谁、在哪」；Koishi 能力从包自己那条 fiber 上取。资源的两端——开启在闭包，释放在 `stop`。

---

## 2. `extends.config` 没有核心级 Schema

当前配置是：

```ts
config: Schema.any();
```

这保持了内核和社区包的解耦，但也带来明显代价：

- profile 配置无法在 Koishi 控制台得到结构化表单
- 类型错误不能在 profile 装载期发现
- 错误可能推迟到某个 AgentRuntime 第一次创建
- 不同包的配置格式没有统一元数据
- 文档和配置工具无法自动发现字段

目前这个取舍适合早期生态阶段。长期看，可以考虑让扩展包自行暴露 profile 配置 Schema，但 Schema 的拥有者仍应是扩展包，不应搬进 ishiki core。

---

## 3. 未知引擎名与拼写错误会进入等待态

例如：

```yaml
context:
  engine: standart
```

最终会依赖：

```text
ishiki.engine.context.standart
```

如果服务不存在，profile 会等待。

这在 Cordis 语义上是正确的，因为服务可能稍后加载；但对用户来说：

```text
拼写错误
```

和：

```text
社区引擎插件尚未安装
```

表现相同。

当前日志能提示缺少服务，但不会进一步区分原因。

---

## 4. 扩展包之间没有正式的依赖表达

`extends` 只表达：

```text
这个 profile 使用哪些包
```

它没有表达：

```text
A 包依赖 B 包
A 包必须排在 B 包之后
A 包提供某个可供 B 包调用的接口
```

工具合并顺序依赖 `extends` 的书写顺序，但这只是装配顺序，不是正式的包依赖图。

如果未来出现相互协作的复杂扩展，应该优先考虑使用 Koishi Service 表达能力依赖，而不是让扩展包彼此读取内部对象。

---

## 5. 文档存在旧接口残留

`docs/03-community-extension-mechanism.md` 的引擎示例仍使用：

```ts
create(...)
```

而当前代码已经采用 Cordis 可调用 Service 的：

```ts
[Service.invoke](...)
```

实现路径。

`docs/cookbook/05-engines.md` 与源码是一致的，03 号文档的示例需要以后统一。它会误导社区作者按照不存在的接口开发引擎。

---

# 七、最终评价

## 适合做的事情

当前机制适合：

- MCP 工具接入
- 文件系统或工作区工具
- 搜索、数据库、外部 API 工具
- profile 级资源池
- AgentRuntime 级沙箱
- 新的上下文裁剪策略
- 新的唤醒策略
- 新的工具调用协议
- 动态提示词和技能目录

## 不适合做的事情

当前机制不适合直接承载：

- 新的事实事件类型
- 新的受体归一化逻辑
- 新的渲染规则
- 改写停轮判定
- 工具审批和权限拦截
- 任意修改 Agent 循环
- 依赖隐式当前频道的 Koishi 副作用

这些能力应进入 ishiki core，或者先设计新的明确引擎族。

## 结论等级

| 维度                          | 评价                                      |
| ----------------------------- | ----------------------------------------- |
| Koishi Service 集成           | 很好                                      |
| Cordis 依赖与重载             | 很好                                      |
| profile 级隔离                | 很好                                      |
| AgentRuntime 级扩展           | 清楚，资源两端都在契约里（闭包 + `stop`） |
| 工具与提示词贡献              | 边界合理，越界键装配期抛错                |
| 引擎扩展                      | 结构完整                                  |
| 配置可发现性                  | 偏弱                                      |
| 扩展包协作能力                | 偏弱                                      |
| 错误提前发现                  | 偏弱                                      |
| 对未来复杂 Agent 机制的开放性 | 有意受限                                  |

**最终判断：ishiki 的扩展机制已经形成了稳定的第一版内核边界。它的强项是生命周期、隔离和组合安全，弱项是配置元数据与扩展间协作。`runtime.ctx` 的归属问题已由运行体插件面改造收口（坐标不含 `ctx`，资源两端在闭包与 `stop`）。现阶段不建议继续扩大社区钩子面，接下来优先做 profile 扩展配置 Schema 与引擎文档接口的统一。**

本次未修改 ishiki 源码。扩展相关测试通过：18 个测试全部通过。

参考基线：

- `D:\Codespace\references\koishi`：Koishi 4.18.11
- `D:\Codespace\references\cordis-v3`：Cordis 3.18.1 对应源码
- `D:\Codespace\references\cordis`：Cordis v4，用于确认不能混用 v4 生命周期 API
- `D:\Codespace\references\koishijs-docs\zh-CN\guide\plugin\service.md`
- `D:\Codespace\references\koishijs-docs\zh-CN\guide\plugin\lifecycle.md`
