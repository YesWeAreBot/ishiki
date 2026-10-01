# 社区扩展机制（Pre-Channel / Pre-Profile 分区下的加法与可见域）

状态: 已定（9 步全部落地；注入 fiber 的失效语义已由 `tests/extensions.spec.ts` 实测）
日期: 2026-10-01
来源: 扩展设计讨论（多群寻址 → 包外受众 → 分区梳理 → cordis 失效语义 → 装配层级）

## 结论

扩展机制面向社区作者，围绕 Agent 的两种运行形态（Pre-Channel / Pre-Profile）组织为三层：**进程级服务 → preset 级选中 → 形态决定的实例层**。配置面统一为一棵 preset 树（preset 下要么挂 `scenes`，要么 `cross: true` + `claims`），装配面以 Spec/Runtime 两层消除配置单位与运行单位的不对等。社区只能向既有引擎族加新变体，core 的分区与插入位置封闭；变体的可用性只由那个 Koishi 服务在不在决定，preset 按最终 spec 的服务名 `ctx.inject(...)`；ProfileRuntime 是持久宿主，preset 失效时受影响的 preset 经 cordis 注入 fiber 整体重启，失效传播不自造。除此之外社区面还有一件加法：包对某一个 AgentRuntime 提供工具与提示词，由 `ctx.ishiki.provide()` 登记的 handler 承担（见「贡献物（加法）」）。

## 贡献物（加法）

社区面除了注册引擎变体，还有一件加法：包对某一个 AgentRuntime 提供工具与提示词。

**登记**：不走注册动词，也不新开注册表。工具不从配置按名查找，配置只写 `extends` 的包名，服务名 `ishiki.ext.<包名>` 已经是准入门；服务本身就是登记处。包调一次 `ctx.ishiki.provide()`，它内部开一条 fiber 建服务：

```ts
export class NekoTools extends Plugin {
  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    ctx.on(
      "dispose",
      ctx.ishiki.provide("neko-tools", (presetConfig, runtime) => {
        const options = parseConfig(presetConfig);
        return {
          extendTools: () => createTools(options, runtime.domain),
          extendInstructions: () => `检索上限 ${options.maxResults}。`,
          dispose: () => client.close(),
        };
      }),
    );
  }
}
```

- 内核在 `AgentRuntime` 构造期间、`createAgent` 之前对每个实例叫一次 handler，**同步**；异步准备在包的构造期做完。
- handler 拿到的是已初始化基础字段、尚未创建 `Agent` 的实例。`agent` 本身碰不到，包只能交回一个 `Extension`：`extendTools` / `extendInstructions` 两个钩子，名字与合成规则都照抄 `AgentPlugin` 的同名钩子，区别是内核不缓存——core 每轮第一步取一次，工具面与提示词因此每轮现算。
- 每频道的过滤归包自己：包看着 `runtime.domain` 决定这档要不要加，用不上就返回 `undefined`，一个字也不必加。
- 返回值里的 `dispose` 是这次挂载的拆卸函数，实例停止时逆序执行。工具与提示词不撤销——它们每轮从钩子现取，随实例一起消失。

**两个 disposer 是两件事**：`ctx.ishiki.provide()` 返回的那个拆掉的是**服务**（连同那条 fiber），必须由扩展插件绑在自己的生命周期上；返回值里的 `dispose` 清理的是**这一个 AgentRuntime 上的挂载**，由 AgentRuntime 停止时逆序执行。cordis 把服务绑在调用方那条 fiber 上，所以 `ctx.on("dispose", ...)` 是归属声明而不是可选的卫生习惯。

**坐标**从实例上直接取：`runtime.ctx`、`runtime.domain`、`runtime.directory`。

- `ctx`：平台能力与其它 Koishi 服务的入口。内核不另造能力面——插件是 Koishi 插件，手上本来就有 `ctx`，缺的只有实例坐标。
- `domain`：本实例的可见域，形态进判别式。单频道形态给 `{ form: "channel", platform, selfId, channelId }`（取自路由已知的事件寻址）；聚合形态给 `{ form: "cross", accounts: [{ sid, claim }] }`，`sid` 就是配置面 `claims` 的键本身。从 sid 反推 platform 与 selfId 是 00 号文第 6 条禁止的那件事，所以两种形态各给自己手上那份。
- `directory`：本实例的数据目录，包自己的文件放自己的子目录里。

