# koishi-plugin-ishiki-workspace

给 ishiki 实例一套沙箱：文件读写、精确编辑、技能目录与 bash。沙箱由 [just-bash](https://github.com/vercel-labs/just-bash) 支撑——
命令由 JavaScript 解释执行，文件系统是虚拟挂载表，宿主机上只有显式挂载的目录可见。

## 启用

在某个 profile 的 `extends` 里写包名；工具与提示词只挂到那个 profile 的实例上：

```yaml
# profiles/chat/profile.yaml
model: openai:gpt-5.6-luna
extends:
  workspace:
    config:
      mounts:
        - ../../docs:/docs:ro
```

## 配置

profile 级的 `config`（逐 profile 生效，字段含义由本包解释）：

| 字段              | 缺省              | 说明                                                                        |
| ----------------- | ----------------- | --------------------------------------------------------------------------- |
| `cwd`             | `/home/workspace` | 沙箱内的初始工作目录；应当是某个挂载点覆盖得到的虚拟路径                    |
| `timeoutMs`       | `30000`           | 单条命令的总时限（毫秒），超时按退出码 124 返回                             |
| `maxOutputLength` | `30000`           | bash 的 stdout 与 stderr 各自的上限（字符），超出截断并留一句说明           |
| `network`         | `false`           | 是否允许沙箱内访问网络；开启时仍拒绝私有地址，关闭时 curl / wget 根本不存在 |
| `javascript`      | `false`           | 是否提供 `js-exec` 命令（QuickJS 里执行 JavaScript / TypeScript）           |
| `python`          | `false`           | 是否提供 `python3` / `python` 命令（CPython 编译成 WebAssembly）            |
| `skills`          | `[]`              | 额外技能目录，相对 profile 目录解析                                         |
| `mounts`          | `[]`              | 宿主目录挂载，写法 `source:target[:ro]`                                     |

`mounts` 用 docker 的短语法：`source` 是宿主路径（相对 profile 目录解析），`target` 是沙箱内的绝对路径，
结尾的 `:ro` 表示只读。读写挂载与 docker 一致，`source` 不存在就建出来；只读挂载要求目录已经存在。
目标不能重复、不能互相嵌套，也不能落在保留的 `/home` 之下——那一层由内核自己填。

插件级配置在 Koishi 控制台：

| 字段       | 缺省        | 说明                                     |
| ---------- | ----------- | ---------------------------------------- |
| `logLevel` | `2`（info） | 日志级别：0 静默、1 错误、2 信息、3 调试 |

## 行为

- **隔离粒度 = 实例粒度**：沙箱的 `/home` 是这一实例的数据目录（`<runtime.home>`，`events.jsonl` 在里面），
  **只读**；`/home/workspace` 是它下面的可写工作区，也是默认工作目录。普通形态下每个频道一份，聚合形态下
  整个 profile 的实例共用一份。bash 与 read/write 写的是同一个宿主目录，改动直接落盘，没有「先写内存再
  落盘」这一步。
- **沙箱里始终存在的挂载**：`/home`（数据目录，只读）、`/home/workspace`（工作区，读写）、
  `/home/skills/<名字>`（每个技能一份，只读）。`/home/skills` 本身不是挂载点，只是这些子挂载的父目录，
  往它下面直接写会失败（父目录在只读的数据目录一层）。
- **shell 状态不跨调用**：cd、别名、函数与导出变量都不保留；切换目录要写在同一条命令里
  （`cd <目录> && <命令>`）。文件系统的改动会保留。
- **配置在实例诞生时校验**：挂载目标不合法、只读挂载的 source 不存在这类问题，会让这个实例装配失败并在
  日志里写明原因，不会拖到模型第一次调工具那一轮。

## 工具

| 工具         | 入参                                             | 说明                                                                 |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------------- |
| `bash`       | `{ command }`                                    | 返回 `{ stdout, stderr, exitCode }`；退出码非 0 仍是正常结果         |
| `read_file`  | `{ path }`                                       | 读全文；path 可以是绝对路径或相对 `cwd`                              |
| `write_file` | `{ path, content }`                              | 整体写入，覆盖已有内容，父目录自动创建                               |
| `edit_file`  | `{ path, old_string, new_string, replace_all? }` | 精确替换；`old_string` 出现多次且未开 `replace_all` 时不动文件并报错 |

四个工具都声明了 `outputSchema`，与返回值一一对应——代码模式里生成的程序据此拿到返回值类型。
代码模式（`codemode`）打开时这四个工具默认只进沙箱表；要模型直调就把它们写进 `codemode.direct`。

## 附加运行时

两个运行时都默认关闭：它们各是一份额外的代码执行面，且每次调用都要起一个 wasm 沙箱。开启后它们读写的就是
bash 与那几件工具看到的那份工作区，不是另一份副本。

| 开关         | 命令                | 说明                                                                                                         |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `javascript` | `js-exec`           | QuickJS 里跑 JavaScript / TypeScript，可 `require` / `import` 一部分 node 模块（`fs`、`path`、`process` 等） |
| `python`     | `python3`、`python` | CPython 编译成 WebAssembly，标准库齐全；首次调用要等它装载，之后每次约几百毫秒                               |

```yaml
extends:
  workspace:
    config:
      javascript: true
      python: true
```

这里对可写宿主目录做了一处补位：宿主在 Windows 上不报目录的执行位（Node 报 `0o666`），而 POSIX 语义里
没有 `x` 的目录无法进入——shell 自己不查这一位，但 `python3` 那层的 wasm 文件系统会查，会把整个工作区
判成不可进入。所以可写挂载的 `stat` 会把目录的进入位补上；Linux 上宿主本来就带，等于没改。

## 技能

技能是一个带 `SKILL.md` 的目录，格式与 Claude 的 skills 约定一致：

```markdown
---
name: pdf
description: 提取 PDF 文本
---

正文：做法、注意事项，以及需要时可以调用的脚本。
```

- **来源**：`<dataPath>/skills`（所有 profile 共享）与 profile 的 `config.skills`（相对 profile 目录），
  两者合并，同名以 profile 的那份为准。
- **发现规则**：目录自身含 `SKILL.md` 就是一个技能，否则只看它的直接子目录（技能目录是平铺的）。
- **校验**：`name` 必须等于目录名，且只含小写字母、数字与连字符；`description` 必填。不符的技能被整个丢弃
  并在日志里记一条——名字同时是模型看到的沙箱路径，不能悄悄改名。
- **进模型面**：提示词里只给名字、用途与 `/home/skills/<名字>`，正文留给模型自己读；技能目录只读挂到沙箱的
  `/home/skills/<名字>`，脚本用 bash 执行。

## 不做

- 网络白名单：`network: true` 是全开 + 拒绝私有地址，没有按 URL 授权的粒度。
- 覆盖层挂载（读过真内容、写只留内存）：只有读写与只读两种。
- 沙箱内的 `git` 命令：just-bash 没有内置，得自己实现一套，暂不做。
