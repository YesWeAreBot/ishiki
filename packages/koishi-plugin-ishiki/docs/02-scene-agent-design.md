# Scene Agent 架构设计与配置规约

状态: 已定
日期: 2026-09-23
来源: 上下文分区重构之单个 Scene Agent 深度收敛讨论

## 结论

确立单个 Scene Agent 的核心设计：**以 Profile 为工厂与命名空间、按场景独立懒加载的轻量级 Actor（Scene Agent）**。

其核心拓扑为：**维度解耦（Profile = Dimension）+ DSH 风格配置分层（Base / Presets / Patch）+ 显式场景规则绑定 + 纯刺激驱动生命周期 + 目录自包含纯流存储（`session.jsonl`）**。

---

## 被否定的前提

### 1. “异构维度（聊天、游戏、直播）应当塞入同一个 Profile 声明”

- **原假设**：通过在单一 Profile 内部增加场景类型分支，统一管理实体在所有维度下的表现。
- **为什么站不住**：
  - **推理循环异构**：IM 聊天是事件驱动轮次循环（Turn Loop），游戏具身是高频控制与状态采样循环（Tick Loop），直播是流式弹幕缓冲与音频朗读队列（Stream Queue Loop）。三者时钟与驱动机制完全不同，强行共用同一状态机会导致流程彻底变形。
- **推翻依据**：维度天然属于不同的 Profile / Runtime。它们通过中央 Event Bus 进行异步内生刺激（`inner_stimulus`）与回执投递，而不是共享同一个推理生命周期。`koishi-plugin-ishiki` 的定位被严格收敛为数字生命在 **IM 聊天维度**的专属运行时。

### 2. “Scene Agent 需要在本地维持自主心跳与常驻循环”

- **原假设**：为了维持实体的持续存在与主动性，每个群聊 Agent 内部需要维护常驻心跳定时器（Tick Loop）进行自主反思与主动说话。
- **为什么站不住**：
  - **资源与空转灾难**：若接入上百个群，常驻进程会导致内存与轮询 Token 消耗失控，且易在无人群聊中产生自言自语的社交骚扰。
- **推翻依据**：“无自主心跳”不等于无法自主行动。Scene Agent 的全部主动行为统一收敛为接收外部系统或扩展投递的“内生刺激”。主动发言的因果决策完全在被刺激唤醒后的单轮本地推理中完成。

### 3. “长历史管理与状态需要引入 checkpoint 状态机与旁路 state.json”

- **原假设**：在 `session.jsonl` 旁侧设立 `state.json` 记录离散状态，并用 checkpoint 机制维持断点。
- **为什么站不住**：
  - 引入了双写一致性风险与状态原地篡改的不可审计性；增加了长历史加载与跨场景穿透的解析负担。
- **推翻依据**：坚持 YAGNI 原则，上下文修剪依赖通用的 `compact` 机制，不自造复杂的 checkpoint 状态机；`state_delta`、好感度与成员画像等复杂状态全部推迟，不提前污染事实流。

---

## 新机制与核心规范

### 1. 自包含目录存储形态（Storage Surface）

每个 Profile 采用完全自治、高内聚的目录组织结构：

```text
data/ishiki/profiles/<profile-catalog>/
  ├── profile.yaml                # 基线资产：实体内核定义、Presets 与场景白名单
  ├── profile.patch.yaml          # 环境补丁：部署级/环境级参数覆写（可选）
  └── scenes/
      └── <sanitizedSceneKey>/
          └── session.jsonl       # 单场景专属客观事实流（Append-only）
```

- **`<profile-catalog>`**：维度与 Profile 的专属标识（如 `im`，多实例可命名为 `im-neko` 等）。
- **`scenes/<sanitizedSceneKey>/`**：场景隔离目录，`sanitizedSceneKey` 对特殊字符（如 Windows 禁用的冒号）进行无歧义编码。
- **`session.jsonl`**：复用 yesimagent 的 Session Storage，物理磁盘上仅维护这一份客观事实日志。
- **极简跨场景穿透（JIT Peeking）**：跨场景查询直接以只读方式读取目标 `session.jsonl` 文件的尾部行，被窥视的 Scene Agent **完全不需要载入内存**。