同一份 domain 也交给本实例的上下文引擎（决定事实行带不带寻址头）：它是「本实例覆盖哪些频道」的唯一载体，形态只在这一处表达，各消费方自己按 `form` 分支。

刻意不给：`channel.type`（要用自己从 Koishi 取）、`logger`（`ctx.logger("包名")` 才是 tag 正确的那个）、`resources`（内核拿不到别的包的路径）、profile / preset / scene 名（要按 preset 行为是包配置的寻址问题，不靠坐标加名字）。

**归位与时机**：每一轮的第一步，core 向内核要一次工具面与提示词。工具面的拼法是内核工具 + 各包的增量（按 `extends` 的顺序），之后整份工具面统一前置 `innerThoughts`，再按收窄表进代码模式；提示词接在内核那一段之后。内核不缓存这两样，包每轮拿到的是这一轮的现取结果——要它跨轮不变，由包自己在闭包里缓存。与内核工具或先装配的包撞名抛 `ToolConflictError`，不静默覆盖；合并在轮次里进行，这个错误因此表现为那一轮失败，而不是实例起不来。贡献物是纯加法：上下文管线的改写段与唯一的收尾、停轮判定都不进社区面。

**出站**：包有 `ctx`，要发消息就能发，内核不铺路也不设闸；但停轮判定只认内核的 `finish` 与 `send_message`，包的工具落在「其他工具 → 续轮」，包自己发的消息不结束轮次。

**代价**：handler 抛错只能在这一实例诞生时暴露；引擎变体的准入在装载期只看服务在不在，贡献物查不出来，因为它依赖实例坐标——这是「实例按需诞生」的必然。handler 抛错时装配回滚：已拿到 `Extension` 的挂载按逆序拆掉，不给包留悬挂的引用；包自己在返回之前开的资源拆不了，内核拿不到 `Extension` 就拆不了。钩子里的错误（含撞名）落在轮次里，由 core 记成轮次失败，实例本身不受影响。

## 被否定的前提

1. **原假设：插件需要按频道实例化，`ChannelContext`/`Bot` 注入是扩展的上下文来源。**
   - **为什么站不住**：这是 YesImBot 的模型。ishiki 没有 `AgentPlugin` 按频道实例化这一步：`AgentPlugin` 契约里没有频道，频道只出现在 `ensure` 的工具闭包与 `SceneRuntime.channelId` 两处；引擎连记账键都不收——账归谁由事实流里每条消息自带的频道号给出。地址在 ishiki 里一向是事实载荷字段与调用时参数（受体归一化时写入，`session-handler.ts`），从来不是注入的上下文物件。
   - **替换判定**：可见域是宿主实例的属性，不是工具的静态属性。扩展物实例能看到什么，由它的宿主实例的可见域决定，而宿主实例的可见域由形态决定。引擎跟着宿主走，不自带可见域。
   - **反例与推翻事实**：把可见域写成工具自身属性（如 window/channel/account 三分）是用工具自身属性回答运行形态的问题，两条形态下同一个工具的可见域本来就不同。

2. **原假设：同一份插件/引擎需要同时适配单群与多群两种场景，为不同场景提供不同工具策略。**
   - **为什么站不住**：这把复杂度转嫁给插件作者，且让每个作者各自维护坐标格式与校验规则。形态差异属于内核装配路径，不属于扩展物。
   - **替换判定**：同一份注册走两条装配路径，形态由生效单位（scene 或 cross preset）决定；坐标处理差异（内核填值 vs 模型显式给值）由内核吃掉，扩展物无感知。

3. **原假设：社区可以新开引擎族、新增插入位置，用描述符接口（FamilyDescriptor / ContributionDescriptor / 槽位表）描述扩展。**
   - **为什么站不住**：引擎族是 core 精心设计的分区（上下文 / 唤醒 / 工具调用），社区新开族等于打破分区；描述符机器是 core 里只有一个使用者的接口层，违反 04-rendering 的 YAGNI 判据（「等第二种实现真的出现再加注册表」）。
   - **替换判定**：社区只能向既有族加变体，变体以 Koishi 服务存在（`ishiki.engine.<族>.<名字>`，重名由 cordis 抛错）；插入位置封闭，由 core 的引擎族枚举；要开新位置就是改 core，那是内核的事。

