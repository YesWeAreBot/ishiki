# koishi-plugin-ishiki-mcp-client

把 MCP 服务器的工具接入 ishiki 视窗。服务器不在 Koishi 控制台配，写在文件里。

## 启用

在某个 profile 的 `extends` 里写包名：

```yaml
# profiles/chat/profile.yaml
model: openai:gpt-5.6-luna
extends:
  mcp-client:
```

工具与提示词从这个 profile 认领的全部频道生效。

## 配置

两份文件，`<dataPath>` 是内核的 `dataPath`（默认 `data/ishiki`）：

- `<dataPath>/.mcp.json` —— 基线
- `<dataPath>/profiles/<目录名>/mcp.json` —— **完全替换**基线，不是叠加。目录名就是 profile 的 id

字段语义、判定时机（静态/动态）与坏配置的处理见 [`resources/README.md`](./resources/README.md)。
形状由 [`resources/mcp.schema.json`](./resources/mcp.schema.json) 定义，可填写样例见
[`resources/mcp.example.json`](./resources/mcp.example.json)。

插件级配置在 Koishi 控制台：

| 字段       | 缺省        | 说明                                     |
| ---------- | ----------- | ---------------------------------------- |
| `logLevel` | `2`（info） | 日志级别：0 静默、1 错误、2 信息、3 调试 |

装载、配置来源与每个 server 的连接结果按信息级（`2`）打：是否装载、用的哪份配置、
解析出几个 server、连上几个。工具目录重列与单次工具调用只在调试级（`3`）下打。

## 行为

- **作用域**：连接按 profile 建立，同 profile 的所有频道实例共享一组 stdio 子进程。
- **建立时机**：每个 profile 第一次挂载时建池（同 profile 的频道实例共享一份），池一建好就并发握手——
  多个 server 同时连，总时长不叠加。两个钩子会等握手收尾再交工具面与提示词，所以模型第一次开口时
  就看到完整目录；某个 server 握手失败只记一条 error 并跳过它，不重试，也不拖住其余 server。
- **目录变更**：server 报 `notifications/tools/list_changed` 时就地重建该 server 的工具，
  下一轮生效，不需要重新装配。
- **工具命名**：`<服务器名>-<工具名>`。非 `[A-Za-z0-9_-]` 的字符折成 `_`，清洗后撞名加数字后缀。
- **图片**：直接交字节（`ai` SDK 的 `content` 文件部件），不落盘、不转文字；出口处有张数与字节限额。
