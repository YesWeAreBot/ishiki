# ishiki

`koishi-plugin-ishiki`：数字生命的运行时内核，以 Koishi 插件形态实现，是 `athena-harness` 的想法验证之一。

概念与设计取舍见 `packages/koishi-plugin-ishiki/docs/cookbook/`，动手改机制前先读 `00-principles.md`。安装与运行见 `packages/koishi-plugin-ishiki/README.md`。

## 命令

- `bun run test` —— 测试
- `bun run build` —— 类型检查与构建
- `bun run lint` / `bun run format:check` —— oxlint / oxfmt
- `bunx tsc --noEmit -p tsconfig.json` —— 全仓类型门禁（含 tests；包内 tsconfig 只含 src）

## 编码约定

- 目录按族组织：`src/<族>/engine.ts`（抽象基类 + 参数表 + 注册表）、`<名字>.engine.ts`（变体，文件末尾自注册）、`index.ts`（import 使注册生效）。
- 注册表重名抛错；按名创建未登记时抛错，不静默退化。
- 同一形状的类型只声明一处：`interface X` 与 `const X: Schema<X>` 成对。
- 注释写为什么、约束与取舍，并写明刻意偏离来源实现的地方；不写「做了什么」。
- 工具与提示词文案用工程化表述：只写规则，一条一行，不要口语与物理化比喻。
- 删除优于保留：被取代的路径、兼容层、死字段一律清掉，不留 TODO 与占位文件。
- 禁止使用 `xxOf`，`xxFor`，`assemble`，`Assembly`。

## 变更边界

- 只改用户点名的对象；引擎外或点名外的改动先列为风险点/待确认项，不自行决定。
- 不主动 commit、push、创建 PR 或发布。