### 2. DSH 风格的配置分层与显式绑定

配置体系全面吸收 deepseek-harness（DSH）的组装与覆写哲学：

#### A. 基线资产（`profile.yaml`）

```yaml
id: neko
model: gpt-4o-mini
systemPrompt: "你是猫娘，性格傲娇但善良。"
sid:
  - "onebot:12345678"

# 可复用的能力预设包（Presets）
presets:
  group:
    promptExtension: "当前在公开群聊，发言简短克制。"
    tools: [send_message, peek_channel_history]
    wakeup: { atMe: true, keywords: ["猫猫", "neko"] }
  direct:
    promptExtension: "当前是私密对话，态度可以更温和亲近。"
    tools: [send_message, peek_channel_history, send_photo]
    wakeup: { always: true }

# 显式白名单与 Preset 绑定规则
channels:
  - channel: "onebot:private:*"
    preset: direct
  - channel: "onebot:group:*"
    preset: group
```

#### B. 环境补丁（`profile.patch.yaml`，可选）

遵循 DSH Overlay 规范，仅用于特定环境的局部特化，保持基线配置的整洁：

```yaml
# 针对特定场景覆盖参数
scenes:
  "onebot:group:123456":
    preset: group
    promptExtension: "这是研发核心群，请严格停止使用猫娘口癖。"
```

### 3. 反应型生命周期（Lifecycle Topology）

- **无本地循环**：Agent 内部不存在常驻定时器。
- **事件驱动挂载**：外部消息到达或中央 Event Bus 投递 `inner_stimulus` 时，动态将对应场景的 Scene Agent 挂载进内存，从 `session.jsonl` 恢复上下文。
- **完整推理闭环**：单次唤醒执行一轮完整的推理决策（决定说话还是保持沉默，以及调用哪些工具）。
- **空闲安全驱逐（Eviction）**：单轮交互结束后进入空闲计时，空闲超时后自动从内存中释放卸载，状态完全由磁盘上的 `session.jsonl` 维系。

---

## 已定细节

1. **维度物理隔离**：IM 维度专属于 `profiles/im`，游戏和直播未来作为独立的 Profile 挂载，不与 IM 共享同一配置文件与推理流程。
2. **显式规则绑定**：禁止依赖隐式黑盒规则推断场景预设，场景白名单必须显式声明绑定的 `preset` 名称。
3. **裁剪模式**：历史修剪采用通用 `compact`，取消自造的复杂 checkpoint 机制。
4. **命名一致性**：持久化会话日志统一命名为 `session.jsonl`，对齐 DSH 与行业统一认知。

---

## 待验证假设

1. **JIT Peeking 的文件读取开销**：
   - _假设内容_：跨场景直接读取目标 `session.jsonl` 尾部 N 行的操作足够快，在高频跨群穿透场景下对磁盘 I/O 不会构成瓶颈。
   - _验证方法_：压测并发读取 50 个非活跃群聊 `session.jsonl` 尾部日志的时延。
   - _失败意味着_：需要在 Runtime 内存层维护轻量级的最近尾部消息 LRU 缓存。

2. **空闲驱逐的阈值设定**：
   - _假设内容_：设定 60s ~ 120s 的空闲回收窗口既能保障连续聊天的前缀缓存复用，又能防止多群并发时的内存膨胀。
   - _验证方法_：在多群真实对话测试中监控进程内存曲线与 Agent 创建/销毁抖动频率。
   - _失败意味着_：引入动态 LRU 策略（按最大活跃 Agent 数量上限进行淘汰），而非单纯的固定时间超时。

---

## 下一步

1. **数据模型升级**：在插件配置解析器中实现 DSH 风格的 `profile.yaml` 与 `profile.patch.yaml` 加载与叠加合并逻辑。
2. **SceneManager 重构**：编写场景路由与生命周期管理器，实现基于 `(profileId, sceneKey)` 的懒加载、路由分发与空闲卸载机制。
3. **Session 路径迁移**：将读写路径平滑迁移至 `data/ishiki/profiles/<catalog>/scenes/<sceneKey>/session.jsonl`。
