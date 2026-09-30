# 05 · 引擎与装配

## 为什么要引擎

agent 循环里有些环节**只能有一个**：上下文怎么组装、这一条消息唤不唤醒我、模型的输出怎么读成工具调用。上一代把这些交给插件抢：插件用 `priority` 与 `match(session)` 全局匹配，彼此不兼容、无法组合，一个群装三个插件就打架。

ishiki 的做法是把这些环节收进**引擎**：一个引擎 = 一个环节的一种实现 + 它的参数；同族互斥，preset 只能选一个。插件退回到加法——加工具、加提示词，不抢决策。

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

## 引擎随 AgentRuntime 诞生

三个族的配置走同一条三层合并（内置缺省 ← preset ← scene，见 [01-profile](./01-profile.md)），实例全部随 `AgentRuntime` 在装配点诞生、随实例销毁——生命周期只有「实例」一种单位：

- **上下文引擎**一实例一份。它不能跨 agent 共享——core 在 `createAgent` 时就把插件 hook 的引用绑好，引擎自己也记着 agent、压缩水位与在途压缩，共享会让这个频道的压缩去读另一个频道的存储。
- **唤醒引擎**一实例一份。它曾经的账本「跨频道可见」依赖 preset 级共享实例；现状里冷却账本只看本视窗的事实流。真需要跨实例感知（如全局限频），变体从 `WakeupEngineDeps.shared`（profile 级状态池，随 ProfileRuntime 生灭）取自己的键自管读写，不用模块级闭包——插件重载时闭包会留下幽灵账。
- **工具调用引擎**在装配点就地包裹本实例的模型：它不带账，只是按需包裹模型的一层中间件。

`attach` 契约保留但收窄为单次挂载：一个引擎实例只 attach 一个 agent，返回的 disposer 由实例停止时调用。引擎要「这个场景发生了什么」，从这里订阅事实流即可。

变体准入（带包前缀的名字要求包在 preset 的 `extends` 里）在配置展开期校验；scene 就地覆写引擎变体同样受这道门约束——准入是 preset 的承诺，不随覆写放开。

### 工具调用引擎

一个引擎 = 一个输出协议 + 它的参数。协议的三件事由引擎持有：怎么写（输出契约的提示词模板 + 工具目录）、怎么读回（解析生成文本 / 流式解析）、历史怎么回写（工具调用与结果的文本形状）。这些由 `@ai-sdk-tool/parser` 组装成中间件接到模型上，契约与工具目录由中间件在每步请求改写时注入 system，引擎不向调用方交出文本——避免两处注入同一份说明。

`native` 不接管模型（用模型原生的 function call）；其余变体用于不支持原生 function call 的模型，或需要固定输出形状的场景。模型不是 v4 规格（网关没解析出 v4 provider）时中间件不适用，模型原样返回。

`classic` 是 YesImBot v3 的 JSON OUTPUT：`thoughts`（observe / analyze_infer / plan）+ `actions` 两块，空 `actions` 即结束本轮。它与 `context.classic` 共用同一份 `<action>` / `<observation>` 渲染（`src/toolcall/classic.engine.ts` 导出），协议钩子与上下文投影不会各写一份而漂移。

## 停轮判定

core 的缺省是「本步出现了工具调用就再走一步」，靠 `maxSteps` 封顶。ishiki 在此基础上加一条停轮规则，写在 core 侧唯一插件的 `onStepFinish` 里（`src/runtime.ts`）：只读本步的消息流，不靠工具侧回调、不留跨步标志。

- 本步直调了 `finish` → 停。收尾是模型的显式宣言，同批还有别的工具也停。
- 本步直调了 `send_message`，且每次调用的结果都是 `ok: true`、没有任何一次带 `continue: true` → 本步没有别的工具调用时停；有则续。
- 本步调用过其他工具（含 `code_mode`）→ 续。
- 其余交 core 缺省：有工具调用即续，`maxSteps` 兜底。

两处细节值得记下：同一批里只要有一次 `send_message` 返回 `ok: false`（含发送中途失败），判为未完成、继续走，把失败交给模型决定重试还是改口；嵌套调用（程序里调的 `send_message`）结果不落 step messages，所以程序内的发言不结束轮次——这是刻意的，程序是编排者，轮次留给模型读它的返回值。