4. **原假设：core 的钩子链（`AgentPlugin`）是社区扩展的挂载点。**
   - **为什么站不住**：core 的钩子合成规则里混着两种形状——管道式（`onAppend`/`transformEntries`/`afterToolCall`/`extendTools`）与唯一决策式（`onStepFinish` 首个非 undefined 胜出、`prepareStep` 覆写 `StepOptions`、`beforeToolCall` 改写 `ToolDecision`、`toModelMessages` 先注册者认领）。唯一决策式没有「共同正确」的合成语义，社区一拿到手就是上一代用 `priority` 与 `match(session)` 抢拦截权的复辟。
   - **替换判定**：core 内只有一个 `AgentPlugin`（装配器），由内核持有，把上下文引擎的方法转发到 core 的钩子上。三个引擎族的运行体都不是 `AgentPlugin`：上下文族有自己的方法名（`attach` / `prepareEntries` / `renderMessages` / `instructions`），唤醒族只给判定与挂载时机，工具调用族作用于装配期的模型值。社区面不存在 `AgentPlugin` 类别。

5. **原假设：扩展失效传播需要 ishiki 自己实现（依赖 diff、引擎实例热替换），或依赖 cordis v4 的 isolate 隔离域。**
   - **为什么站不住**：失效传播正是 cordis inject fiber 的既有契约（koishi 4.18 → cordis 3.18.1：`internal/before-service` → required inject 该服务的 scope `reset()`，`internal/service` → `start()`）；isolate/realm 解决的是「同一服务名多实例并存」（athena 的 per-Life 需求），ishiki 的 profile 是 service 内的数据、注册表是进程级一张表，没有这个需求；v3 的 realm 实现还依赖 loader 的 delims/swap 补丁舞，不成熟。硬造 per-profile isolate 的代价是社区包副作用乘 N。热替换引擎实例则是 athena 报告点名的 fiber reload 做不到的状态迁移问题，手写同样要面对。
   - **替换判定**：失效粒度 = preset 重启档。扩展包停用 → 其服务消失 → 只命中依赖它的 preset fiber → reset（该 preset 停止，事实流在盘上不丢，进行中轮次死亡）；扩展包回来 → start → preset 重载。ProfileRuntime 是持久宿主，不随 preset 消失。

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

引擎（`context` / `wakeup` / `toolcall`）配置走同一条三层合并，scene 可就地覆盖；实例随 `AgentRuntime` 诞生与销毁，一个实例一套。上下文引擎与 agent 一对一（跨 agent 共享会让一个频道的压缩读另一个频道的存储），造在 `AgentRuntime` 构造期、扩展挂载之后，所以它看到的是扩展加完的那份工具面与提示词；唤醒引擎的账本只看本视窗的事实流，`WakeupEngineDeps` 只带一个可选 logger，没有跨实例的状态池。变体准入按最终 spec 算出的服务名——scene 换变体就是换依赖，换不出一个新族去。

preset 是激活与错误隔离的单位：ProfileRuntime 是持久宿主（不随 preset 消失），每个 preset 一条 cordis fiber，键在它自己 `extends` 的包服务与最终 spec 的引擎服务上。preset 级错误（schema、语义、认领冲突、服务缺失）只跳过或等待那一个 preset；root profile 的错误与跨 preset 的频道认领冲突让整个 profile 失败。

**展开规则只有一条**：一个生效单位，按可见域基数诞生 Runtime——Pre-Channel 每匹配频道一个，Pre-Profile 每块一个。`matchSceneSpec` 路由照旧（事件 → scene → 归属频道），scene 持有自己的合并结果；cross 的生效单位就是 preset 自身。

## 配置面（preset 树）

