# koishi-plugin-ishiki-sticker

为 [Ishiki](https://github.com/YesWeAreBot/ishiki) 提供跨平台的表情包收藏、内容安全审查、VLM 智能打标、本地 FTS5 + 可选向量混合检索、双控发图频率调节，以及 Koishi 控制台可视化图库管理页。

## 核心能力

- **无 C++ 原生编译依赖**：基于 Node >= 22.13 内置 `node:sqlite`（`FTS5 trigram`）与纯 JS `pngjs` 首帧解码 + 内容寻址磁盘存储，开箱即用。
- **可选向量增强**：通过 `host.gateway.embeddingModel` 支持任意本地或云端向量模型（如 Ollama / 硅基流动），与关键词做 RRF 混合精排；未配置或失败时自动降级本地检索。
- **VLM 入库审查与安全防护**：入库前执行体积/长截图比例预筛、GIF 首帧转 PNG 兼容；严格 fail-closed 审查并隔离上下文提示词（`<untrusted_context_hints>`），防止异常输出或提示词注入绕过安全门禁。
- **双控频率调节**：由 LLM 决定发图时机与语境选图，插件提供 `sendChance` 概率窗口、对方发图/斗图豁免 `sendChance`、`sendCooldownSeconds` 频道冷却与 `maxSendPerTurn` 单轮上限，兼顾直调与 `codemode`。
- **多包与跨平台**：按 `profile` 隔离读写包（`readPacks` / `writePack`），OneBot 平台自动附带动画表情属性，其他 Satori 平台发送标准图片元素。
- **控制台 WebUI**：侧边栏「表情图库」支持按包/分类/状态筛选、关键词搜索、批量编辑与拉黑、拖拽上传、受 `importRoots` 白名单保护的服务器目录导入与限流识别队列。

## 插件级配置

在 Koishi 插件配置中可设置全局默认值与安全边界：

- `dataDir`：图库与 `stickers.sqlite` 存放目录（留空默认为 `<ishiki.dataPath>/stickers`）。
- `importRoots`：允许执行目录导入的根目录白名单（留空默认仅允许当前 Koishi 实例 `data/` 目录）。
- `defaultVisionModel` / `defaultEmbeddingModel`：默认视觉审查模型与可选向量模型（`provider:modelId` 或模型组名）。
- `requireApproval`：新收藏表情是否先进入 `pending` 待审核池（默认 `false`，VLM 通过后直接 `active`）。
- `commands`：`enable`（是否注册指令）、`authority`（写指令权限，默认 `3`；`.import` 强制要求 `>= 4`）、`readAuthority`（`.status` / `.search` / `.send` 权限，默认 `2`）、`allowedPacks`（限定指令可见的包）。

> 媒体预览说明：图库缩略图路由 `/ishiki-sticker/<bootToken>/files/:sha256` 仅对单次启动生成的随机高熵前缀开放，并由已认证（`authority >= 1`）控制台 RPC 下发；外网反代部署建议仅暴露标准控制台根路径。

## Profile 扩展配置示例

```yaml
extends:
  sticker:
    enable: true
    config:
      readPacks: [default]
      writePack: default
      visionModel: openai:gpt-4.1-mini
      # embeddingModel: siliconflow:Qwen/Qwen3-Embedding-8B
      sendChance: 0.35
      exemptStickerReply: true
      sendCooldownSeconds: 60
      maxSendPerTurn: 1
      autonomousDailyLimit: 5
      autonomousCooldownMinutes: 60
```

## Koishi 管理指令

- `sticker.status`：查看各包可用/待审数量与识别队列状态。
- `sticker.search [-p pack] <query>`：检索匹配表情。
- `sticker.send [-p pack] <idOrQuery>`：在当前频道发送表情（受包范围与 10 秒冷却限制）。
- `sticker.save [-p pack] [-c character] [-w work] [note]`：管理员手动收藏当前或引用消息中的图片（须先在全局或人形中配置可用视觉模型，或无视觉模型时按备注直存）。
- `sticker.approve <id>` / `sticker.delete <id>` / `sticker.ban <id> [reason]`：审核、删除与拉黑。
- `sticker.import [-p pack] [--tag] <dirPath>`：从 `importRoots` 允许的服务器目录批量导入（权限 `>= 4`）。
