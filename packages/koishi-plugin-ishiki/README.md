# Ishiki 核心运行时

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/YesWeAreBot/ishiki/main/docs/public/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/YesWeAreBot/ishiki/main/docs/public/logo.svg" alt="Ishiki：意识的运行时，人格的栖息地" width="740">
</picture>

[项目首页](https://github.com/YesWeAreBot/ishiki/README.md) · [完整文档](https://ishiki.js.org/docs/) · [扩展 API](https://ishiki.js.org/docs/reference/api/) · [English](README.en.md)

`koishi-plugin-ishiki` 是 Ishiki 基于 Koishi 的核心运行时。它把 [yesimagent](https://github.com/YesWeAreBot/yesimagent) 的 Agent 循环、模型网关与 Koishi 平台接入组织在一起，通过 profile 运行拥有稳定身份、独立经历与可定制行为的 Agent。

核心提供三个同族互斥的引擎族：**Context** 组织模型输入，**Toolcall** 定义模型交互，**Wakeup** 控制运行时机。工具与提示词可以通过扩展增加，资源通过 scheme URL 统一读取；codemode 与 toolsearch 可以按 profile 启用。

## 安装与接入

需要 Koishi **4.18.11 或更高的 4.x 版本**、已经配置的聊天平台适配器，以及一个可用的模型接口及其凭据。默认 `native` 工具调用引擎需要模型支持原生工具调用。

插件已经发布在 Koishi 插件市场。在 Koishi 控制台左侧打开「插件市场」，搜索 `koishi-plugin-ishiki`，依次点击「添加」与「安装」，再到「插件配置」启用。市场安装的发布包已经包含运行时与控制台资源，不需要下载源码、运行 `bun install` 或手动链接插件。

默认数据目录为 Koishi 应用下的 `data/ishiki/`，可以通过插件配置 `dataPath` 修改。

安装与首次对话的完整步骤见[快速上手](https://ishiki.js.org/docs/tutorial/quickstart/)。

## 创建第一个 Agent

全新数据目录第一次启动时，插件会在 `data/ishiki/models.yaml`、`data/ishiki/profiles/default/profile.yaml` 与同目录的 `PERSONA.md` 释放一套可直接修改的预设。

预设默认使用 `chat` 上下文、`standard` 唤醒、`native` 工具调用和开启的 codemode。已有数据目录不会被写入或覆盖。

### 1. 声明模型

修改 `data/ishiki/models.yaml`，替换供应商名称、接口地址、凭据和模型名称：

```yaml
providers:
  deepseek:
    baseUrl: https://api.deepseek.com/v1
    apiKey: YOUR_API_KEY
    api: openai-completions
    models:
      - id: deepseek-flash
        reasoning: true
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 384000
        thinking:
          mode: effort
          efforts: [none, low, high, max]
```

窗口与输出上限按实际模型能力填写。`api` 选择接口方言，其他供应商与模型组的配置见[接入模型供应商](https://ishiki.js.org/docs/guides/models/)。

模型凭据以明文保存在此文件中，请限制文件访问权限，避免将数据目录提交到版本库。

### 2. 声明 profile

修改 `data/ishiki/profiles/default/profile.yaml`，把账号与频道占位项换成实际值：

```yaml
model: deepseek:deepseek-flash
mode: channel

channels:
  "onebot:BOT_ID":
    - "*"

context:
  engine: chat
wakeup:
  engine: standard
toolcall:
  engine: native
codemode:
  enable: true
```

将 `onebot:BOT_ID` 替换为适配器的 `platform:selfId`。频道名单支持精确匹配、末尾 `*` 前缀匹配与 `!` 排除项；`"*"` 表示该账号下的全部频道。

预设显式选择了三组引擎，每个族通过 `engine` 选择一个变体，变体的配置放在同名子段中。

### 3. 写下指令文件

修改同目录下的 `PERSONA.md`（`instructions` 的缺省值）：

```markdown
你是一位清晰、耐心、可靠的对话伙伴。

先理解对方真正想解决的问题，再给出直接、可执行的回应。需要查证时使用工具确认事实；能够完成的操作直接完成，并把结果说明白。

保持稳定的判断，不迎合，也不把责任推回给对方。
```

`instructions` 接收文件列表，内容按声明顺序拼接后附加到系统提示词末尾；相对路径以 profile 目录为准，也可以写绝对路径。文件缺失只记录日志警告，不阻止启动。

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

## 启用工具编程

在 profile 中启用：

```yaml
codemode:
  enable: true
  direct: []
```

默认开启。codemode 把业务工具收进 QuickJS 沙箱，模型写一段 JavaScript 调用它们，中间数据不进入上下文。`send_message` 可直接调用或由程序调用，`finish`、`wait` 保持直接调用；`direct` 列出的业务工具同时保留在模型目录里。

沙箱里有一套确定的环境：`tools["原名"]` 调用宿主工具，`searchTools(query)` 与 `describeTool(name)` 按关键词检索工具声明，`text()` 与 `console.log()` 显式输出，`image()` 保存图片，`store()` 与 `load()` 在会话内保存小状态。脚本的执行结果按 STATUS、WALL TIME、RESULT、TEXT、CONSOLE、ATTACHMENTS、ERROR 分节返回；`// @options` 可以覆盖单次调用的超时与输出预算。

工具结果中的资源可以通过 URL 引用。内核提供 `asset://`、`artifact://`、`local://`；扩展可以增加自己的 scheme，并使用已有的 `read` 读取。每个 runtime 拥有独立资源中心。

[工具调用与资源流程 →](https://ishiki.js.org/docs/explanations/tools-pipeline/)

## 接入扩展与引擎

从 Koishi 插件市场安装对应扩展，再到「插件配置」启用，然后通过 profile 的 `extends` 为该人格启用能力。以 workspace（包名 `koishi-plugin-ishiki-workspace`）为例：

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

## 管理控制台

插件市场安装的发布包已经包含控制台产物。同时启用 `@koishijs/plugin-console` 与本插件后，控制台只注册一个 Ishiki 入口。模型、Profile、会话、运行时、用量与缓存页面在 Ishiki 内部侧栏切换。页面读取 `src/management/` 提供的快照，写入通过带权限校验的控制台接口完成。

- 模型保存按文件摘要校验修订版本，先写临时文件再原子替换；密钥只回传配置状态，明文不会进入页面、日志或审计。
- 模型编辑器按模型类型切换字段，可以从提供商的在线名单导入声明（服务端代理请求，密钥不下发到页面）；模型与 Profile 编辑器都支持表单与 RAW（YAML）双向同步，保存前统一校验。
- 配置向导分步完成基础信息、模型、频道认领、人格与引擎，最后一步统一创建；重新进入向导会回填已保存的配置。
- Profile 保存与应用分开：保存只改文件，应用会重新解析配置并重建运行实例。删除需要输入完整 Profile 标识。
- 会话按字节游标分页读取 `events.jsonl`，损坏行单独报告，其余条目继续返回。
- 用量页基于原始用量记录展示按天折线图；模型组、具体模型与缺少映射的引用分开统计，缓存缺失时显示明确的数据状态。

只有修改 `client/` 下的源码后，开发环境才需要重新构建控制台产物：

```bash
bun run --cwd packages/koishi-plugin-ishiki console:build
```

控制台入口加载构建后的 `dist` 目录。使用插件市场发布包的用户无需执行这条构建命令。

## 启动问题

| 现象                             | 检查与处理                                           |
| -------------------------------- | ---------------------------------------------------- |
| 提示 `missing required service`  | 检查引擎或扩展名称，以及对应 Koishi 插件是否已经启用 |
| profile 因认领冲突被跳过         | 调整 `channels`，使用 `!` 排除重叠的频道             |
| profile 已激活，消息没有触发运行 | 核对账号与频道标识，确认命中当前唤醒引擎的条件       |
| 模型请求失败                     | 检查接口方言、地址、凭据、模型名称与工具调用支持情况 |

配置变更后重新加载插件。请求记录、日志与详细排障见[调试指南](https://ishiki.js.org/docs/guides/debugging/)。

其他常见现象见[常见问题与排查](https://ishiki.js.org/docs/guides/troubleshooting/)。无法自行定位时，可以到 [GitHub Issues](https://github.com/YesWeAreBot/ishiki/issues) 提交脱敏日志。QQ交流群：[857518324](https://qm.qq.com/q/EeL0FDu3JK)。

## 许可证

[MIT](../../LICENSE) · [Yes! We Are Bot!](https://github.com/YesWeAreBot)
