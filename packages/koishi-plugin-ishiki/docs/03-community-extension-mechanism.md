# 社区扩展机制（Pre-Channel / Pre-Profile 分区下的注册与可见域）

状态: 已定（8 步全部落地；唯一的实测假设已由 `tests/extensions.spec.ts` 验证）
日期: 2026-09-27
来源: 扩展设计讨论（多群寻址 → 包外受众 → 分区梳理 → cordis 失效语义 → 装配层级）

## 结论

扩展机制面向社区作者，围绕 Agent 的两种运行形态（Pre-Channel / Pre-Profile）组织为三层：**进程级注册表 → preset 级选中 → 形态决定的实例层**。配置面统一为一棵 preset 树（preset 下要么挂 `scenes`，要么 `cross: true` + `claims`），装配面以 Scene/Plan/Runtime 三层消除配置单位与运行单位的不对等。社区只能向既有引擎族注册新变体，core 的分区与插入位置封闭；变体的可见性由 preset 的 `extends` 显式选中，未列出的不生效；ProfileRuntime Service 化，扩展失效时受影响的 profile 经 cordis inject fiber 整体重启，失效传播不自造。**工具与提示词的加法贡献本阶段不做**（见「本阶段范围」）。

## 本阶段范围

贡献物（扩展包提供的工具与提示词：注册动词、按 `extends` 过滤、装配时实例化）在设计里成立，但**本阶段不实现**——相关注册表与装配合流已撤除。当前社区面只有一件事：向三族引擎注册新变体，并由 `extends` 决定哪些 preset 用得上它。贡献物落地时要一并定的三件事记在这里，免得重新讨论一遍：

1. 注册名 `包名/名字`，前缀即归属与准入依据；工具对模型可见的名字取斜杠后那一段（平台对工具名有字符限制）。
2. 贡献物按装配坐标实例化：工厂拿到 `{ ctx, logger, sid, channelId, directory, resources }`，这次装配里不适用时返回 `undefined`；两个包给出同一个可见名时在装配处报错，不静默覆盖。
3. 贡献物是加法（`extendTools` / 提示词接在内核之后），不进上下文管线的改写段；停轮等唯一决策点仍归内核。

## 被否定的前提

1. **原假设：插件需要按频道实例化，`ChannelContext`/`Bot` 注入是扩展的上下文来源。**
   - **为什么站不住**：这是 YesImBot 的模型。ishiki 没有 `AgentPlugin` 按频道实例化这一步：`AgentPlugin` 契约里没有频道，频道只出现在 `ensure` 的工具闭包与 `SceneRuntime.channelId` 两处；引擎连记账键都不收——账归谁由事实流里每条消息自带的频道号给出。地址在 ishiki 里一向是事实载荷字段与调用时参数（受体归一化时写入，`session-handler.ts`），从来不是注入的上下文物件。
   - **替换判定**：可见域是宿主实例的属性，不是工具的静态属性。扩展物实例能看到什么，由它的宿主实例的可见域决定，而宿主实例的可见域由形态决定。引擎跟着宿主走，不自带可见域。
   - **反例与推翻事实**：把可见域写成工具自身属性（如 window/channel/account 三分）是用工具自身属性回答运行形态的问题，两条形态下同一个工具的可见域本来就不同。

2. **原假设：同一份插件/引擎需要同时适配单群与多群两种场景，为不同场景提供不同工具策略。**
   - **为什么站不住**：这把复杂度转嫁给插件作者，且让每个作者各自维护坐标格式与校验规则。形态差异属于内核装配路径，不属于扩展物。
   - **替换判定**：同一份注册走两条装配路径，形态由生效单位（scene 或 cross preset）决定；坐标处理差异（内核填值 vs 模型显式给值）由内核吃掉，扩展物无感知。

