# 工具结果、附件与资源

工具执行返回业务数据。codemode 内部调用只执行 execute，不执行 toModelOutput，不归档、不截断、不创建附件消息；数据采用 JSON-safe 形式，图片使用 base64。发送、写文件等业务副作用照常发生。

runtime 在最终工具表的唯一出口组合 toModelOutput，先执行工具原生转换，再交 attachment 模块处理。direct 工具和 codemode 最终 return 使用同一路径。工具名、toolCallId 和有序附件列表写入 ishiki.attachment，消息仅含资源描述，不含二进制。保留 execute、schema 和 caller/bind 描述符，每轮装配新的工具表。

新媒体保存为 artifact://<tool>/<name>；平台来源注册为 asset://<id> 并保持懒加载。ResourceStore 提供 registerAsset、writeArtifact、readBytes、getMeta；ResourceCenter 负责 scheme 路由、视图和文本读取，附件识别与模型策略放在 attachment。底层 putInHand 供已有字节和缓存物化使用。MCP 和 workspace 不再维护 sink/spill 或模型输出限额。

归档和整份转换完成后，runtime 调用 agent.send(message, {ifBusy: "join", trigger: false})。core 先提交 assistant/tool 批次，随后 flushJoined 提交附件批次，下一 step 可见。两个批次并非原子事务；失败或中断也可能 flush joined。投影前检查当前保留历史中的成功外层 tool-result，缺少成功对应结果的附件不会加载。附件不绕过 context 裁剪；撤回的平台附件不加载。

standard 保留结构化附件；v3 在重建文本世界状态后保留附件消息。attachment 在请求组装时统一投影为带来源说明的 user/file 消息。重复 URL 在同次请求只加载一次；每次回放重新计算配额。摘要只接触引用和文字，不发送附件二进制。

## 模型与预算

resources.imageInput 默认 false。开启时，gateway models 声明中的 input 必须包含 image，failover 组的全部声明成员均须满足，包括暂时被熔断排除的成员；未知能力拒绝启用视觉 profile。此能力与 tool-result multipart 开关无关。

| 配置                              | 默认值  | 作用                            |
| --------------------------------- | ------- | ------------------------------- |
| resources.maxImageCount           | 4       | 整次请求图片数                  |
| resources.maxImageBytes           | 5 MiB   | 单图原始字节                    |
| resources.maxTotalImageBytes      | 10 MiB  | 整次请求图片总字节              |
| resources.maxImageDimension       | 8000    | 已知尺寸的最大单边              |
| codemode.maxToolInputBytes        | 32 MiB  | 内部工具输入 JSON               |
| codemode.maxToolOutputBytes       | 32 MiB  | 内部工具输出 JSON               |
| codemode.maxResultBytes           | 32 MiB  | 外层结果 JSON，归档前的沙箱边界 |
| codemode.memoryLimitBytes         | 256 MiB | QuickJS 内存                    |
| workspace.maxExecutionOutputBytes | 32 MiB  | 执行器输出安全限制              |

执行预算与模型可见预算分开。base64 膨胀计入 codemode JSON 预算。归档不受图片投影配额或模型模态影响。超限、未知能力、资源读取失败和不支持的格式只显示说明及引用，不自动缩放、裁剪或 OCR。初版投影支持 PNG/JPEG/GIF/WebP，其他媒体仍保留原字节供工具或发送使用。

## read 和完整输出

read.outputSchema 描述 JSON-safe 的 ishiki.read 文本页或文件结果；文件含来源 URL、mediaType、base64 data、byteLength 和可选 filename。原生 toModelOutput 将其转换为标准工具内容，统一出口核对来源字节哈希和媒体类型。未变更的图片复用源 URL，变更后写入新 artifact。

read 与普通文本预览共用每页 2000 行、30000 UTF-16 字符的内容预算；截断说明和来源信息额外显示。页内文本保留原换行，可直接拼接还原。大于 1 MiB 的 artifact/local 文本在磁盘读取层分页，不先被 handler 拒绝。

- read({url: "artifact://tool/name:1-200"})：行范围，从 1 开始。
- read({url: "artifact://tool/name:50+30"})：第 50 行起共 30 行。
- read({url: "artifact://tool/name#offset=30000"})：从稳定可读视图的 UTF-16 字符位置继续，包含换行。
- 行范围内的长单行使用返回的 #offset=N&end=L 锚点继续，保持原范围终点。
- ?view=meta：元数据，不下载平台资源。
- artifact ?view=original：原始 JSON/text，仍按文本分页；其中的 base64 是原始文本，不再次猜图。

超长纯文本保存原文。超长 JSON 保存完整 JSON，并在同一 artifact 下保存必要的稳定可读视图；视图中的媒体已替换为引用，行号和 offset 始终对应该视图。沙箱 /home/.ishiki/artifacts/<tool>/<name> 及 store.readBytes 返回原始字节。read 文本页不再次归档，避免资源链。旧 :raw 已移除。

短结果保留原生转换语义与 SDK 默认 JSON 类型，例如 send_message 的 {ok, ids}。只识别明确的 content/file、MCP text/image/audio/resource、带标签嵌套媒体和 ReadResult；普通 data 字段与序列化字符串不猜图。模型必须返回完整结构化结果；已自行 stringify/slice 的图片无法恢复。

## 验证边界

仓库 smoke 使用真实 Agent、code-mode、gateway provider 转换器与 mock fetch，捕获下一步请求体，并检查 events.jsonl 中 assistant/tool/附件顺序。MCP 使用本地 HTTP 测试服务检查原始 block 保留。发送测试捕获适配器收到的实际资源 payload。这些验证不代表真实远端 API 接受图片，也不代表平台客户端渲染成功。
