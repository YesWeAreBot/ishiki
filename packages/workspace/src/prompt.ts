import { HOME_MOUNT, ISHIKI_MOUNT, SKILLS_MOUNT, WORKSPACE_MOUNT } from "./mounts.js";
import type { WorkspaceShell } from "./shell.js";

export function workspaceInstructions(sandbox: WorkspaceShell): string {
  return sandbox.backend === "native" ? nativeInstructions(sandbox) : sandboxInstructions(sandbox);
}

function nativeInstructions(sandbox: WorkspaceShell): string {
  return [
    "## 工作区",
    `你在宿主机上直接执行命令：真实 shell（${sandbox.shellPath}），不是隔离环境，宿主机上的文件与命令都可见，改动直接落盘。`,
    `当前工作目录：${sandbox.cwd}`,
    "没有虚拟挂载点：相对路径相对当前工作目录解析，其余写宿主机绝对路径。",
    "网络：可用，走宿主机真实网络。",
    `命令时限：${sandbox.timeoutMs} 毫秒，超时按退出码 124 返回`,
    `执行器输出安全上限 ${sandbox.maxExecutionOutputBytes} 字节；codemode 内拿到原始输出，最终返回模型的预览和归档由运行时统一处理。返回结构化结果，不自行 stringify/slice。`,
    "调用之间不保留 shell 状态：cd、别名、函数与导出变量都不跨调用，切换目录写在同一行（cd <目录> && <命令>）",
    // 平台媒体与长输出不落宿主文件系统，bash 读不到，只能走运行时的资源 URL。
    "平台收到的媒体与工具长输出经运行时 read 工具的 asset:// 与 artifact:// URL 访问，bash 读不到它们",
    "读已知文件也可以走 read 的 workspace:// URL：workspace:///<宿主绝对路径>（Windows 盘符写成 /d/... 风格，如 workspace:///d/work/a.txt），读到的是宿主上的同一份文件",
    "读已知文件用 read_file，整体写入用 write_file，局部修改用 edit_file，列目录、搜索与管道用 bash",
  ].join("\n");
}

function sandboxInstructions(sandbox: WorkspaceShell): string {
  return [
    "## 工作区",
    "你在一个按实例隔离的沙箱里读写文件，它不是宿主机：命令由 JavaScript 解释执行，只有下列挂载点存在，宿主机上的其它路径与命令都不可见。",
    `当前工作目录：${sandbox.cwd}`,
    "挂载点：",
    `- ${HOME_MOUNT}：只读，本实例的数据目录（写入会失败）`,
    `- ${WORKSPACE_MOUNT}：读写，工作目录（改动落盘）`,
    ...(sandbox.resourcesMounted
      ? [`- ${ISHIKI_MOUNT}：只读，资源中心（assets/ 是平台收到的媒体，artifacts/ 是工具媒体与完整长输出；对应 read 工具的 asset:// 与 artifact:// URL）`]
      : []),
    // 技能那几个挂载点在这里合成一行，逐个列出来只是把下面「技能」那一段重复一遍。
    ...sandbox.mounts
      .filter((mount) => !mount.target.startsWith(`${SKILLS_MOUNT}/`))
      .map((mount) => `- ${mount.target}：${mount.readOnly ? "只读（写入会失败）" : "读写（改动落盘）"}`),
    ...(sandbox.skills.length > 0 ? [`- ${SKILLS_MOUNT}：只读，技能目录（见下）`] : []),
    `网络：${sandbox.network ? "可用，私有地址被拒绝" : "不可用"}`,
    `命令时限：${sandbox.timeoutMs} 毫秒，超时按退出码 124 返回`,
    `执行器输出安全上限 ${sandbox.maxExecutionOutputBytes} 字节；codemode 内拿到原始输出，最终返回模型的预览和归档由运行时统一处理。返回结构化结果，不自行 stringify/slice。`,
    "调用之间不保留 shell 状态：cd、别名、函数与导出变量都不跨调用，切换目录写在同一行（cd <目录> && <命令>）",
    // 附加运行时默认关，没配就没有这条命令，说清楚免得模型白试一轮。
    ...(sandbox.javascript ? ["js-exec 可用：在 QuickJS 里执行 JavaScript / TypeScript，可 require / import 一部分 node 模块，只访问得到沙箱内的文件"] : []),
    ...(sandbox.python ? ["python3 与 python 可用：CPython 编译成 WebAssembly，标准库齐全，首次调用要等它装载；读写的就是这个沙箱里的文件"] : []),
    "读已知文件也可以走 read 的 workspace:///<沙箱路径>（如 workspace:///home/workspace/a.txt）：虚拟文件、持久目录与挂载点读到的都是沙箱里的同一份文件",
    "读已知文件用 read_file，整体写入用 write_file，局部修改用 edit_file，列目录、搜索与管道用 bash",
  ].join("\n");
}