3. **原假设：社区可以新开引擎族、新增插入位置，用描述符接口（FamilyDescriptor / ContributionDescriptor / 槽位表）描述扩展。**
   - **为什么站不住**：引擎族是 core 精心设计的分区（上下文 / 唤醒 / 工具调用 / 记忆），社区新开族等于打破分区；描述符机器是 core 里只有一个使用者的接口层，违反 04-rendering 的 YAGNI 判据（「等第二种实现真的出现再加注册表」）。
   - **替换判定**：社区只能向既有族注册变体（`registerXEngine` 语义原样：重名抛错、未登记抛错）；插入位置封闭，由 core API 枚举；要开新位置就是改 core，那是内核的事。

4. **原假设：core 的钩子链（`AgentPlugin`）是社区扩展的挂载点。**
   - **为什么站不住**：core 的钩子合成规则里混着两种形状——管道式（`onAppend`/`transformEntries`/`afterToolCall`/`extendTools`）与唯一决策式（`onStepFinish` 首个非 undefined 胜出、`prepareStep` 覆写 `StepOptions`、`beforeToolCall` 改写 `ToolDecision`、`toModelMessages` 先注册者认领）。唯一决策式没有「共同正确」的合成语义，社区一拿到手就是上一代用 `priority` 与 `match(session)` 抢拦截权的复辟。
   - **替换判定**：core 内只有一个 `AgentPlugin`（装配器），由内核持有，选择并装配所有激活的引擎。引擎本身可以都不是 `AgentPlugin`（上下文族今天挂在插件链上是投机设计，待装配器收编）。社区面不存在 `AgentPlugin` 类别，只有注册表。

5. **原假设：扩展失效传播需要 ishiki 自己实现（依赖 diff、引擎实例热替换），或依赖 cordis v4 的 isolate 隔离域。**
   - **为什么站不住**：失效传播正是 cordis inject fiber 的既有契约（koishi 4.18 → cordis 3.18.1：`internal/before-service` → required inject 该服务的 scope `reset()`，`internal/service` → `start()`）；isolate/realm 解决的是「同一服务名多实例并存」（athena 的 per-Life 需求），ishiki 的 profile 是 service 内的数据、注册表是进程级一张表，没有这个需求；v3 的 realm 实现还依赖 loader 的 delims/swap 补丁舞，不成熟。硬造 per-profile isolate 的代价是社区包副作用乘 N。热替换引擎实例则是 athena 报告点名的 fiber reload 做不到的状态迁移问题，手写同样要面对。
   - **替换判定**：失效粒度 = profile 重启档。扩展包停用 → 其服务消失 → 只命中选中它的 profile fiber → reset（profile 停止，事实流在盘上不丢，进行中轮次死亡）；扩展包回来 → start → profile 重载。

6. **原假设：`cross-channel: true` 作为 preset 上的布尔开关（02 号文档原方案）。**
   - **为什么站不住**：一个 preset 类型承载两种配置语义。`typing`/`failover` 等 per-channel 字段在共享实例下语义漂移，schema 无法表达「cross 时禁止写」，校验只能靠装载期手写；聚合关系隐式（哪些 scene 合流要全文搜索按引用拼图）；把已有多 scene 引用的 preset 标上 cross 会立即合流全部引用者，副作用范围不由声明处决定。
   - **替换判定**：配置统一为 preset 树，`cross: true` + `claims` 成为显式的结构声明（见「装配层级」）。合流范围 = 声明处所见；`cross` 开关只影响叶子层语义，不产生意外聚合。
   - **推翻事实**：中间方案「独立 cross 块」也不取——它消灭了 cross 的引用间接层，却在同一份配置里留下 `scenes:` 与 `cross-scenes:` 两种心智形状。preset 树把两种形态统一进一个结构，规则更少。