工具名在这条判定里是字面量：`finish` 与 `send_message` 是内核机制的一部分（唯一通道与显式收尾），不由工具注册决定，与 `classic` 协议里空 `actions` 即结束同源。

## 代码模式不在工具调用族里

代码模式与上面那六个变体是**两个维度**：`toolcall` 说的是模型的输出怎么读成工具调用（用哪种协议），代码模式说的是工具面长什么样（模型直接调，还是写程序调）。两者正交，所以代码模式不进注册表，它是一块与 `innerThoughts` 平级的顶层配置（`src/tools/codemode.ts`，装配点在 `runtime.ts` 的 `ensure()`）。

机制：模型那一侧只剩一个工具 `code_mode`，参数是一段程序；程序在 QuickJS 沙箱里跑，经 SDK 绑定的 `tools.*` 调宿主工具。宿主工具在模型目录里被摘掉，模型的工具描述里换成从 schema 生成的 TS 签名。省下的是上下文而不是时间——工具返回的中间数据进的是沙箱变量，只有 `return` 出去的那一份回模型。

分区由「谁能调谁」一张表决定，语义由 SDK 定：

- 表里点名的工具从模型目录消失，只从沙箱可达；
- 表里没点名的工具留在模型目录，沙箱也够不着——所以「只直调」不必写进表；
- 同时写 `code_mode` 与直调标记的工具两处都可达。

`send_message` 走第三条：两处都可达。停轮判定读本步的消息流，只认模型直调的那次调用——嵌套调用的结果不落 step messages，程序里说了话也不结束轮次，模型下一步拿到程序 `return` 的值再决定收尾。两头都要：直调发言省一层程序，程序里也要能说话。于是表里同时写两个 caller。`finish` 与 `direct` 追加的纯直调工具只留在目录：收尾是模型直调的专属动作，程序里的收尾不该结束轮次。

三条边界（库的既定行为，不是本插件的选择）：

- 沙箱内拿不到 `process`、`require`、文件系统、`fetch`、WebCrypto，`eval` 也没有；宿主工具本身跑在沙箱外面，授权与校验仍要在每个工具里自己做。
- 工具审批不集成：沙箱内的调用没法暂停生成去弹审批框，被误收进沙箱的审批类工具会被拒绝而非执行。
- 程序返回时还有未 await 的调用在飞 = 整次调用失败；返回值必须 JSON 可序列化。

嵌套调用是普通的工具调用：core 的 runTool 包装在 caller 工具与它绑定的宿主工具上各套一层，于是内层的 `tool.start` / `tool.done` 事件与 `beforeToolCall` / `afterToolCall` 钩子照常发生，日志与 hook 都不失明。core 侧的这两处改动见 `@yesimagent` 的 `AgentConfig.toolCallers`（转发给 AI SDK 时改名为 `experimental_toolCallers`）。

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

## 新增一个贡献物

引擎是「选一个」，贡献物是「加一些」：包对某一个 AgentRuntime 提供工具与提示词，不抢决策。

1. 建一个 Koishi 插件，以 `ishiki.ext.<包名>` 提供服务（`new Service(ctx, "ishiki.ext.<包名>")`）。
2. 在服务上写 `extend(coords)`：内核在装配点对每个实例叫一次的就是这个成员。它拿到本实例的坐标（单频道形态是一个具体频道，聚合形态是认领的账号），返回 `{ tools, instructions }`；这个实例用不上它就返回 `undefined`。
3. 在 preset 的 `extends` 里写上包名。`extends` 是唯一的准入处与依赖声明处；工具不另起名字，撞名在装配点抛错。
4. 归位由内核定：工具并入内核工具之后、`innerThoughts` 之前、代码模式收窄之前；提示词接在内核那一段之后，按 `extends` 的顺序。

坐标里没有的东西不要从别处推：`channel.type` 要用自己从 Koishi 取；包自己发的消息不结束轮次（停轮只认 `finish` 与 `send_message`）。完整契约与刻意的缺失项见 [03-community-extension-mechanism.md](../03-community-extension-mechanism.md)。