```yaml
presets:
  chat: # 心智基线
    extends: # 缺省不写：只用内核机制。键是包名，值是这个 preset 给它的东西。
      neko-tools: # 只写包名即启用（enable 缺省为 true）
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
    extends:
      neko-tools:
        config: # 原样递给 handler，字段含义由包自己解释
          maxResults: 20
      vision-pack:
        enable: false # 认识但这一档不要：不依赖、不等待、不调用
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
- `extends` 引用未安装的包（记 error，preset 停在等待态，服务到了自动激活）→ 报错；`enable` 不是布尔值 → 报错；`enable: false` 的包既不依赖也不校验。引擎变体的服务名算出来不存在 → 同样停在等待态。

`extends` 属于 preset，scene 层没有这个字段——准入是 preset 的承诺，不随覆写放开。

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

| 层     | 单位       | 内容                                                                                      | 生命周期                                |
| ------ | ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| 服务层 | 进程级全局 | 引擎变体的 provider Service；贡献物的 `ishiki.ext.<包名>` Service                         | 插件构造期，随 Koishi 插件 dispose 撤销 |
| 选中层 | preset 级  | preset 的 `extends` 决定挂了哪些包、`context.engine` 等选哪个变体；scene 可就地换引擎变体 | 静态配置，树内合并                      |
| 实例层 | 形态决定   | Pre-Channel 每频道一份；Pre-Profile 每块一份                                              | 按需诞生，随实例 dispose                |

推论：服务层永远进程级（不存在 profile 私有变体，否则服务名按 profile 分片，与失效粒度的设计矛盾）；选中层永远 preset 级；实例层由形态决定，同一份服务两种实例化，没有第二套接口。

### 3. 引擎变体

开放的就是三族（`context` / `wakeup` / `toolcall`），社区变体继承同族 provider 基类，一并导出基类与参数表接口（`ContextEngines` 等，供 `declare module` 增强）。**没有注册动词**：变体就是继承 `ContextEngine`（或同族基类）的 Koishi 服务，构造时 `super(ctx, "<名字>")` 就登记在 `ishiki.engine.<族>.<名字>` 上：

```ts
export class RollingEngine extends ContextEngine<"neko-tools/rolling"> {
  constructor(
    ctx: Context,
    private readonly plugin: PluginConfig,
  ) {
    super(ctx, "neko-tools/rolling");
  }

  create(config: Partial<ContextEngines["neko-tools/rolling"]>, options: ContextEngineOptions): ContextEngineInstance {
    return new RollingContextInstance({ ...this.plugin, ...config }, options);
  }
}

declare module "../src/context/engine.js" {
  interface ContextEngines {
    "neko-tools/rolling": RollingRuntimeConfig;
  }
}
```

**可用性只由那个服务在不在决定**，名字带不带包前缀无关准入（带前缀的形状是更早的方案）。preset 按服务名 `ctx.inject(...)`，服务缺失就停在等待态并报一条。provider 只持有插件级配置；`create()` 每次造一份全新的运行体，随 `AgentRuntime` 生灭。

基类与参数表从包根导出（`import { ContextEngine } from "koishi-plugin-ishiki"`）。根导出而不是自建子路径，是因为包外把 ishiki 装成普通 dependency 时，子路径可能解析到第二份运行时。

贡献物不走这条路：它没有按名查找的需求，见「贡献物（加法）」。

### 4. 选中与寻址

`extends` 是**包名到配置对象的映射**，选中单位是包。`enable` 缺省为 `true`；`config` 原样递给该包的 handler，字段含义由包自己解释；`enable: false` 表示这一档不要——不建立依赖、不等待、不调用、不校验 `config`。preset 说「这个心智用得上这个包的能力」，包配置说「这个包怎么行为」。preset 文件 + `extends` 即完整依赖声明，分享 preset 等于声明了它需要的扩展包。

静态准入与动态过滤的分界：**静态管谁能上场，动态管这场谁上场**。`extends` 只做包级准入（进程粒度、装载期解析）；贡献物这一层，运行时过滤归包自己——handler 拿得到本实例的坐标（具体频道，或聚合形态下的认领），按自己的逻辑决定给出什么（onebot-utils 的 `isGroupScope` 模式）。内核不替包做频道级过滤。内核两件工具（`send_message` / `finish`）不受此表管辖，它们是内核机制。

工具寻址随形态分两条路径、同一份校验代码：

- Pre-Channel：坐标唯一，内核填进工具入参或在工具内部解析，模型看不到坐标字段。
- Pre-Profile：坐标由模型显式给，内核校验目标落在本 preset 覆盖的频道集合内，非法目标走报错重试闭环（`send_message` 的既有语义：失败表达在结果里，不表达在进程里）。

坐标不放进每个工具的 schema：可达地址清单留在系统提示里，否则 `group:*` 这类白名单会让工具目录膨胀。

### 5. 装配器（core 唯一 AgentPlugin）

core 侧只有一个插件，由 `AgentRuntime` 装配时在 `runtime.ts` 里就地拼出（`createAgentPlugin`）。上下文引擎有自己的方法名，不索引 `AgentPlugin`：

```ts
interface ContextEngineInstance {
  attach?: (agent: Agent) => () => void;
  prepareEntries?: (entries: readonly AgentEntry[], request: ContextRequest) => readonly AgentEntry[] | Promise<readonly AgentEntry[]>;
  renderMessages?: (messages: readonly AgentMessage[], request: ContextRequest) => AgentMessage[] | Promise<AgentMessage[]>;
  instructions?: () => string | undefined | Promise<string | undefined>;
}