7. **原假设：scene 覆写需要「独占才可覆写」之类的合法性规则。**
   - **为什么站不住**：这条规则建立在误读上——「共享 preset」共享的是定义，不是配置产物。scene 的字段是在 preset 基线上的**扩展**，三层合并 per-scene 独立进行，生效范围被自己的 matchlist 天然圈住，跨 scene 冲突在结构上不可能产生。cross preset 则相反：scene 只有路由权，配置只有 preset 层生效。
   - **替换判定**：树形结构下扩展（scene 就地覆写、范围限自身频道）与禁止（cross 下 scene 无配置权）都是结构事实，无需任何规则条文与校验逻辑。

## 装配层级（Scene / Spec / Runtime）

配置单位与运行单位脱钩：配置只算一次，实例按需长出来。

```
Preset   配置层   心智基线 + 形态开关（scenes 挂靠 或 cross: true + claims）
Spec     展开层   SceneSpec：三层合并后的装配清单（含引擎配置与可见域）
Runtime  运行层   AgentRuntime 实例（原 SceneRuntime 更名），按 spec 诞生
```

**生效单位**：非 cross 是 scene（matchlist 圈定的频道集）；cross 是 preset（全部 claims 的频道并集）。

**Spec 是冻结配置，不是活实例**：模型引用名、引擎配置、可见域（匹配器或频道并集）。模型实例（`FailoverModel`）、上下文引擎、唤醒引擎、工具调用层、工具集全部在 Runtime 诞生时构造，随实例销毁——生命周期只有「实例」一种单位，没有 preset 级的共享活物。

引擎（`context` / `wakeup` / `toolcall`）配置走同一条三层合并，scene 可就地覆盖；实例随 `AgentRuntime` 诞生与销毁，一个实例一套。上下文引擎与 agent 一对一（跨 agent 共享会让一个频道的压缩读另一个频道的存储）；唤醒引擎的账本只看本视窗的事实流，需要跨实例感知时经 `WakeupEngineDeps.shared`（profile 级状态池）自管读写，不共享实例。变体准入仍按 preset 的 `extends` 校验，scene 覆写不放开这道门。

**展开规则只有一条**：一个生效单位，按可见域基数诞生 Runtime——Pre-Channel 每匹配频道一个，Pre-Profile 每块一个。`matchSceneSpec` 路由照旧（事件 → scene → 归属频道），scene 持有自己的合并结果；cross 的生效单位就是 preset 自身。

## 配置面（preset 树）

```yaml
presets:
  chat: # 心智基线
    extends: [neko-tools] # 缺省 []：只用内核机制
    model: gpt-4o
    context: { engine: standard }
    scenes: # 挂靠：归属由结构声明
      ops:
        sid: onebot:111
        whitelist: ["group:111_ops"]
        model: claude-opus # 就地扩展，范围 = 自己的 matchlist
      chat:
        sid: onebot:111
        whitelist: ["group:111_chat"]

  fused: # cross preset：自身即生效单位
    cross: true
    extends: [neko-tools]
    model: gpt-4o
    claims:
      "onebot:111": { whitelist: ["group:111_ops", "group:111_chat"] }
      "onebot:222": { whitelist: ["private:*"] }
```

统一规则：**preset 下要么有 `scenes`（每个 scene 一个生效单位，可就地扩展），要么 `cross: true`（preset 本身是生效单位，`claims` 认领频道）**。scene 字段的语义是「在这个场景里扩展 preset 基线」，不是覆写他者；cross 下 scene 层不存在配置权，preset 层是唯一配置源。

装载期校验（一次性报出，坏 preset/scene 只跳过自己）：

- preset 既无 `scenes` 又非 `cross` → 报错（空心智）。
- `cross: true` 且写了 `scenes` → 报错（互斥）；缺 `claims` → 报错。
- 普通 scene 缺 `sid` / `whitelist` → 报错（现状规则平移）。
- 频道认领冲突（scene matchlist 与 cross claims 交叉、兄弟 scene 交叉）→ 报错（沿用「同一频道只归一个 scene」）。
- `extends` 引用未安装的包、引擎变体名拼错、变体所属包未选中 → 报错。

