# yakumo-client 踩坑记录

这个包存在的唯一理由是把 Koishi console 的前端构建接进 `yakumo build`。
下面每一条都是它**不得不**这样写的直接原因，删掉任何一条这个包就失去意义。

## 为什么官方插件不够用

`@koishijs/client/lib` 自带一个 yakumo 插件，它注册的是 **service**：

```js
// @koishijs/client/lib/index.js
const inject = ["yakumo"];
function apply(ctx) {
  ctx.register("client", async () => {
    /* ... */
  });
}
```

yakumo 1.x 的 pipeline 能触及 service；3.x 和 4.x 只派发 **CLI 命令**：

```js
// yakumo 4.0.0 lib/index.js
for (const name in config.pipeline || {}) {
  ctx.std.cli.command(`${name} [...args]`, { unknownOption: "allow" }).action(async ({ args, options }) => {
    for (const task of config.pipeline[name]) {
      const output = await ctx.std.cli.execute(new Input.String(task), args, options);
      if (output) console.log(output);
    }
  });
}
```

`ctx.register("client")` 注册的 service 不在命令表里，pipeline 执行到 `client` 时就会失败：

```
$ npx yakumo client
Error: unknown command
```

报错发生在 pipeline 的最后一步，前面的 `tsc` / `esbuild` 输出会正常打印，容易误判成命令本身不存在。

`koishi-boilerplate` 模板的 `pipeline.build: [tsc, esbuild, client]` 能跑，是因为它锁在
`yakumo@1.0.0`。**抄配置前先看版本**，两个版本的 pipeline 语义不同。

所以这里重写成一个 CLI 命令，内部直接调 `@koishijs/client` 导出的 `build()`。构建逻辑不重复，只是换了个入口。

## yakumo 3 到 4 的接口变化

Cordis 4 把标准服务收进 `ctx.std`，CLI 服务名从 `cli` 变成 `std:cli`：

```js
export const inject = ["yakumo", "std:cli"];

function apply(ctx) {
  ctx.std.cli.command("client [...packages]", "Build Koishi console client bundles");
}
```

旧写法 `inject = ["yakumo", "cli"]` 在 v4 不会抛错，插件会一直等待不存在的 `cli` 服务，
保持未激活状态。症状是 `yakumo --help` 里没有 `client`，`yakumo build` 跑到最后一步才报
`unknown command`。

## 装载路径的两个坑

`yakumo.yml` 的 `- name: X` 由 `@cordisjs/loader` 解析，两条分支互不相干：

```js
// @cordisjs/loader 1.0.0-rc.11
import(name, getStack) {
  const baseUrl = this.ctx.get("std:fs")?.baseUrl?.href;
  if (this.ctx.loader.internal) { /* yakumo 自定义分支 */ }
  else if (name.startsWith(".")) {
    return await import(new URL(name, baseUrl).href);  // ← 相对仓库根
  } else {
    const resolve = await createResolve(baseUrl);      // ← 相对 .cordis/
    return await import(resolve(name));
  }
}
```

**坑 1：`./` 分支不做目录索引解析。**
`.` 分支用 `new URL(name, baseUrl)`，得到的是一个**目录 URL**，
而 `import()` 对 file URL 不会补 `index.js`，所以
`- name: "./packages/yakumo-client"` 静默失败。必须写到文件：
`- name: "./packages/yakumo-client/index.js"`。裸名 `yakumo-client` 走另一条分支，不受此影响。

**坑 2：裸名解析依赖仓库根 `node_modules` 里的入口。**
loader 的解析基准是 `.cordis/resolve.mjs`，实际走仓库根的模块解析。根 `package.json` 必须显式声明依赖：

```json
"devDependencies": { "yakumo-client": "workspace:*" }
```

`bun install` 会在 `node_modules/yakumo-client` 建立指向 workspace 的入口，`import.meta.resolve("yakumo-client")` 才能成功。只在 `workspaces` 里列出 `packages/*` 不够：那只决定包如何被发现，不负责建立 loader 需要解析的顶层入口。

两条分支现在都可用（裸名靠 `node_modules` 入口，`./…/index.js` 靠 `baseUrl`），
保持用裸名，与 `yakumo-tsc` / `yakumo-esbuild` 的写法一致。

## 排查手法

loader 把插件加载错误吞进 `ctx.logger.error`，`yakumo --help` 和 `yakumo list` 都看不到。
两个有效的探针：

```bash
# 1. 确认 specifier 能不能解析（注意基准目录差异）
node -e "import('file:///<repo>/.cordis/resolve.mjs').then(m =>
  console.log(m.default('yakumo-client')))"

# 2. 确认模块本身可加载
node -e "import('file:///<repo>/packages/yakumo-client/index.js').then(console.log)"
```

`yakumo --help` 列出的是 CLI 命令，service 不会出现在里面。`client` 不出现只说明没注册成命令，不能推断插件没被加载。

## 调试残留

`.cordis/` 由 loader 自动生成，内含自己的 `.gitignore`（`*`），不需要手动加进根 gitignore。
排查时如果自己写了 `.cordis/rt.mjs` 之类的探针，记得删掉；`git status` 看不到它们。

## 输出目录：lib 与 dist 的分工

这个包不产出任何构建物，但仓库里 `dist` 和 `lib` 的语义是分开的：

| 目录    | 产出者                     | 内容                                            |
| ------- | -------------------------- | ----------------------------------------------- |
| `lib/`  | `tsc` + `esbuild`(dumble)  | Node 侧的 `.d.ts` / `.cjs` / `.js`              |
| `dist/` | `@koishijs/client` 的 vite | console 前端 bundle（`index.js` + `style.css`） |

`dist` 归前端独占，理由是 `packages/koishi-plugin-ishiki/src/console/listeners.ts` 的注册路径直接指向它：

```ts
ctx.console.addEntry(path.join(ctx.baseDir, "node_modules", "koishi-plugin-ishiki", "dist"));
```

`outDir` 写在每个包的 `tsconfig.json` 里（`tsconfig.base.json` 不设默认值）。
dumble 会跟随它决定 esbuild 的输出位置：

```js
outDir = tsconfig.compilerOptions.outDir ?? dirname(outFile);
```

所以改 `tsconfig.json` 的 `outDir` 会同时搬走 tsc 和 esbuild 的产物，
`package.json` 的 `main` / `types` / `exports` / `files` 必须一起改。

只有带 `client/` 目录的包在 `files` 里同时列两者，仓库里目前是 `packages/koishi-plugin-ishiki`。
