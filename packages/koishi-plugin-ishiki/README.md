# koishi-plugin-ishiki

把一个或多个 bot 账号交给一个主心智。心智有自己的事实流、人格、模型和当前场景，由事件唤醒，不常驻轮询。

概念说明见 [`docs/cookbook`](./docs/cookbook/README.md)。这份文档只讲怎么把它配起来跑。

## 插件配置

| 配置           | 默认          | 说明                                                       |
| -------------- | ------------- | ---------------------------------------------------------- |
| `dataPath`     | `data/ishiki` | 相对 Koishi 的 `baseDir`。配置文件与每个心智的数据都在这里 |
| `dumpRequests` | `false`       | 打开后把每次模型请求与响应写进 `<dataPath>/debug/`         |
| `logLevel`     | `INFO`        | 日志级别                                                   |

启动时读 `<dataPath>/models.yaml` 与 `<dataPath>/profiles.yaml`。`models.yaml` 不存在时插件会建一个空文件，那时任何 profile 都起不来。

身体来自平台适配器：`ctx.bots` 的键就是 `sid`，形状是 `platform:selfId`。所以 `allowedChannels` 里写的 `sid` 必须与已加载的适配器对得上。

## 数据目录

```text
data/ishiki/
├── models.yaml            模型端点
├── profiles.yaml          心智清单
├── debug/                 dumpRequests 打开时的请求与响应副本
└── profiles/<id>/         每个心智自己的目录，位置由该 profile 的 dataPath 决定
    ├── persona.md         人格，可选
    ├── think.md           思考模板，可选，覆盖内置的那份
    ├── messages.jsonl     事实流，运行时写入
    └── tool_issues.log    工具问题记录，运行时写入
```

## models.yaml

```yaml
providers:
  myrelay:
    api: openai-completions # 必填，决定用哪个协议
    baseUrl: https://relay.invalid/v1
    apiKey: ${MYRELAY_KEY} # 必填，支持 ${环境变量}
    headers: # 可选，值同样支持 ${...}
      X-Trace: enabled
    settings: # 可选，原样交给 SDK 工厂
      authToken: ${MYRELAY_TOKEN}
    models:
      - id: vendor/model-name # 必填，端点认识的那个 id
        name: Some Model # 可选，展示名
        contextWindow: 262144
        maxTokens: 32768
        reasoning: true
        toolCall: true
        thinking:
          mode: effort
          efforts: [low, high, max]
        input: [text, image]
  myclaude:
    api: anthropic-messages
    baseUrl: https://claude.invalid
    apiKey: ${MYCLAUDE_KEY}
    models:
      - id: some-claude
        contextWindow: 200000
```

`api` 的四个内置取值：

| 取值                   | 协议                                            | `baseUrl`            |
| ---------------------- | ----------------------------------------------- | -------------------- |
| `openai-completions`   | `/chat/completions`，第三方端点与中转大多说这个 | 必填                 |
| `openai-responses`     | OpenAI 官方 API 与 Responses API                | 可省，省了走官方端点 |
| `anthropic-messages`   | Anthropic Messages API 及其兼容端点             | 可省                 |
| `google-generative-ai` | Gemini                                          | 可省                 |

`apiKey` 与 `headers` 里的 `${NAME}` 在建立 provider 时展开，变量没设会让启动失败。`anthropic-messages` 用 `apiKey` 发 `x-api-key`；要发 `Authorization: Bearer` 就改用 `settings.authToken`。

模型字段：

| 字段            | 取值                                                                          | 说明             |
| --------------- | ----------------------------------------------------------------------------- | ---------------- |
| `id`            | string                                                                        | 必填             |
| `type`          | `language` / `embedding` / `image` / `speech` / `transcription` / `reranking` | 默认 `language`  |
| `name`          | string                                                                        | 展示名           |
| `contextWindow` | number                                                                        | 上下文窗口       |
| `maxTokens`     | number                                                                        | 输出上限         |
| `reasoning`     | boolean                                                                       | 是否推理模型     |
| `toolCall`      | boolean                                                                       | 是否支持工具调用 |
| `thinking`      | `{ mode, efforts }`                                                           | 思考档位         |
| `input`         | `text` / `image` / `audio` / `video` / `pdf` 的数组                           | 接受的模态       |
| `dimensions`    | number                                                                        | 仅 embedding     |