已知代价（接受）：scene 标识从 `profile/scene` 变为 `profile/preset/scene`（目录名仍可用 scene 名，profile 内唯一性由树位置保证；日志 label 用全路径）。配置文件不进 WebUI，四层嵌套不构成编辑体验问题。

## 新机制（扩展面）

### 1. 两种形态（分区地基）

|          | Pre-Channel（普通 preset + scenes）     | Pre-Profile（cross preset）                      |
| -------- | --------------------------------------- | ------------------------------------------------ |
| 装配单位 | scene × 频道，按需诞生                  | preset × claims 频道并集，一块一实例             |
| 实例坐标 | `{ sid, channelId }` 单值               | 频道集合，无单值「当前位置」                     |
| 可见域   | 本频道的事实流                          | 整个频道集合的合并事实流（地址在每条事实载荷上） |
| 落盘     | `scenes/<sid>_<channelId>/events.jsonl` | `scenes/cross_<presetName>/events.jsonl`         |

关键差异：Pre-Channel 的实例**知道**自己在哪个频道，Pre-Profile 的实例**只知道自己覆盖哪些频道**。可见域判定单位：Pre-Channel 按频道，Pre-Profile 按频道集合（preset 聚合命名空间）。

### 2. 三层机制

| 层     | 单位       | 内容                                                                                      | 生命周期                                                   |
| ------ | ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 注册层 | 进程级全局 | 引擎变体的类型定义（贡献物留待后续阶段）                                                  | 模块加载或 apply 期，宿主持有，随 Koishi 插件 dispose 撤销 |
| 选中层 | preset 级  | preset 的 `extends` 决定哪些包的变体可用、`context.engine` 等选哪个变体；scene 可就地扩展 | 静态配置，树内合并                                         |
| 实例层 | 形态决定   | Pre-Channel 每频道一份；Pre-Profile 每块一份                                              | 按需诞生，随实例 dispose                                   |

推论：注册层永远进程级（不存在 profile 私有变体，否则注册表按 profile 分片与 #8 矛盾）；选中层永远 preset 级；实例层由形态决定，同一份注册两种实例化，没有第二套接口。

### 3. 注册面

既有三族不动（`registerContextEngine` / `registerWakeupEngine` / `registerToolcallEngine`），社区变体继承同族基类，一并导出基类与参数表接口（`ContextEngines` 等，供 `declare module` 增强）。本阶段开放的就是这三族：

```ts
// 经 ctx.ishiki 调用；社区变体用 `包名/名字`，前缀即归属与准入的依据。
ctx.ishiki.registerContextEngine("neko-tools/rolling", (config, options) => new RollingEngine(config, options));
ctx.ishiki.registerWakeupEngine("neko-tools/greedy", (config, deps) => new GreedyWakeup(config, deps));
ctx.ishiki.registerToolcallEngine("neko-tools/xml", (config) => new XmlToolcall(config));
```

暴露方式经 `ctx.ishiki` 薄转发（绑定运行中服务实例，不依赖模块解析唯一性；包外把 ishiki 装成普通 dependency 会产生第二份注册表实例并静默失效，这是用服务命名空间而非根导出的原因）。注册在 apply 期同步完成，`ready` 后注册不受支持。

注册随调用方的插件生命周期撤销：cordis 把服务方法里的 `this.ctx` 绑在调用方作用域上，转发器据此把反注册挂进调用方的 effect——包卸载即消失，重装同名注册不会撞「已登记」。

### 4. 选中与寻址

`extends` 是**扩展包名数组**，选中单位是包，不含任何参数级配置；包内的细分归包自身 Koishi Config。preset 说「这个心智用得上这个包的能力」，包配置说「这个包怎么行为」。preset 文件 + `extends` 清单即完整依赖声明，分享 preset 等于声明了它需要的扩展包。带包前缀的名字（`包名/名字`）要求该包被 `extends` 选中：装载期检查，未选中的 spec 跳过自己并报出原因；无前缀的名字是内建变体，不问 `extends`。`extends` 因此是唯一的依赖声明处。

