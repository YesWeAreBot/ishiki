# Ishiki 核心运行时

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/public/logo-dark.svg">
  <img src="../../docs/public/logo.svg" alt="Ishiki：意识的运行时，人格的栖息地" width="740">
</picture>

[项目首页](../../README.md) · [完整文档](https://ishiki.js.org/docs/) · [扩展 API](https://ishiki.js.org/docs/reference/api/) · [English](README.en.md)

`koishi-plugin-ishiki` 是 Ishiki 基于 Koishi 的核心运行时。它把 [yesimagent](https://github.com/YesWeAreBot/yesimagent) 的 Agent 循环、模型网关与 Koishi 平台接入组织在一起，通过 profile 运行拥有稳定身份、独立经历与可定制行为的 Agent。

核心提供三个同族互斥的引擎族：**Context** 组织模型输入，**Toolcall** 定义模型交互，**Wakeup** 控制运行时机。工具与提示词可以通过扩展增加，资源通过 scheme URL 统一读取；codemode 与 toolsearch 可以按 profile 启用。

## 安装与接入

准备好：

- Koishi **4.18.11 或更高的 4.x 版本**，以及已经配置的聊天平台适配器。
- Node.js **20+** 与 Bun。
- 一个可用的模型接口及其凭据。默认 `native` 工具调用引擎需要模型支持原生工具调用。

当前使用源码构建接入。以下假设 Koishi 应用目录 `koishi-app` 与源码目录 `ishiki` 位于同一个父目录，从该父目录开始执行：

```bash
git clone https://github.com/YesWeAreBot/ishiki.git
cd ishiki
bun install
bun run build

cd packages/koishi-plugin-ishiki
bun link
cd ../../../koishi-app
bun link koishi-plugin-ishiki
```

在 Koishi 应用的 `koishi.yml` 中启用：

```yaml
plugins:
  ishiki: {}
```

默认数据目录为 Koishi 应用下的 `data/ishiki/`，可以通过插件配置 `dataPath` 修改。

## 创建第一个 Agent

### 1. 声明模型

创建 `data/ishiki/models.yaml`：

```yaml
providers:
  my-api:
    api: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: YOUR_API_KEY
    models:
      - id: your-model-name
        input: [text]
        contextWindow: 128000
        maxTokens: 8192
```

将 `baseUrl`、`apiKey`、模型 `id` 替换为实际值；窗口与输出上限按模型能力填写。`api` 选择接口方言，其他供应商与模型组的配置见[接入模型供应商](https://ishiki.js.org/docs/guides/models/)。

模型凭据以明文保存在此文件中，请限制文件访问权限，避免将数据目录提交到版本库。

### 2. 声明 profile

创建 `data/ishiki/profiles/my-first/profile.yml`：

```yaml
model: my-api:your-model-name
mode: channel

channels:
  "onebot:BOT_ID":
    - "CHANNEL_ID"

context:
  engine: standard
wakeup:
  engine: standard
toolcall:
  engine: native
```

将 `onebot:BOT_ID` 替换为适配器的 `platform:selfId`，将 `CHANNEL_ID` 替换为实际频道标识。频道名单支持精确匹配、末尾 `*` 前缀匹配与 `!` 排除项；`"*"` 表示该账号下的全部频道。

三组引擎的示例值也是默认选择，可以省略对应段落。每个族通过 `engine` 选择一个变体，变体的配置放在同名子段中。

### 3. 写下人格

在同一个 profile 目录创建 `persona.md`：

```markdown
你是小雪。表达清晰，保留自己的判断与好奇心。
记住正在推进的事情，使用工具完成能够执行的任务；
需要向对方表达时，直接说明结果。
```

`persona.md` 会进入系统提示词。同一 profile 派生的 runtime 使用同一份人格声明。

### 4. 启动与确认

启动 Koishi，确认日志中出现 profile 激活信息。在已认领的频道中 @ 机器人或引用它的消息，即可命中默认唤醒规则；已认领的私聊也会触发运行。默认的可见回复由 `send_message` 发到平台。

runtime 按需创建，并在 profile 目录下生成 `runtimes/`，保存会话日志与资源。完整操作与排障见[快速上手](https://ishiki.js.org/docs/tutorial/quickstart/)。

## 选择实例组织方式

| 模式              | runtime 数量         | 历史与资源       | 消息目标                         |
| ----------------- | -------------------- | ---------------- | -------------------------------- |
| `channel`（默认） | 每个频道按需创建一个 | 按频道隔离       | 直接发往当前实例所属频道         |
| `cross`           | 整个 profile 一个    | 所有认领频道共享 | `send_message` 必须携带 `target` |

要让同一人格共享多个频道的经历，可以修改 profile 的 `mode` 与 `channels`：

```yaml
mode: cross
channels:
  "onebot:BOT_ID": ["CHANNEL_A", "CHANNEL_B"]
```

cross 模式的上下文带有来源频道坐标。Agent 根据这些坐标选择消息目标，目标必须属于 profile 认领范围。多个 profile 可以并行运行，各自认领不同频道。

[了解 profile 激活、实例派生与共享范围 →](https://ishiki.js.org/docs/explanations/profiles-runtimes/)

## 启用工具编程与按需发现

在 profile 中启用：

```yaml
codemode:
  enable: true
toolsearch:
  enable: true
```

两项默认关闭。codemode 将业务工具组织到 QuickJS 程序调用入口；toolsearch 让非常驻工具经 `search` 发现，并从下一步加入可用目录。`send_message` 可直接调用或由程序调用，`finish`、`wait` 保持直接调用。

工具结果中的资源可以通过 URL 引用。内核提供 `asset://`、`artifact://`、`local://`；扩展可以增加自己的 scheme，并使用已有的 `read` 读取。每个 runtime 拥有独立资源中心。

[工具调用与资源流程 →](https://ishiki.js.org/docs/explanations/tools-pipeline/)

## 接入扩展与引擎

先构建并链接扩展包，在 Koishi 中启用，再通过 profile 的 `extends` 为该人格启用能力。以 workspace 为例：

```yaml
# koishi.yml 的 plugins 段
plugins:
  ishiki: {}
  ishiki-workspace: {}
```

```yaml
# profile.yml
extends:
  workspace:
    config:
      backend: sandbox
```

workspace 提供文件与命令工具。MCP 接入、OneBot 协议操作等能力也有独立扩展，见[项目生态](../../README.md#生态与参与)。

引擎变体通过 `context.engine`、`toolcall.engine`、`wakeup.engine` 选择。安装并启用提供对应引擎服务的 Koishi 插件后，即可按名字使用；例如 narrative 提供配套的上下文与工具调用引擎，engine-v3 提供 `v3` 的上下文、工具调用与唤醒引擎。

开发者可以通过三个入口增加能力：

- **Extension**：追加工具、提示词，并管理实例所需资源的生命周期。
- **引擎变体**：定制上下文、模型交互或运行调度。
- **SchemeHandler**：增加资源来源，沿用 `read` 的统一访问方式。

[编写扩展、引擎与资源 handler →](https://ishiki.js.org/docs/reference/api/)

## 启动问题

| 现象                             | 检查与处理                                           |
| -------------------------------- | ---------------------------------------------------- |
| 提示 `missing required service`  | 检查引擎或扩展名称，以及对应 Koishi 插件是否已经启用 |
| profile 因认领冲突被跳过         | 调整 `channels`，使用 `!` 排除重叠的频道             |
| profile 已激活，消息没有触发运行 | 核对账号与频道标识，确认命中当前唤醒引擎的条件       |
| 模型请求失败                     | 检查接口方言、地址、凭据、模型名称与工具调用支持情况 |

配置变更后重新加载插件。请求记录、日志与详细排障见[调试指南](https://ishiki.js.org/docs/guides/debugging/)。

## 许可证

[MIT](../../LICENSE) · [Yes! We Are Bot!](https://github.com/YesWeAreBot)
