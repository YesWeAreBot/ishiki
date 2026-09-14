# ishiki cookbook

v1 已确认的设计。实现以这里为准。

| 文 | 内容 |
| --- | --- |
| [01-profile.md](./01-profile.md) | Profile、白名单、session 分发 |
| [02-attention.md](./02-attention.md) | 主心智、focus / awareness、工具选址 |
| [03-context.md](./03-context.md) | 三区、帧重建、连续性 |

**v1 身份：** Koishi 插件。一个 profile = 一个主心智 = 一个 Agent。上下文按三区拼。

**v1 不做：** 线性 append-only、可插拔上下文引擎、athena 式 awareness 附加上下文、渲染结果缓存、state delta、把 profile 暴露到配置页、把 LLM 摘要当作连续性的必要路径。

**仍未定（实现时不要假装已决）：** `ishiki.render.*` 类型怎么收；机械剪枝的具体规则；登录 / 账号状态变更起不起 turn；`change_focus` 携带 B 上下文的参数形状。