静态准入与动态过滤的分界：**静态管谁能上场，动态管这场谁上场**。`extends` 只做包级准入（进程粒度、装载期解析）；到了贡献物那一阶段，运行时过滤归包自己——工厂拿得到装配上下文（哪个频道、什么形态），按自己的逻辑决定给出什么（onebot-utils 的 `isGroupScope` 模式）。内核不替包做频道级过滤。内核两件工具（`send_message` / `finish`）不受此表管辖，它们是内核机制。

工具寻址随形态分两条路径、同一份校验代码：

- Pre-Channel：坐标唯一，内核填进工具入参或在工具内部解析，模型看不到坐标字段。
- Pre-Profile：坐标由模型显式给，内核校验目标落在本 preset 覆盖的频道集合内，非法目标走报错重试闭环（`send_message` 的既有语义：失败表达在结果里，不表达在进程里）。

坐标不放进每个工具的 schema：可达地址清单留在系统提示里，否则 `group:*` 这类白名单会让工具目录膨胀。

### 5. 装配器（core 唯一 AgentPlugin）

core 侧只有一个插件，由 `AgentRuntime` 装配时在 `runtime.ts` 里就地拼出（`createAgentPlugin`）：上下文引擎不再实现 `AgentPlugin`，它只声明自己干预上下文管线上的哪几段（`init` / `stop` / `onAppend` / `transformEntries` / `transformMessages` / `extendInstructions` / `onTurnFinish`，签名直接取自 core 的插件契约），由这一个入口按固定顺序转发。停轮判定写在同一个插件的 `onStepFinish` 里，读本步消息流得出（停轮是内核机制，不是扩展点），不进社区面。唤醒与工具调用引擎不进 `AgentPlugin`，只负责建好交给既有取用点。

Service 化的只是生命周期容器，不是装配逻辑：`ensure`/装配器照旧是普通代码，不因 fiber 化改形状——fiber 重跑从 Plan 零装配是接受的代价（事实流在盘上）。

### 6. 失效语义（cordis 承载）

- 社区扩展包 = Koishi 插件，`static inject = ["ishiki"]`，以 `Service` 子类提供服务（如 `ishiki.ext.neko-tools`），apply 期经 `ctx.effect()` 注册，unload 时 effect 反注册、服务随 fiber 消失。
- **ProfileRuntime Service 化**：装载 profile 时按所有 preset 的 `extends` 并集算出依赖的扩展服务名，每 profile 一个 `ctx.inject(services, callback)` fiber（cordis v3 里它就是 `plugin({ inject, apply, name })` 的语法糖，每次调用一个独立匿名插件 fiber）。依赖缺失 → fiber 停在非激活态，`ready` 监听器挂 pending，不报错不加载；依赖出现 → `internal/service` → `start()` → fiber 重跑 → profile 重载。callback 具名（`ishiki/profile:<id>`），否则日志与 WebUI 里是匿名。装载拆成两步：`loadProfiles` 只解析出可装载项（含依赖服务名），`activateProfiles` 才按 fiber 实例化。
- **AgentRuntime（原 SceneRuntime）不做 Service**：单位是 scene × 频道，频道集合由运行时事件发现（`route` → `ensure` 按需诞生），`whitelist: ["group:*"]` 这类通配无法预声明 fiber；生命周期挂在 ProfileRuntime 内（scenes 表 + profile stop 逐个收），Profile fiber 化后归属自然成立。
- 扩展包停用 → 服务消失 → 选中它的 profile fiber reset → disposables 逆序跑 `runtime.stop()`；恢复 → profile 重载（事实流自盘恢复，连续性不丢）。粒度自动 per-profile：未选中该扩展的 profile 不依赖该服务，不动。不存在「包停了但 profile 继续跑旧贡献」的混合态。
- 失效两类分治：**缺失等待**（扩展包不在，fiber 静默等 cordis 的 ready 门，到位自动激活）与**配置错误报错**（校验清单见配置面一节；装载期一次性报出，坏的只跳过自己）。

