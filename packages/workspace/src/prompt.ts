import { HOME_MOUNT, ISHIKI_MOUNT, SKILLS_MOUNT, WORKSPACE_MOUNT } from "./mounts.js";
import type { WorkspaceSandbox } from "./sandbox.js";

export function workspaceInstructions(sandbox: WorkspaceSandbox): string {
  return [
    "## 工作区",
    "你在一个按实例隔离的沙箱里读写文件，它不是宿主机：命令由 JavaScript 解释执行，只有下列挂载点存在，宿主机上的其它路径与命令都不可见。",
    `当前工作目录：${sandbox.cwd}`,
    "挂载点：",
    `- ${HOME_MOUNT}：只读，本实例的数据目录（写入会失败）`,
    `- ${WORKSPACE_MOUNT}：读写，工作目录（改动落盘）`,
    ...(sandbox.resourcesMounted
      ? [`- ${ISHIKI_MOUNT}：只读，资源中心（assets/ 是收到的媒体与工具产出的图，artifacts/ 是截断落盘的长输出；对应 read 工具的 asset:// 与 artifact:// URL）`]
      : []),
    // 技能那几个挂载点在这里合成一行，逐个列出来只是把下面「技能」那一段重复一遍。
    ...sandbox.mounts
      .filter((mount) => !mount.target.startsWith(`${SKILLS_MOUNT}/`))
      .map((mount) => `- ${mount.target}：${mount.readOnly ? "只读（写入会失败）" : "读写（改动落盘）"}`),
    ...(sandbox.skills.length > 0 ? [`- ${SKILLS_MOUNT}：只读，技能目录（见下）`] : []),
    `网络：${sandbox.network ? "可用，私有地址被拒绝" : "不可用"}`,
    `命令时限：${sandbox.timeoutMs} 毫秒，超时按退出码 124 返回`,
    `bash 的 stdout 与 stderr 各自上限 ${sandbox.maxOutputLength} 字符，超出会被截断；大输出先用 wc、head、grep 收窄再看`,
    "调用之间不保留 shell 状态：cd、别名、函数与导出变量都不跨调用，切换目录写在同一行（cd <目录> && <命令>）",
    // 附加运行时默认关，没配就没有这条命令，说清楚免得模型白试一轮。
    ...(sandbox.javascript ? ["js-exec 可用：在 QuickJS 里执行 JavaScript / TypeScript，可 require / import 一部分 node 模块，只访问得到沙箱内的文件"] : []),
    ...(sandbox.python ? ["python3 与 python 可用：CPython 编译成 WebAssembly，标准库齐全，首次调用要等它装载；读写的就是这个沙箱里的文件"] : []),
    "读已知文件用 read_file，整体写入用 write_file，局部修改用 edit_file，列目录、搜索与管道用 bash",
  ].join("\n");
}
