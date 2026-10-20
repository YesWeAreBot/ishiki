# Ishiki 文档站

`docs/` 是 Ishiki 手册的站点，基于 [Fumadocs](https://fumadocs.dev)（Next.js + 静态导出）。

## 本地开发

`docs/` 属于仓库根的 Bun 工作区，没有独立 lock 文件：

```bash
bun install                              # 在仓库根执行，会一并安装 docs 依赖
bun run --filter @ishiki/docs dev         # http://localhost:3000/docs
bun run --filter @ishiki/docs build       # 静态导出到 docs/out
bun run --filter @ishiki/docs types:check # next typegen + tsc --noEmit
```

站点使用根路径部署，本地首页为 `http://localhost:3000/`，手册入口为 `http://localhost:3000/docs/`。

## 结构

| 路径 | 作用 |
| --- | --- |
| `content/docs/` | MDX 正文，分教程 / 指南 / 参考 / 解析 / 维护五个分区 |
| `content/docs/*/meta.json` | 各分区的侧边栏标题、排序与页面清单 |
| `src/lib/source.ts` | 内容源、页面树、`llms.txt` 生成 |
| `src/lib/shared.ts` | 站点名、文档路由与 GitHub 仓库信息 |
| `src/components/mdx.tsx` | MDX 组件注册表 |
| `source.config.ts` | `` ```mermaid `` 与 `` ```files `` 围栏的 remark 插件 |
| `src/layouts/`、`src/components/{ai,docs-sidebar,toc,ui}` | Fumadocs CLI 复制到本地的 Notebook 布局源码（路径别名见 `cli.json`） |
| `cli.json` | Fumadocs CLI 配置：组件安装目录与 UI 库选择 |

组件用法、围栏语法与事实同步约定见站点内的《仓库维护手册》（`content/docs/dev/maintenance.mdx`）。

## 部署

`.github/workflows/pages.yml` 在 `main` 分支的文档或构建依赖变更时构建并发布到 GitHub Pages。正式地址为 `https://ishiki.js.org/`，自定义域名保存在 `public/CNAME`。