## 已定细节

1. 可见域是宿主实例属性；工具声明的是它需要什么坐标，与可见域是两个问题。
2. 唤醒引擎不收记账命名空间：`attach(agent)` 只挂一个视窗，账归谁由事实流自己说明——每条消息都带自己的频道号，引擎从事件里读，一个频道一块账，聚合与单频道走同一份代码。`attach` 返回拆卸函数，场景停止时调用点调它。
3. 停轮（`onStepFinish`）、`prepareStep`、`beforeToolCall`、`toModelMessages` 四类唯一决策钩子不进社区面；需要变体时在 core 内收成引擎族。
4. 失效粒度取 profile 重启，不取引擎热替换；机制全部现成，轮次损失有界且由事实流兜底。
5. 社区变体与内置变体写同一张注册表，语义一致：重名抛错、未登记抛错、不静默退化。
6. `SceneRuntime` 更名 `AgentRuntime`：代码、测试与在用文档均已改名，`lib/` 随下次构建重生成。
7. 非 cross 下模型实例照旧 per-scene（每 scene 一份 FailoverModel 重试状态）；仅 cross 的共享 Runtime 一套实例。现状行为零收缩。

## 待验证假设

1. ~~**inject fiber 的重跑语义**~~（已验证）：`tests/extensions.spec.ts` 用最小扩展包跑通了全链路——服务缺席时 profile 不实例化；包装上后自动装载；`pkg.dispose()` 后 profile 停止并移出，重装后重建（事实流在盘上）；注册随包停用而撤销，重装同名不撞；无包前缀的内建变体不受 `extends` 门控。

2. **Pre-Profile 下工具坐标准确率**：模型在多频道合并窗口里显式给坐标的正确率（02 号文档待验证假设 1 的同一件事，扩展面复用其结论）。
   - 验证方式与失败含义见 02 号文档。

## 实现进度

1. [x] 树解析 + 装载期校验（`profile.ts` 重构、`ChannelClaim` 同形复用、五条校验、认领冲突按同 sid 白名单相交保守判定；`profile-tree.spec.ts` 20 例；旧 spec fixture 已迁移）。
2. [x] Plan 层改造（`Plan` 冻结配置与活物分层、`createPlan`、实例按生效单位键索引）。
3. [x] cross Runtime 聚合（共享事实流 `cross_<preset>/`、聚合寻址头、run-length 合并、跨账号复合坐标）。
4. [x] `send_message` 复合寻址（显式 target + 范围校验 + 报错重试闭环）。
5. [x] `SceneRuntime` → `AgentRuntime` 改名。
6. [x] 装配器收编（core 侧唯一插件在 `runtime.ts` 的 `createAgentPlugin`；上下文引擎不再实现 `AgentPlugin`，钩子在这一点收拢；`TurnControl` 保持内核独占）。
7. [x] ProfileRuntime fiber 化 + 注册面导出（`loadProfiles`/`activateProfiles` 两步、`ctx.inject` 按 `extends` 并集门控、`ctx.ishiki.registerContextEngine`/`registerWakeupEngine`/`registerToolcallEngine` 三件、根导出基类与参数表接口）。
8. [x] 端到端验证（`tests/extensions.spec.ts` 5 例：缺席等待与重装重建、装载出的 profile 能路由起场景、注册随包停用撤销、未选中包变体跳过、无前缀变体不受门控）。

贡献物（工具与提示词）的注册与装配合流本阶段未做，见「本阶段范围」。