引用一个模型写成 `<provider-id>:<model-id>`，在第一处冒号切开，所以模型 id 里可以带冒号和斜杠。

`providers` 之外还接受 `groups`，即一组可互换的模型加故障转移策略。网关支持它，ishiki 目前不读。

## profiles.yaml

```yaml
profiles:
  - id: MyMind # 必填，心智标识，同一文件内不可重复
    name: MyMind # 展示名；平台报不出账号昵称时用它，默认空
    dataPath: profiles/MyMind # 必填，相对 <dataPath>
    model: myrelay:vendor/model-name # 必填，<provider-id>:<model-id>
    initialFocus: # 必填，首次运行时打开的场景
      sid: "onebot:1234567890"
      channelId: "987654321"
    allowedChannels: # 必填，这份心智能用哪些身体、接管哪些频道
      - sid: "onebot:1234567890"
        channels:
          - "987654321"
          - "private:*"
      - sid: "sandbox:abcd1234:koishi"
        channels:
          - "#"
    keywords: [my-mind] # 命中即唤醒，默认空
    attention:
      quoteSelf: false # 被引用时是否唤醒，默认 false
      mentions: [] # 保留字段，当前不读
    context:
      workspaceTokenLimit: 16384 # 工作区预算（token），默认 8192
      charsPerToken: 4 # 估算用的每 token 字符数，默认 4
      idleMs: 1800000 # 静默多久折叠本代，默认 30 分钟
      historyEntries: 40 # 帧里每个场景最多几条，默认 40
      sceneWindowMs: 86400000 # 帧里事实的最大年龄，默认 24 小时
    innerThought: false # 是否给心智一个 think 工具，默认 false
    allowChangeFocus: true # 是否允许切换场景，默认 true
    typing: # 发送时的打字节奏
      baseDelay: 500
      charPerSecond: 5
      minDelay: 800
      maxDelay: 4000
```

`keywords`、`attention`、`context`、`typing` 整块可以省，省了取上表默认值。

`workspaceTokenLimit` 必须写在 `context` 里面。配置解析会原样保留未声明的顶层键，但运行时只读 `context.workspaceTokenLimit`，写在 profile 顶层的那个不会生效。

### 频道规则

`channels` 的每一项是一条规则：

- 精确频道 ID，或末尾带一个 `*` 的前缀通配；
- 开头加 `!` 表示排除，`!` 只能出现在最前面；
- `*` 最多一个，且必须在末尾；
- 只写排除项时，意思是「除了这些全都接管」；
- 规则为空，或事件没命中任何一条，都静默忽略。

### 启动时的校验

配置不合法会在启动时报错，不会带着半截配置跑起来：

- 每个 profile 至少要有一条 `allowedChannels` 声明，同一声明里 `sid` 不可重复，每条 `sid` 至少给一个频道；
- `initialFocus` 必须落在自己的白名单里；
- profile 的 `id` 不可重复；
- 不同 profile 在同一具身体上的场景集合不能重叠。

## 人格与模板

- `<profile.dataPath>/persona.md`：可选，接在系统提示前面。
- `<profile.dataPath>/think.md`：可选，仅在 `innerThought: true` 时生效，覆盖内置的 `resources/templates/think.md`。
- 系统提示由内置的 `resources/templates/system.md.jinja` 渲染，不可覆盖。

两者都是 Jinja 模板，可用变量为 `singleScene`、`allowChangeFocus`、`bodies`、`profileName`；系统模板另有一个 `thinkPrompt`，装的是渲染好的思考模板。
