# koishi-plugin-ishiki

数字生命的运行时内核，以 Koishi 插件形态实现。

- 一个 **Profile** 是一个心智，也是一个人设：一个 `profile.yaml` 定义它，目录名就是它的全局唯一 id。
  它声明用哪个模型、用哪些运行策略、启用哪些扩展包，认领哪些账号与频道。多实例部署的最小差异化单元就是它。
- 一个 **Scene** 是一个频道内独立运行的意识实例：自己的历史、自己的模型前缀、自己的轮次。频道之间不共享上下文，只能通过两扇门互相看见（[02-attention](./docs/cookbook/02-attention.md)）。
- 事实流写在磁盘上（`events.jsonl`），模型每轮看到的只是它的一段投影。投影不写回事实流。

概念、机制与设计取舍见 [`docs/cookbook`](./docs/cookbook/)。想改代码先从 [`docs/cookbook/00-principles.md`](./docs/cookbook/00-principles.md) 和 [`docs/cookbook/05-engines.md`](./docs/cookbook/05-engines.md) 开始。

## 安装

```sh
npm i koishi-plugin-ishiki
```

需要 `koishi ^4.18.11`。运行时依赖 `@yesimagent/core`（agent 循环与存储）、`@yesimagent/gateway`（模型解析与降级）、`@ai-sdk-tool/parser`（纯文本工具调用协议）、`@ai-sdk/code-mode`（代码模式的沙箱），随本包一起安装。代码模式用到 core 的 `AgentConfig.toolCallers`（转发给 AI SDK 时改名 `experimental_toolCallers`），需要一个带该配置的 `@yesimagent/core`。

## 数据目录

插件配置里的 `dataPath`（默认 `data/ishiki`）是全部运行数据的根：

```text
data/ishiki/
  models.yaml                                  # gateway 配置：端点、模型、降级组
  requests/                                    # dumpRequests 打开时保存的原始请求与响应
  profiles/<目录名>/
    profile.yml | profile.yaml                 # 心智定义：一个文件一个 profile
    persona.md                                 # 可选：人设正文，接在内置基础提示词之后
    mcp.json                                   # 可选：扩展包（如 mcp-client）读的同层配置
    memory/*.md                                # 可选：核心记忆块，context.v3 的 memoryBlocks 读取
    scenes/<sid>_<channelId>/events.jsonl      # 普通形态：该频道唯一的事实流
    cross/events.jsonl                         # cross 形态：合流视窗唯一的事实流
```

目录名即 profile 的 id，全局唯一，没有文件内 `id` 字段。普通形态的实例目录名由 `sid` 与 `channelId` 拼接并把文件系统禁用字符替换为 `_`，只作定位用；cross 形态一个 profile 只有一个合流视窗，固定放在 `cross/`。

`models.yaml` 不存在时会被自动创建为空文件并记一条告警。模型写在 `profile.yaml` 的 `model` 字段：`provider:model` 或 `models.yaml` 里定义的组名。

## 插件配置

| 键             | 缺省          | 说明                                       |
| -------------- | ------------- | ------------------------------------------ |
| `dataPath`     | `data/ishiki` | 数据存储路径                               |
| `dumpRequests` | `false`       | 把每次模型请求与响应原样落盘到 `requests/` |
| `logLevel`     | `2`（info）   | 日志级别                                   |

## 最小 profile

```yaml
# profiles/neko/profile.yaml
name: neko # 可选，仅备注
description: 示例人设

model: onebot:gpt-4o-mini # 或 models.yaml 里的组名
context:
  engine: standard
  standard:
    maxTokens: 32000
wakeup:
  engine: standard
  standard:
    direct: true
    atSelf: true

scenes:
  groups:
    sid: onebot:10000
    whitelist: ["group:*"]
  dms:
    sid: onebot:10000
    whitelist: ["private:*"]
```

`profile.yaml` 的字段分两层：顶层是这份心智的基线（模型、引擎、扩展包），`scenes` 下的每一项是装配清单：认领一个账号下的若干频道，并可以局部覆写基线的字段。字段全集见 [01-profile](./docs/cookbook/01-profile.md)，带注释的完整示例见 [`resources/profile.example.yml`](./resources/profile.example.yml)。

## 启动行为

- `profiles/` 不存在：只记一条告警，不装载任何心智。
- 工具调用解析库或代码模式库装载失败：一个 profile 都不装载，服务继续存在但不接事件。
- 单个 profile 目录读不动、结构不合法（缺 `scenes` 又非 `cross`、scene 缺 `sid` 或 `whitelist`）：只跳过它自己，其余照常装载。
- 两个 profile 认领同一账号下的同一频道：按目录名排序，先装载的接管，后者整体跳过并记一条 error。
- 账号自己的平台消息（`userId === selfId`）在入口丢弃，不进入任何事实流。
- 场景实例在首次有事件落到它头上时创建，进程退出时统一停止。

## 开发

```sh
bun run test          # vitest
bun run build         # yakumo build：类型检查与打包
bun run lint          # oxlint
bun run format:check  # oxfmt
bunx tsc --noEmit -p tsconfig.json   # 全仓类型门禁（含 tests）
```

编码约定见仓库根 [`AGENTS.md`](../../AGENTS.md)，反复踩过的坑见 `~/.agents/LESSONS.md`。