interface ContextRequest {
  readonly turnId: string;
  readonly signal: AbortSignal;
}
```

core 的钩子名只出现在 `createAgentPlugin` 这一处，按固定顺序转发过去。停轮判定写在同一个插件的 `onStepFinish` 里，读本步消息流得出（停轮是内核机制，不是扩展点），不进社区面。唤醒与工具调用引擎不进 `AgentPlugin`，只负责建好交给既有取用点。

完整上下文（指令 + 消息 + 工具）的领域责任归上下文引擎，但 core 目前没有 `prepareContext` 这类钩子：`extendInstructions()` 在流裁剪之前就调，所以 `instructions()` 拿不到本轮 entries；`prepareStep` 之后只给 `ModelMessage`，跨步上下文无处可取。因此接线是分段的，不是一次成型——这不是假装做到，是 core 的既有边界。工具不在其中流转：它在 `AgentRuntime` 构造期固定，作为只读快照进 `ContextEngineOptions`。

Service 化的只是生命周期容器，不是装配逻辑：装配器照旧是普通代码，不因 fiber 化改形状——fiber 重跑从零装配是接受的代价（事实流在盘上）。

### 6. 失效语义（cordis 承载）

- 社区扩展包 = Koishi 插件，`static inject = ["ishiki"]`，在构造器里调 `ctx.ishiki.provide("neko-tools", handler)`。它内部开一条 fiber 建 `ishiki.ext.neko-tools` 服务，返回的 disposer 卸掉这条 fiber；扩展自己把它绑在 `ctx.on("dispose", ...)` 上，服务就随插件生灭。
- **preset 是 fiber 单位**：装载时按每个 preset 的 `extends` 与最终 spec 的引擎服务算出依赖，一个 preset 一条 `ctx.inject(services, callback)` fiber。依赖缺失 → fiber 停在非激活态并记一条 error，preset 保持等待，不加载；依赖出现 → `internal/service` → `start()` → fiber 重跑 → preset 激活。callback 具名（`ishiki/preset:<profile>:<preset>`），否则日志与 WebUI 里是匿名。
- **ProfileRuntime 是持久宿主，不做 fiber**：它与 preset 无关，load 期就建好，零激活 preset 时也在（fiber 无关的宿主，preset 各挂各的 fiber）。每个 preset 一个 `PresetRuntime`（specs + 按 `cross_<preset>` 或 `sid_channelId` 键索引的 AgentRuntime），路由从 `ProfileRuntime.route` 走到各激活的 `PresetRuntime`。
- **AgentRuntime 不做 Service**：单位是生效单位 × 频道，频道集合由运行时事件发现（`route` → 按需诞生），`whitelist: ["group:*"]` 这类通配无法预声明 fiber；生命周期挂在 `PresetRuntime` 内。
- 扩展包停用 → 服务消失 → 依赖它的 preset fiber reset → 该 preset 的 AgentRuntime 逐个 `stop()`（disposers 逆序跑）；恢复 → preset 重新激活，AgentRuntime 全新创建，handler 重新被叫一次。粒度自动 per-preset：未挂该扩展的 preset 不依赖这个服务，不动。不存在「包停了但 preset 继续跑旧贡献」的混合态。
- 失效两类分治：**缺失等待**（扩展包不在，fiber 静默等 cordis 的 ready 门，到位自动激活）与**配置错误报错**（校验清单见配置面一节；装载期一次性报出，坏的只跳过自己）。

## 已定细节

1. 可见域是宿主实例属性；工具声明的是它需要什么坐标，与可见域是两个问题。
2. 唤醒引擎不收记账命名空间：`attach(agent)` 只挂一个视窗，账归谁由事实流自己说明——每条消息都带自己的频道号，引擎从事件里读，一个频道一块账，聚合与单频道走同一份代码。`attach` 返回拆卸函数，场景停止时调用点调它。
3. 停轮（`onStepFinish`）、`prepareStep`、`beforeToolCall`、`toModelMessages` 四类唯一决策钩子不进社区面；需要变体时在 core 内收成引擎族。
4. 失效粒度取 preset 重启，不取引擎热替换；机制全部现成，轮次损失有界且由事实流兜底。
5. 社区变体与内置变体走同一条路径：都是引擎族的 provider Service，preset 按服务名依赖，语义一致（缺失即等待，不静默退化）。
6. `SceneRuntime` 更名 `AgentRuntime`：代码、测试与在用文档均已改名，`lib/` 随下次构建重生成。
7. 非 cross 下模型实例照旧 per-scene（每 scene 一份 FailoverModel 重试状态）；仅 cross 的共享 Runtime 一套实例。现状行为零收缩。

## 待验证假设

1. ~~**注入 fiber 的重跑语义**~~（已验证）：`tests/extension-contributions.spec.ts` 用真实 Koishi Service 跑通了全链路——服务缺席时 preset 停在等待态；包装上后自动激活；`holder.dispose()` 后 preset 停止并移出，重新包装后重建（事实流在盘上）。`ctx.ishiki.provide()` 的三条语义也在真实 `Context` 上验过：disposer 幂等、重复调用无害、不牵连别的 `ishiki.ext.*`；服务随调用方 fiber 一起消失；先抓住 `ctx.ishiki` 引用再从另一条 fiber 调 provide，服务挂在调用方那条上（所以 `ctx.on("dispose", ...)` 是归属声明，不是可选卫生）。

2. **Pre-Profile 下工具坐标准确率**：模型在多频道合并窗口里显式给坐标的正确率（02 号文档待验证假设 1 的同一件事，扩展面复用其结论）。
   - 验证方式与失败含义见 02 号文档。

## 实现进度

1. [x] 树解析 + 装载期校验（`profile.ts` 重构、`ChannelClaim` 同形复用、五条校验、认领冲突按同 sid 白名单相交保守判定；`profile-tree.spec.ts` 20 例；旧 spec fixture 已迁移）。
2. [x] Plan 层改造（`Plan` 冻结配置与活物分层、`createPlan`、实例按生效单位键索引）。
3. [x] cross Runtime 聚合（共享事实流 `cross_<preset>/`、聚合寻址头、run-length 合并、跨账号复合坐标）。
4. [x] `send_message` 复合寻址（显式 target + 范围校验 + 报错重试闭环）。
5. [x] `SceneRuntime` → `AgentRuntime` 改名。
6. [x] 装配器收编（core 侧唯一插件在 `runtime.ts` 的 `createAgentPlugin`；上下文引擎不再实现 `AgentPlugin`，钩子在这一点收拢；停轮判定保持内核独占）。
7. [x] preset fiber 化（ProfileRuntime 持久宿主 + 每 preset 一条 `ctx.inject` fiber + `PresetRuntime`；`ctx.inject` 按 `extends` 与最终 spec 的引擎服务门控；公共 API 收敛为 `ctx.ishiki.provide(name, handler)`）。
8. [x] 端到端验证（`tests/extension-contributions.spec.ts` 12 例：缺席等待与重装重建、装载出的 preset 能路由起场景、注册 disposer 幂等、handler 中途抛错逆序回滚、同一包服务多个 preset 且配置隔离、Engine-only 与 Extension-only 独立）。

9. [x] 贡献物落地（`src/domain.ts` 的可见域类型与 `src/extension.ts` 的加法契约、`AgentRuntime` 构造期登记 handler 返回的 `Extension`、handler 返回 `undefined` 与抛错两条路径、每轮现取工具面与提示词、撞名在轮次里抛错）。
